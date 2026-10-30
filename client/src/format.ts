export const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatMoney(amount: string, currency: string) {
  const value = Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "USD" ? `$${value}` : `${value} ${currency}`;
}

export function formatTime(iso: string) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

export type Tone = "good" | "warn" | "bad" | "info" | "neutral";

export const EVENT_LABELS: Record<string, { label: string; tone: Tone; icon: string }> = {
  "decision.allow": { label: "Allowed", tone: "good", icon: "check" },
  "decision.deny": { label: "Blocked", tone: "bad", icon: "block" },
  "decision.require_approval": { label: "Held", tone: "warn", icon: "pause" },
  "approval.approved": { label: "Approved", tone: "good", icon: "user" },
  "approval.rejected": { label: "Rejected", tone: "bad", icon: "user" },
  "payment.sending": { label: "Sending", tone: "info", icon: "send" },
  "payment.executed": { label: "Paid", tone: "good", icon: "paid" },
  "payment.failed": { label: "Failed", tone: "bad", icon: "alert" },
  "payment.unconfirmed": { label: "Unconfirmed", tone: "warn", icon: "alert" },
  "policy.updated": { label: "Policy", tone: "neutral", icon: "shield" },
};

export const eventMeta = (type: string) =>
  EVENT_LABELS[type] ?? { label: type, tone: "neutral" as Tone, icon: "shield" };
