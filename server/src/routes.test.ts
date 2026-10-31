import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAgent, openDb, saveAgent, saveRecipient } from "./db.js";
import type { Db } from "./db.js";
import { createPaymentService } from "./payments.js";
import type { PayPalClient } from "./paypal.js";
import type { Policy } from "./policy/types.js";
import { approvalRoutes, dashboardRoutes, errorHandler } from "./routes.js";

const policy: Policy = {
  perTransactionCapCents: 50_00,
  autoApproveLimitCents: 25_00,
  recipientWindowLimitCents: 50_00,
  dailyBudgetCents: 100_00,
  totalBudgetCents: 500_00,
  allowedRecipients: null,
  blockedRecipients: [],
  requireVerifiedRecipient: false,
  allowedCategories: null,
  blockedCategories: [],
  maxPaymentsPerHour: 20,
  allowedCurrencies: ["USD"],
};

const paypal: PayPalClient = {
  createPayout: async () => "BATCH",
  getPayoutItem: async () => ({ status: "SUCCESS", transactionId: "TX", itemId: "ITEM", error: null }),
  cancelPayoutItem: async () => {},
  getCapture: async () => ({ value: "10.00", currency: "USD" }),
  refundCapture: async ({ value }) => ({ id: "R", status: "COMPLETED", value }),
  sendInvoice: async () => "INV",
};

describe("dashboard password", () => {
  let db: Db;
  let server: Server;
  let base: string;
  let heldId: string;

  async function start(password: string) {
    db = openDb(":memory:");
    saveAgent(db, { id: "a1", name: "Agent", policy }, "key-1");
    saveRecipient(db, "vendor@example.com", "Vendor", { verified: true, category: "software" });
    const payments = createPaymentService(db, paypal, { pollMs: 1 });
    const held = await payments.pay(getAgent(db, "a1")!, {
      recipient: "vendor@example.com",
      amount: "30.00",
      currency: "USD",
      category: "software",
    });
    heldId = held.payment_id as string;

    const demo = {
      status: () => ({ available: true, running: false, report: null, error: null }),
      start: () => true,
      reset: () => true,
    };
    const auth = { password, hint: "" };
    const app = express();
    app.use(express.json());
    app.use(dashboardRoutes(db, payments, null, demo, auth));
    app.use(approvalRoutes(payments, auth));
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  }

  const post = (path: string, password?: string, method = "POST", body: unknown = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(password ? { "X-Leash-Password": password } : {}) },
      body: JSON.stringify(body),
    });

  const protectedCalls = (): [string, string, unknown][] => [
    [`/api/approvals/${heldId}/approve`, "POST", {}],
    [`/api/approvals/${heldId}/reject`, "POST", {}],
    ["/api/agents/a1/policy", "PUT", policy],
    ["/api/agents/a1/policy/draft", "POST", { text: "rules" }],
    ["/api/demo/run", "POST", {}],
    ["/api/demo/reset", "POST", {}],
  ];

  afterEach(() => new Promise((resolve) => server.close(resolve)));

  describe("when set", () => {
    beforeEach(() => start("correct-horse"));

    it("refuses every action without it", async () => {
      for (const [path, method, body] of protectedCalls()) {
        const res = await post(path, undefined, method, body);
        expect(res.status, path).toBe(401);
        expect(await res.json(), path).toMatchObject({ passwordRequired: true });
      }
    });

    it("refuses every action with the wrong password", async () => {
      for (const [path, method, body] of protectedCalls()) {
        expect((await post(path, "wrong", method, body)).status, path).toBe(401);
      }
    });

    it("leaves the payment waiting after a refused approval", async () => {
      await post(`/api/approvals/${heldId}/approve`);
      const state: any = await (await fetch(`${base}/api/state`)).json();
      expect(state.approvals).toHaveLength(1);
    });

    it("approves with the right password", async () => {
      expect((await post(`/api/approvals/${heldId}/approve`, "correct-horse")).status).toBe(200);
    });

    it("keeps reading open and says a password is required", async () => {
      const state: any = await (await fetch(`${base}/api/state`)).json();
      expect(state.auth).toEqual({ required: true, hint: "" });
    });

    it("does not reveal the password", async () => {
      expect(await (await fetch(`${base}/api/state`)).text()).not.toContain("correct-horse");
    });
  });

  describe("bad requests", () => {
    beforeEach(() => start(""));

    it("answers malformed JSON without a stack trace", async () => {
      const res = await fetch(`${base}/api/demo/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" });
      expect(res.status).toBe(400);
      expect(await res.text()).not.toMatch(/node_modules|\n\s+at /);
    });

    it("answers an oversized body without a stack trace", async () => {
      const res = await post("/api/demo/run", undefined, "POST", { text: "x".repeat(300_000) });
      expect(res.status).toBe(413);
      expect(await res.text()).not.toMatch(/node_modules|\n\s+at /);
    });
  });

  describe("when not set", () => {
    beforeEach(() => start(""));

    it("stays open for local use", async () => {
      expect((await post(`/api/approvals/${heldId}/approve`)).status).toBe(200);
      const state: any = await (await fetch(`${base}/api/state`)).json();
      expect(state.auth.required).toBe(false);
    });
  });
});
