import { randomUUID } from "node:crypto";
import type { Agent, Db, PaymentRow } from "./db.js";
import { addAuditEvent, getAgent, getRecipient, parseRuleResults } from "./db.js";
import { PayPalError } from "./paypal.js";
import type { PayPalClient } from "./paypal.js";
import { evaluate } from "./policy/engine.js";
import { parseMinorUnits } from "./policy/money.js";
import type { Evaluation, PaymentRequest, SpendContext } from "./policy/types.js";

export interface PayInput extends PaymentRequest {
  memo?: string;
  idempotencyKey?: string;
}

export type PaymentResult = Record<string, unknown> & { status: string; payment_id: string };

const MAX_CREATE_ATTEMPTS = 3;
const SUCCEEDED = new Set(["SUCCESS", "UNCLAIMED"]);
const FAILED = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function failedRules(row: PaymentRow) {
  return parseRuleResults(row)
    .filter((result) => !result.passed)
    .map(({ rule, reason }) => ({ rule, reason }));
}

// What an agent sees. Every outcome says why, so the agent can adapt.
export function toResult(row: PaymentRow): PaymentResult {
  const base = {
    payment_id: row.id,
    recipient: row.recipient,
    amount: row.amount,
    currency: row.currency,
  };
  const failures = failedRules(row);

  switch (row.status) {
    case "blocked": {
      // Approval can't help a blocked payment, so the auto-approve limit would only mislead.
      const blockers = failures.filter((failure) => failure.rule !== "auto_approve_limit");
      return {
        ...base,
        status: "blocked",
        reason: `blocked: ${blockers.map((failure) => failure.reason).join("; ")}`,
        failed_rules: blockers,
      };
    }
    case "pending_approval":
      return {
        ...base,
        status: "pending_approval",
        approval_id: row.id,
        reason: `held for human approval: ${failures.map((failure) => failure.reason).join("; ")}`,
        next_step: "Call check_approval with this approval_id to see the human's decision.",
      };
    case "rejected":
      return { ...base, status: "rejected", reason: "A human rejected this payment. Do not retry it." };
    case "sending":
      return {
        ...base,
        status: "processing",
        reason: "PayPal has not finished this payment yet.",
        next_step: "Call check_approval with this payment_id to get the final result. Do not send it again.",
      };
    case "executed":
      return {
        ...base,
        status: "executed",
        paypal_transaction_id: row.transaction_id,
        paypal_status: row.paypal_status,
        reason:
          row.paypal_status === "UNCLAIMED"
            ? "Payment sent. The recipient has no PayPal account yet, so it is waiting to be claimed."
            : "Payment sent.",
      };
    case "failed":
      return { ...base, status: "failed", reason: `PayPal could not complete this payment: ${row.error}` };
  }
}

export function createPaymentService(
  db: Db,
  paypal: PayPalClient,
  options: { pollMs?: number; pollTimeoutMs?: number } = {},
) {
  const pollMs = options.pollMs ?? 1000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 45_000;

  const getRow = (id: string) =>
    db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow | undefined;

  const setFields = (id: string, fields: Partial<PaymentRow>) => {
    const columns = Object.keys(fields).map((key) => `${key} = @${key}`).join(", ");
    db.prepare(`UPDATE payments SET ${columns} WHERE id = @id`).run({ ...fields, id });
  };

  const audit = (row: PaymentRow, type: string, summary: string) =>
    addAuditEvent(db, { agentId: row.agent_id, paymentId: row.id, type, summary });

  // Reserved and completed payments both count, so parallel calls can't share a budget.
  function spendContext(agentId: string, recipient: string, approvedByHuman: boolean): SpendContext {
    const now = new Date();
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    const spent = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN reserved_at >= @dayStart THEN amount_usd_cents END), 0) AS today,
           COALESCE(SUM(amount_usd_cents), 0) AS total,
           COUNT(CASE WHEN reserved_at >= @hourAgo THEN 1 END) AS lastHour
         FROM payments
         WHERE agent_id = @agentId AND status IN ('sending', 'executed')`,
      )
      .get({ agentId, dayStart, hourAgo }) as { today: number; total: number; lastHour: number };

    return {
      spentTodayCents: spent.today,
      spentTotalCents: spent.total,
      paymentsLastHour: spent.lastHour,
      recipientRecord: getRecipient(db, recipient),
      approvedByHuman,
    };
  }

  // Evaluation and reservation share one transaction, so the check can't go stale.
  const recordPayment = db
    .transaction((agent: Agent, input: PayInput): { row: PaymentRow; isNew: boolean } => {
      if (input.idempotencyKey) {
        const existing = db
          .prepare("SELECT * FROM payments WHERE agent_id = ? AND idempotency_key = ?")
          .get(agent.id, input.idempotencyKey) as PaymentRow | undefined;
        if (existing) return { row: existing, isNew: false };
      }

      const recipient = input.recipient.trim().toLowerCase();
      const evaluation = evaluate(agent.policy, input, spendContext(agent.id, recipient, false));
      const status = { ALLOW: "sending", REQUIRE_APPROVAL: "pending_approval", DENY: "blocked" }[evaluation.decision];
      const now = new Date().toISOString();
      const id = randomUUID();

      db.prepare(
        `INSERT INTO payments (id, agent_id, recipient, amount, currency, amount_usd_cents, category, memo,
           status, rule_results, idempotency_key, created_at, reserved_at)
         VALUES (@id, @agentId, @recipient, @amount, @currency, @amountUsdCents, @category, @memo,
           @status, @ruleResults, @idempotencyKey, @createdAt, @reservedAt)`,
      ).run({
        id,
        agentId: agent.id,
        recipient,
        amount: String(input.amount),
        currency: input.currency.trim().toUpperCase(),
        amountUsdCents: evaluation.amountUsdCents,
        category: input.category,
        memo: input.memo ?? "",
        status,
        ruleResults: JSON.stringify(evaluation.results),
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now,
        reservedAt: status === "sending" ? now : null,
      });

      const row = getRow(id)!;
      auditDecision(row, evaluation);
      return { row, isNew: true };
    })
    .immediate;

  function auditDecision(row: PaymentRow, evaluation: Evaluation) {
    const failures = evaluation.results.filter((result) => !result.passed).map((result) => result.reason);
    audit(
      row,
      `decision.${evaluation.decision.toLowerCase()}`,
      `${row.amount} ${row.currency} to ${row.recipient}${failures.length ? `: ${failures.join("; ")}` : ""}`,
    );
  }

  function applyItem(id: string, item: { status: string; transactionId: string | null; itemId: string | null; error: string | null }) {
    // Polling and check_approval can both see the same result. Only the first applies it.
    const row = getRow(id)!;
    if (row.status !== "sending") return;
    if (SUCCEEDED.has(item.status)) {
      setFields(id, {
        status: "executed",
        transaction_id: item.transactionId,
        payout_item_id: item.itemId,
        paypal_status: item.status,
      });
      audit(row, "payment.executed", `Sent ${row.amount} ${row.currency} to ${row.recipient}, PayPal transaction ${item.transactionId}`);
    } else if (FAILED.has(item.status)) {
      markFailed(row, item.error ?? `PayPal status ${item.status}`, item.status);
    }
  }

  function markFailed(row: PaymentRow, error: string, paypalStatus: string | null = null) {
    setFields(row.id, { status: "failed", error, paypal_status: paypalStatus });
    audit(row, "payment.failed", `PayPal could not send ${row.amount} ${row.currency} to ${row.recipient}: ${error}`);
  }

  async function refresh(id: string) {
    const row = getRow(id);
    if (row?.status !== "sending" || !row.payout_batch_id) return;
    const item = await paypal.getPayoutItem(row.payout_batch_id);
    if (item) applyItem(id, item);
  }

  // A 4xx on the first attempt means PayPal refused, so the reservation is released.
  // After a 5xx or network error the outcome is unknown: the money may have moved,
  // so the payment stays "sending" and keeps its budget rather than risk overspending.
  async function createPayout(row: PaymentRow): Promise<string | null> {
    const value = (parseMinorUnits(row.amount)! / 100).toFixed(2);
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      try {
        return await paypal.createPayout({
          senderBatchId: `leash-${row.id}`,
          recipient: row.recipient,
          value,
          currency: row.currency,
          note: row.memo || "Payment from a Leash agent",
        });
      } catch (err) {
        const refused = err instanceof PayPalError && err.status < 500;
        if (refused && attempt === 0) {
          markFailed(row, `${err.name}: ${err.message}`);
          return null;
        }
        if (refused) break;
      }
    }
    setFields(row.id, { error: "PayPal did not confirm this payout. Check the sandbox before retrying." });
    audit(row, "payment.unconfirmed", `PayPal did not confirm the payout to ${row.recipient}`);
    return null;
  }

  async function execute(id: string) {
    const row = getRow(id)!;
    audit(row, "payment.sending", `Sending ${row.amount} ${row.currency} to ${row.recipient} through PayPal`);
    const batchId = await createPayout(row);
    if (!batchId) return;
    setFields(id, { payout_batch_id: batchId });

    const deadline = Date.now() + pollTimeoutMs;
    while (getRow(id)?.status === "sending" && Date.now() < deadline) {
      await sleep(pollMs);
      await refresh(id).catch(() => undefined);
    }
  }

  // Approval re-runs the whole policy, because budgets or the policy may have changed.
  const resolveInTransaction = db
    .transaction((id: string, approved: boolean): { row: PaymentRow; send: boolean } | null => {
      const row = getRow(id);
      if (row?.status !== "pending_approval") return null;

      if (!approved) {
        setFields(id, { status: "rejected" });
        audit(row, "approval.rejected", `A human rejected ${row.amount} ${row.currency} to ${row.recipient}`);
        return { row: getRow(id)!, send: false };
      }

      const agent = getAgent(db, row.agent_id)!;
      const request = { recipient: row.recipient, amount: row.amount, currency: row.currency, category: row.category };
      const evaluation = evaluate(agent.policy, request, spendContext(row.agent_id, row.recipient, true));
      const allowed = evaluation.decision === "ALLOW";

      setFields(id, {
        status: allowed ? "sending" : "blocked",
        rule_results: JSON.stringify(evaluation.results),
        reserved_at: allowed ? new Date().toISOString() : null,
      });
      audit(row, "approval.approved", `A human approved ${row.amount} ${row.currency} to ${row.recipient}`);
      auditDecision(getRow(id)!, evaluation);
      return { row: getRow(id)!, send: allowed };
    })
    .immediate;

  return {
    async pay(agent: Agent, input: PayInput): Promise<PaymentResult> {
      const { row, isNew } = recordPayment(agent, input);
      if (isNew && row.status === "sending") await execute(row.id);
      return toResult(getRow(row.id)!);
    },

    // Works for approvals and payments. An agent can only see its own.
    async check(agent: Agent, id: string): Promise<PaymentResult | null> {
      const row = getRow(id);
      if (row?.agent_id !== agent.id) return null;
      await refresh(id).catch(() => undefined);
      return toResult(getRow(id)!);
    },

    // Returns null when the payment is not waiting for a decision, so a second click does nothing.
    resolveApproval(id: string, approved: boolean): PaymentResult | null {
      const resolved = resolveInTransaction(id, approved);
      if (!resolved) return null;
      if (resolved.send) {
        void execute(id).catch((err) => markFailed(getRow(id)!, String(err)));
      }
      return toResult(resolved.row);
    },

    listPendingApprovals() {
      const rows = db
        .prepare("SELECT * FROM payments WHERE status = 'pending_approval' ORDER BY created_at")
        .all() as PaymentRow[];
      return rows.map((row) => ({ ...row, rule_results: parseRuleResults(row) }));
    },

    // Real spend only: sample history lives in the audit log and never touches budgets.
    spendSummary(agent: Agent) {
      const { spentTodayCents, spentTotalCents, paymentsLastHour } = spendContext(agent.id, "", false);
      const { policy } = agent;
      return {
        spentTodayCents,
        spentTotalCents,
        paymentsLastHour,
        remainingTodayCents: Math.max(policy.dailyBudgetCents - spentTodayCents, 0),
        remainingTotalCents: Math.max(policy.totalBudgetCents - spentTotalCents, 0),
      };
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
