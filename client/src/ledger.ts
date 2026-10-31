import type { AuditEvent } from "./api";

export type Stage = "sending" | "paid" | "blocked" | "held" | "rejected" | "expired" | "failed" | "reversed";

export interface PaymentEntry {
  type: "payment";
  key: string;
  kind: "payment" | "refund" | "invoice";
  amount: string;
  usdCents: number;
  currency: string;
  payee: string;
  email: string;
  memo: string;
  category: string;
  stage: Stage;
  unclaimed: boolean;
  transactionId: string | null;
  reason: string | null;
  explanation: string | null;
  steps: string[];
  at: string;
  lastAt: string;
}

export interface NoteEntry {
  type: "note";
  key: string;
  text: string;
  at: string;
}

export interface DividerEntry {
  type: "divider";
  key: string;
  text: string;
  at: string;
  reset: boolean;
}

export type LedgerEntry = PaymentEntry | NoteEntry | DividerEntry;

const STAGES: Record<string, Stage> = {
  sending: "sending",
  executed: "paid",
  blocked: "blocked",
  pending_approval: "held",
  rejected: "rejected",
  expired: "expired",
  failed: "failed",
  refunded: "reversed",
};

const STEP_LABELS: Record<string, string> = {
  "decision.allow": "Allowed",
  "decision.deny": "Blocked",
  "decision.require_approval": "Held",
  "approval.approved": "Approved",
  "approval.rejected": "Rejected",
  "approval.expired": "Expired",
  "payment.sending": "Sending",
  "payment.executed": "Paid",
  "payment.failed": "Failed",
  "refund.executed": "Refunded",
  "refund.failed": "Refund failed",
  "invoice.sent": "Invoiced",
};

// A decision's summary reads "what: why". Only the why belongs on the ledger row.
const reasonFrom = (summary: string) => {
  const index = summary.indexOf(": ");
  return index === -1 ? null : summary.slice(index + 2);
};

function startEntry(event: AuditEvent): PaymentEntry {
  return {
    type: "payment",
    key: event.payment_id!,
    kind: event.payment_kind ?? "payment",
    amount: event.payment_amount ?? "0",
    usdCents: event.payment_usd_cents ?? 0,
    currency: event.payment_currency ?? "USD",
    payee: event.recipient_name ?? event.payment_recipient ?? "",
    email: event.payment_recipient ?? "",
    memo: event.payment_memo ?? "",
    category: event.payment_category ?? "",
    stage: STAGES[event.payment_status ?? ""] ?? "sending",
    unclaimed: event.payment_paypal_status === "UNCLAIMED",
    transactionId: event.payment_transaction_id,
    reason: event.payment_status === "failed" ? event.payment_error : null,
    explanation: null,
    steps: [],
    at: event.at,
    lastAt: event.at,
  };
}

// Turns the audit trail, one line per step, into one row per payment.
export function buildLedger(events: AuditEvent[]) {
  const entries: LedgerEntry[] = [];
  const payments = new Map<string, PaymentEntry>();
  const samples: AuditEvent[] = [];

  for (const event of [...events].reverse()) {
    if (event.sample) {
      samples.push(event);
    } else if (event.payment_id) {
      let entry = payments.get(event.payment_id);
      if (!entry) {
        entry = startEntry(event);
        payments.set(event.payment_id, entry);
        entries.push(entry);
      }
      const step = STEP_LABELS[event.type];
      if (step) entry.steps.push(step);
      entry.lastAt = event.at;
      if (event.type === "decision.deny" || event.type === "decision.require_approval") {
        entry.reason = reasonFrom(event.summary);
        entry.explanation = event.explanation ?? entry.explanation;
      }
    } else if (event.type === "agent.note") {
      entries.push({ type: "note", key: `event-${event.id}`, text: event.summary, at: event.at });
    } else if (event.type === "demo.reset" || event.type === "policy.updated") {
      entries.push({
        type: "divider",
        key: `event-${event.id}`,
        text: event.summary,
        at: event.at,
        reset: event.type === "demo.reset",
      });
    }
  }

  return { entries, samples: samples.reverse() };
}

// Everything since the last reset, which is what the gate and its totals describe.
export function currentRun(entries: LedgerEntry[]): PaymentEntry[] {
  let start = 0;
  entries.forEach((entry, index) => {
    if (entry.type === "divider" && entry.reset) start = index + 1;
  });
  return entries.slice(start).filter((entry): entry is PaymentEntry => entry.type === "payment");
}

export function runTotals(run: PaymentEntry[]) {
  const sum = (stages: Stage[]) =>
    run
      .filter((entry) => entry.kind !== "invoice" && stages.includes(entry.stage))
      .reduce((total, entry) => total + entry.usdCents, 0);

  return {
    paidCents: sum(["paid", "sending"]),
    stoppedCents: sum(["blocked", "rejected", "expired"]),
    waitingCents: sum(["held"]),
  };
}

export const STAMPS: Record<Stage, { label: string; tone: string }> = {
  sending: { label: "Sending", tone: "info" },
  paid: { label: "Paid", tone: "good" },
  blocked: { label: "Blocked", tone: "bad" },
  held: { label: "Held", tone: "warn" },
  rejected: { label: "Rejected", tone: "bad" },
  expired: { label: "Expired", tone: "neutral" },
  failed: { label: "Failed", tone: "bad" },
  reversed: { label: "Reversed", tone: "neutral" },
};

export function stampFor(entry: PaymentEntry) {
  if (entry.stage === "paid" && entry.kind === "refund") return { label: "Refunded", tone: "good" };
  if (entry.stage === "paid" && entry.kind === "invoice") return { label: "Invoiced", tone: "good" };
  if (entry.stage === "paid" && entry.unclaimed) return { label: "Unclaimed", tone: "warn" };
  return STAMPS[entry.stage];
}
