import { randomUUID } from "node:crypto";
import type { Explainer } from "./ai/explain.js";
import type { Agent, Db, PaymentRow } from "./db.js";
import { addAuditEvent, auditBus, getAgent, getRecipient, parseRuleResults } from "./db.js";
import { PayPalError } from "./paypal.js";
import type { PayPalClient } from "./paypal.js";
import { evaluate } from "./policy/engine.js";
import { parseMinorUnits } from "./policy/money.js";
import type { Evaluation, PaymentKind, PaymentRequest, SpendContext } from "./policy/types.js";

export interface PayInput extends PaymentRequest {
  memo?: string;
  idempotencyKey?: string;
}

interface SubmitInput extends PayInput {
  kind: PaymentKind;
  target?: string;
}

export type PaymentResult = Record<string, unknown> & { status: string };

const MAX_CREATE_ATTEMPTS = 3;
const SUCCEEDED = new Set(["SUCCESS", "UNCLAIMED"]);
const FAILED = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED"]);
const NOUNS: Record<PaymentKind, string> = { payment: "payment", refund: "refund", invoice: "invoice" };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function failedRules(row: PaymentRow) {
  return parseRuleResults(row)
    .filter((result) => !result.passed)
    .map(({ rule, reason }) => ({ rule, reason }));
}

function describe(row: PaymentRow): string {
  if (row.kind === "refund") return `Refund of ${row.amount} ${row.currency} on PayPal capture ${row.target}`;
  if (row.kind === "invoice") return `Invoice for ${row.amount} ${row.currency} to ${row.recipient}`;
  return `${row.amount} ${row.currency} to ${row.recipient}`;
}

function executedResult(row: PaymentRow) {
  if (row.kind === "refund") {
    return { paypal_refund_id: row.transaction_id, reason: "Refund sent to the original payer." };
  }
  if (row.kind === "invoice") {
    return { paypal_invoice_id: row.transaction_id, reason: "Invoice sent to the recipient." };
  }
  return {
    paypal_transaction_id: row.transaction_id,
    reason:
      row.paypal_status === "UNCLAIMED"
        ? "Payment sent. The recipient has no PayPal account yet, so it is waiting to be claimed."
        : "Payment sent.",
  };
}

// What an agent sees. Every outcome says why, so the agent can adapt.
export function toResult(row: PaymentRow): PaymentResult {
  const base = {
    payment_id: row.id,
    type: row.kind,
    recipient: row.recipient,
    amount: row.amount,
    currency: row.currency,
  };
  const noun = NOUNS[row.kind];
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
      return { ...base, status: "rejected", reason: `A human rejected this ${noun}. Do not retry it.` };
    case "sending":
      return {
        ...base,
        status: "processing",
        reason: `PayPal has not finished this ${noun} yet.`,
        next_step: "Call check_approval with this payment_id to get the final result. Do not send it again.",
      };
    case "executed":
      return { ...base, status: "executed", paypal_status: row.paypal_status, ...executedResult(row) };
    case "refunded":
      return { ...base, status: "refunded", reason: "This payment was cancelled and the funds were returned." };
    case "failed":
      return { ...base, status: "failed", reason: `PayPal could not complete this ${noun}: ${row.error}` };
  }
}

export function createPaymentService(
  db: Db,
  paypal: PayPalClient,
  options: { pollMs?: number; pollTimeoutMs?: number; explain?: Explainer | null } = {},
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
  // Invoices count towards the hourly rate only, because they request money rather than spend it.
  function spendContext(agentId: string, recipient: string, approvedByHuman: boolean): SpendContext {
    const now = new Date();
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    const spent = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN kind <> 'invoice' AND reserved_at >= @dayStart THEN amount_usd_cents END), 0) AS today,
           COALESCE(SUM(CASE WHEN kind <> 'invoice' THEN amount_usd_cents END), 0) AS total,
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
    .transaction((agent: Agent, input: SubmitInput): { row: PaymentRow; isNew: boolean } => {
      if (input.idempotencyKey) {
        const existing = db
          .prepare("SELECT * FROM payments WHERE agent_id = ? AND idempotency_key = ?")
          .get(agent.id, input.idempotencyKey) as PaymentRow | undefined;
        if (existing) return { row: existing, isNew: false };
      }

      const recipient = input.recipient.trim().toLowerCase();
      const evaluation = evaluate(agent.policy, input, spendContext(agent.id, recipient, false), input.kind);
      const status = { ALLOW: "sending", REQUIRE_APPROVAL: "pending_approval", DENY: "blocked" }[evaluation.decision];
      const now = new Date().toISOString();
      const id = randomUUID();
      const minorUnits = parseMinorUnits(input.amount);

      db.prepare(
        `INSERT INTO payments (id, agent_id, kind, target, recipient, amount, currency, amount_usd_cents, category, memo,
           status, rule_results, idempotency_key, created_at, reserved_at)
         VALUES (@id, @agentId, @kind, @target, @recipient, @amount, @currency, @amountUsdCents, @category, @memo,
           @status, @ruleResults, @idempotencyKey, @createdAt, @reservedAt)`,
      ).run({
        id,
        agentId: agent.id,
        kind: input.kind,
        target: input.target ?? null,
        recipient,
        amount: minorUnits === null ? String(input.amount) : (minorUnits / 100).toFixed(2),
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
    const failures = evaluation.results
      .filter((result) => !result.passed)
      .filter((result) => evaluation.decision !== "DENY" || result.rule !== "auto_approve_limit")
      .map((result) => result.reason);
    audit(
      row,
      `decision.${evaluation.decision.toLowerCase()}`,
      `${describe(row)}${failures.length ? `: ${failures.join("; ")}` : ""}`,
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
      audit(row, "payment.executed", `Sent ${describe(row)}, PayPal transaction ${item.transactionId}`);
    } else if (FAILED.has(item.status)) {
      markFailed(row, item.error ?? `PayPal status ${item.status}`, item.status);
    }
  }

  function markFailed(row: PaymentRow, error: string, paypalStatus: string | null = null) {
    setFields(row.id, { status: "failed", error, paypal_status: paypalStatus });
    audit(row, "payment.failed", `PayPal could not complete: ${describe(row)}: ${error}`);
  }

  // Runs after the decision is final, and never delays or changes it. If this fails,
  // the dashboard still shows the rule's own reason.
  function explainLater(id: string) {
    const row = getRow(id);
    const agent = row && getAgent(db, row.agent_id);
    if (!options.explain || !row || !agent) return;

    const context = spendContext(row.agent_id, row.recipient, false);
    const reasons = failedRules(row)
      .filter((failure) => row.status === "pending_approval" || failure.rule !== "auto_approve_limit")
      .map((failure) => failure.reason);

    options
      .explain({
        outcome: row.status === "blocked" ? "blocked" : "held",
        action: row.kind,
        agent: agent.name,
        amount: row.amount,
        currency: row.currency,
        recipient: row.recipient,
        recipientKnown: context.recipientRecord !== null,
        recipientVerified: context.recipientRecord?.verified === true,
        spentTodayCents: context.spentTodayCents,
        dailyBudgetCents: agent.policy.dailyBudgetCents,
        reasons,
      })
      .then((explanation) => {
        if (!explanation) return;
        setFields(id, { explanation });
        auditBus.emit("event");
      })
      .catch((err) => console.error(`Explanation failed: ${(err as Error).message}`));
  }

  async function refresh(id: string) {
    const row = getRow(id);
    if (row?.status !== "sending" || !row.payout_batch_id) return;
    const item = await paypal.getPayoutItem(row.payout_batch_id);
    if (item) applyItem(id, item);
  }

  // A 4xx on the first attempt means PayPal refused, so the reservation is released.
  // After a 5xx or network error the outcome is unknown: the money may have moved,
  // so the row stays "sending" and keeps its budget rather than risk overspending.
  async function callPayPal<T>(row: PaymentRow, call: () => Promise<T>): Promise<T | null> {
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      try {
        return await call();
      } catch (err) {
        const refused = err instanceof PayPalError && err.status < 500;
        if (refused && attempt === 0) {
          markFailed(row, `${err.name}: ${err.message}`);
          return null;
        }
        if (refused) break;
      }
    }
    setFields(row.id, { error: "PayPal did not confirm this. Check the sandbox before retrying." });
    audit(row, "payment.unconfirmed", `PayPal did not confirm: ${describe(row)}`);
    return null;
  }

  function finish(row: PaymentRow, type: string, transactionId: string, paypalStatus: string, summary: string) {
    setFields(row.id, { status: "executed", transaction_id: transactionId, paypal_status: paypalStatus });
    audit(row, type, summary);
  }

  async function sendPayout(row: PaymentRow, value: string) {
    const batchId = await callPayPal(row, () =>
      paypal.createPayout({
        senderBatchId: `leash-${row.id}`,
        recipient: row.recipient,
        value,
        currency: row.currency,
        note: row.memo || "Payment from a Leash agent",
      }),
    );
    if (!batchId) return;
    setFields(row.id, { payout_batch_id: batchId });

    const deadline = Date.now() + pollTimeoutMs;
    while (getRow(row.id)?.status === "sending" && Date.now() < deadline) {
      await sleep(pollMs);
      await refresh(row.id).catch(() => undefined);
    }
  }

  async function execute(id: string) {
    const row = getRow(id)!;
    const value = (parseMinorUnits(row.amount)! / 100).toFixed(2);
    audit(row, "payment.sending", `Sending through PayPal: ${describe(row)}`);

    if (row.kind === "refund") {
      const refund = await callPayPal(row, () =>
        paypal.refundCapture({ captureId: row.target!, value, currency: row.currency, note: row.memo, requestId: row.id }),
      );
      if (refund) finish(row, "refund.executed", refund.id, refund.status, `${describe(row)}, PayPal refund ${refund.id}`);
    } else if (row.kind === "invoice") {
      const invoiceId = await callPayPal(row, () =>
        paypal.sendInvoice({ requestId: row.id, recipient: row.recipient, value, currency: row.currency, description: row.memo }),
      );
      if (invoiceId) finish(row, "invoice.sent", invoiceId, "SENT", `${describe(row)}, PayPal invoice ${invoiceId}`);
    } else {
      await sendPayout(row, value);
    }
  }

  // Approval re-runs the whole policy, because budgets or the policy may have changed.
  const resolveInTransaction = db
    .transaction((id: string, approved: boolean): { row: PaymentRow; send: boolean } | null => {
      const row = getRow(id);
      if (row?.status !== "pending_approval") return null;

      if (!approved) {
        setFields(id, { status: "rejected" });
        audit(row, "approval.rejected", `A human rejected: ${describe(row)}`);
        return { row: getRow(id)!, send: false };
      }

      const agent = getAgent(db, row.agent_id)!;
      const request = { recipient: row.recipient, amount: row.amount, currency: row.currency, category: row.category };
      const evaluation = evaluate(agent.policy, request, spendContext(row.agent_id, row.recipient, true), row.kind);
      const allowed = evaluation.decision === "ALLOW";

      setFields(id, {
        status: allowed ? "sending" : "blocked",
        rule_results: JSON.stringify(evaluation.results),
        reserved_at: allowed ? new Date().toISOString() : null,
      });
      audit(row, "approval.approved", `A human approved: ${describe(row)}`);
      auditDecision(getRow(id)!, evaluation);
      return { row: getRow(id)!, send: allowed };
    })
    .immediate;

  async function submit(agent: Agent, input: SubmitInput): Promise<PaymentResult> {
    const { row, isNew } = recordPayment(agent, input);
    if (isNew && row.status === "sending") await execute(row.id);
    if (isNew && row.status !== "sending") explainLater(row.id);
    return toResult(getRow(row.id)!);
  }

  return {
    pay: (agent: Agent, input: PayInput) => submit(agent, { ...input, kind: "payment" }),

    // Invoices request money, so they skip budgets but keep every other relevant rule.
    createInvoice: (agent: Agent, input: PayInput) => submit(agent, { ...input, kind: "invoice" }),

    // PayPal sends a refund back to the original payer, so an agent can't redirect it.
    async refundCapture(
      agent: Agent,
      input: { captureId: string; amount?: unknown; reason?: string; idempotencyKey?: string },
    ): Promise<PaymentResult> {
      let capture;
      try {
        capture = await paypal.getCapture(input.captureId);
      } catch (err) {
        if (err instanceof PayPalError && err.status < 500) {
          return { status: "not_found", reason: `PayPal has no capture ${input.captureId} for this account.` };
        }
        throw err;
      }
      return submit(agent, {
        kind: "refund",
        target: input.captureId,
        recipient: "original payer",
        amount: input.amount ?? capture.value,
        currency: capture.currency,
        category: "refund",
        memo: input.reason ?? "",
        idempotencyKey: input.idempotencyKey,
      });
    },

    // Reversing a payout returns money, so no spending rule can object to it. PayPal
    // only allows this while a payout is unclaimed.
    async reversePayout(agent: Agent, id: string): Promise<PaymentResult> {
      const row = getRow(id);
      if (row?.agent_id !== agent.id) return { status: "not_found", reason: `No payment ${id} exists for this agent.` };
      if (row.kind !== "payment" || row.status !== "executed") {
        return { ...toResult(row), status: "not_refundable", reason: `Only a sent payment can be reversed. This one is ${row.status}.` };
      }

      const item = row.payout_batch_id ? await paypal.getPayoutItem(row.payout_batch_id) : null;
      if (item && item.status !== row.paypal_status) setFields(id, { paypal_status: item.status });
      if ((item?.status ?? row.paypal_status) !== "UNCLAIMED") {
        return {
          ...toResult(row),
          status: "not_refundable",
          reason: "The recipient has claimed this payout. PayPal cannot reverse it, so the recipient has to send it back.",
        };
      }

      try {
        await paypal.cancelPayoutItem(row.payout_item_id!);
      } catch (err) {
        const message = (err as Error).message;
        audit(row, "refund.failed", `PayPal could not cancel the unclaimed payout: ${describe(row)}: ${message}`);
        return {
          ...toResult(row),
          status: "failed",
          reason: `PayPal could not cancel this payout: ${message}. It is still unclaimed. If nobody claims it within 30 days, PayPal returns the funds.`,
        };
      }
      setFields(id, { status: "refunded" });
      audit(row, "refund.executed", `Cancelled the unclaimed payout and returned the funds: ${describe(row)}`);
      return toResult(getRow(id)!);
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
      } else if (resolved.row.status === "blocked") {
        explainLater(id);
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
