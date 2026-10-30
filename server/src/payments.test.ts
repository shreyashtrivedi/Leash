import { beforeEach, describe, expect, it } from "vitest";
import type { Agent, Db } from "./db.js";
import { getAgent, openDb, saveAgent, saveRecipient } from "./db.js";
import { createPaymentService } from "./payments.js";
import type { PaymentService } from "./payments.js";
import { PayPalError } from "./paypal.js";
import type { PayoutInput, PayPalClient, PayoutItem } from "./paypal.js";
import type { Policy } from "./policy/types.js";

const VENDOR = "vendor@example.com";

const policy: Policy = {
  perTransactionCapCents: 50_00,
  autoApproveLimitCents: 25_00,
  dailyBudgetCents: 50_00,
  totalBudgetCents: 500_00,
  allowedRecipients: null,
  blockedRecipients: [],
  requireVerifiedRecipient: true,
  allowedCategories: null,
  blockedCategories: ["gambling"],
  maxPaymentsPerHour: 20,
  allowedCurrencies: ["USD"],
};

const pay = (amount: string, extra: object = {}) => ({
  recipient: VENDOR,
  amount,
  currency: "USD",
  category: "software",
  ...extra,
});

function fakePayPal(overrides: Partial<PayPalClient> = {}) {
  const payouts: PayoutInput[] = [];
  const client: PayPalClient = {
    async createPayout(input) {
      payouts.push(input);
      return `batch-${payouts.length}`;
    },
    async getPayoutItem(): Promise<PayoutItem> {
      return { status: "SUCCESS", transactionId: "TX123", itemId: "ITEM1", error: null };
    },
    ...overrides,
  };
  return { client, payouts };
}

describe("payment service", () => {
  let db: Db;
  let agent: Agent;
  const service = (client: PayPalClient, pollTimeoutMs = 50): PaymentService =>
    createPaymentService(db, client, { pollMs: 1, pollTimeoutMs });

  beforeEach(() => {
    db = openDb(":memory:");
    saveAgent(db, { id: "a1", name: "Agent", policy }, "key-1");
    saveAgent(db, { id: "a2", name: "Other", policy }, "key-2");
    saveRecipient(db, VENDOR, "Vendor", { verified: true, category: "software" });
    agent = getAgent(db, "a1")!;
  });

  const waitForPayouts = async (payouts: PayoutInput[], count: number) => {
    for (let i = 0; i < 100 && payouts.length < count; i++) await new Promise((r) => setTimeout(r, 1));
  };

  it("executes an in-policy payment with a real transaction id", async () => {
    const { client, payouts } = fakePayPal();
    const result = await service(client).pay(agent, pay("10.00"));
    expect(result).toMatchObject({ status: "executed", paypal_transaction_id: "TX123" });
    expect(payouts[0]).toMatchObject({ recipient: VENDOR, value: "10.00", currency: "USD" });
    expect(payouts[0]?.senderBatchId).toBe(`leash-${result.payment_id}`);
  });

  it("blocks without calling PayPal and explains why", async () => {
    const { client, payouts } = fakePayPal();
    const result = await service(client).pay(agent, pay("120.00"));
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("amount $120.00 exceeds per-transaction cap $50.00");
    expect(result.reason).not.toContain("auto-approve");
    expect(payouts).toHaveLength(0);
  });

  it("holds above the auto-approve limit without calling PayPal", async () => {
    const { client, payouts } = fakePayPal();
    const result = await service(client).pay(agent, pay("30.00"));
    expect(result).toMatchObject({ status: "pending_approval", approval_id: result.payment_id });
    expect(payouts).toHaveLength(0);
  });

  it("does not trust an agent's label over Leash's recipient record", async () => {
    saveRecipient(db, "casino@example.com", "Casino", { verified: true, category: "gambling" });
    const { client } = fakePayPal();
    const result = await service(client).pay(agent, pay("10.00", { recipient: "casino@example.com" }));
    expect(result.status).toBe("blocked");
  });

  it("sends a held payment once approved", async () => {
    const { client, payouts } = fakePayPal();
    const payments = service(client);
    const held = await payments.pay(agent, pay("30.00"));
    expect(payments.resolveApproval(held.payment_id, true)?.status).toBe("processing");
    await waitForPayouts(payouts, 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await payments.check(agent, held.payment_id)).toMatchObject({ status: "executed" });
  });

  it("does not send a rejected payment", async () => {
    const { client, payouts } = fakePayPal();
    const payments = service(client);
    const held = await payments.pay(agent, pay("30.00"));
    expect(payments.resolveApproval(held.payment_id, false)?.status).toBe("rejected");
    expect(await payments.check(agent, held.payment_id)).toMatchObject({ status: "rejected" });
    expect(payouts).toHaveLength(0);
  });

  it("pays once when approve is clicked twice", async () => {
    const { client, payouts } = fakePayPal();
    const payments = service(client);
    const held = await payments.pay(agent, pay("30.00"));
    expect(payments.resolveApproval(held.payment_id, true)).not.toBeNull();
    expect(payments.resolveApproval(held.payment_id, true)).toBeNull();
    expect(payments.resolveApproval(held.payment_id, false)).toBeNull();
    await waitForPayouts(payouts, 2);
    expect(payouts).toHaveLength(1);
  });

  it("blocks an approval when the budget ran out while it waited", async () => {
    const { client, payouts } = fakePayPal();
    const payments = service(client);
    const held = await payments.pay(agent, pay("30.00"));
    await payments.pay(agent, pay("25.00"));
    expect(payments.resolveApproval(held.payment_id, true)?.status).toBe("blocked");
    expect(payouts).toHaveLength(1);
  });

  it("lets parallel payments share a budget without overspending", async () => {
    const { client, payouts } = fakePayPal();
    const payments = service(client);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => payments.pay(agent, pay("20.00"))));
    expect(results.filter((r) => r.status === "executed")).toHaveLength(2);
    expect(results.filter((r) => r.status === "blocked")).toHaveLength(3);
    expect(payouts).toHaveLength(2);
  });

  it("does not pay twice for a retried idempotency key", async () => {
    const { client, payouts } = fakePayPal();
    const payments = service(client);
    const first = await payments.pay(agent, pay("10.00", { idempotencyKey: "k1" }));
    const second = await payments.pay(agent, pay("10.00", { idempotencyKey: "k1" }));
    expect(second.payment_id).toBe(first.payment_id);
    expect(payouts).toHaveLength(1);
  });

  it("keeps idempotency keys separate per agent", async () => {
    const { client, payouts } = fakePayPal();
    const payments = service(client);
    await payments.pay(agent, pay("10.00", { idempotencyKey: "k1" }));
    await payments.pay(getAgent(db, "a2")!, pay("10.00", { idempotencyKey: "k1" }));
    expect(payouts).toHaveLength(2);
  });

  it("releases the budget when PayPal refuses", async () => {
    const refusing = fakePayPal({
      createPayout: async () => {
        throw new PayPalError(403, "PAYOUT_NOT_AVAILABLE", "Not allowed");
      },
    });
    const payments = service(refusing.client);
    const result = await payments.pay(agent, pay("25.00"));
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("PAYOUT_NOT_AVAILABLE");

    const working = service(fakePayPal().client);
    expect((await working.pay(agent, pay("25.00"))).status).toBe("executed");
    expect((await working.pay(agent, pay("25.00"))).status).toBe("executed");
  });

  it("keeps the budget reserved when the payout outcome is unknown", async () => {
    const { client } = fakePayPal({
      createPayout: async () => {
        throw new PayPalError(500, "INTERNAL_SERVICE_ERROR", "Oops");
      },
    });
    const payments = service(client);
    expect((await payments.pay(agent, pay("25.00"))).status).toBe("processing");
    expect((await payments.pay(agent, pay("25.00"))).status).toBe("processing");
    expect((await payments.pay(agent, pay("1.00"))).status).toBe("blocked");
  });

  it("does not treat a duplicate rejection after a lost response as a failure", async () => {
    let attempts = 0;
    const { client } = fakePayPal({
      createPayout: async () => {
        attempts++;
        throw attempts === 1
          ? new TypeError("network lost")
          : new PayPalError(400, "DUPLICATE", "Batch already exists");
      },
    });
    expect((await service(client).pay(agent, pay("10.00"))).status).toBe("processing");
    expect(attempts).toBe(2);
  });

  it("reports processing, then the final result on check", async () => {
    let status = "PENDING";
    const { client } = fakePayPal({
      getPayoutItem: async () => ({ status, transactionId: "TX9", itemId: "I9", error: null }),
    });
    const payments = service(client, 5);
    const result = await payments.pay(agent, pay("10.00"));
    expect(result.status).toBe("processing");
    status = "SUCCESS";
    expect(await payments.check(agent, result.payment_id)).toMatchObject({ status: "executed", paypal_transaction_id: "TX9" });
  });

  it("marks a payout PayPal fails later as failed and releases the budget", async () => {
    const { client } = fakePayPal({
      getPayoutItem: async () => ({ status: "FAILED", transactionId: null, itemId: "I1", error: "Receiver blocked" }),
    });
    const payments = service(client);
    expect((await payments.pay(agent, pay("25.00"))).status).toBe("failed");
    expect((await payments.pay(agent, pay("25.00"))).status).toBe("failed");
    expect((await payments.pay(agent, pay("25.00"))).status).toBe("failed");
  });

  it("treats an unclaimed payout as sent and says so", async () => {
    const { client } = fakePayPal({
      getPayoutItem: async () => ({ status: "UNCLAIMED", transactionId: "TX2", itemId: "I2", error: "unregistered" }),
    });
    const result = await service(client).pay(agent, pay("10.00"));
    expect(result).toMatchObject({ status: "executed", paypal_status: "UNCLAIMED" });
    expect(result.reason).toContain("claimed");
  });

  it("records a payment once when polling and check see the result together", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { client } = fakePayPal({
      getPayoutItem: async () => {
        await gate;
        return { status: "SUCCESS", transactionId: "TX1", itemId: "I1", error: null };
      },
    });
    const payments = service(client, 1000);
    const paying = payments.pay(agent, pay("10.00"));
    await new Promise((r) => setTimeout(r, 10));
    const id = db.prepare("SELECT id FROM payments").pluck().get() as string;
    const checking = payments.check(agent, id);
    release();
    await Promise.all([paying, checking]);
    const count = db.prepare("SELECT COUNT(*) FROM audit_events WHERE type = 'payment.executed'").pluck().get();
    expect(count).toBe(1);
  });

  it("hides one agent's payments from another", async () => {
    const payments = service(fakePayPal().client);
    const result = await payments.pay(agent, pay("10.00"));
    expect(await payments.check(getAgent(db, "a2")!, result.payment_id)).toBeNull();
  });

  it("writes an audit event for every decision and outcome", async () => {
    const payments = service(fakePayPal().client);
    await payments.pay(agent, pay("10.00"));
    await payments.pay(agent, pay("120.00"));
    const held = await payments.pay(agent, pay("30.00"));
    payments.resolveApproval(held.payment_id, false);
    const types = db.prepare("SELECT type FROM audit_events ORDER BY id").pluck().all();
    expect(types).toEqual([
      "decision.allow",
      "payment.executed",
      "decision.deny",
      "decision.require_approval",
      "approval.rejected",
    ]);
  });
});
