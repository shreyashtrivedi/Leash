import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import type { Db } from "./db.js";
import { addAuditEvent, saveAgent, saveRecipient } from "./db.js";
import { policySchema } from "./policy/types.js";

export const DEMO_AGENT_ID = "research-agent";
export const SUPPORT_AGENT_ID = "support-agent";

export const demoPolicy = policySchema.parse({
  perTransactionCapCents: 50_00,
  autoApproveLimitCents: 25_00,
  recipientWindowLimitCents: 50_00,
  dailyBudgetCents: 500_00,
  totalBudgetCents: 5000_00,
  allowedRecipients: null,
  blockedRecipients: [],
  requireVerifiedRecipient: true,
  allowedCategories: null,
  blockedCategories: ["gambling", "crypto"],
  maxPaymentsPerHour: 30,
  allowedCurrencies: ["USD"],
});

export const supportPolicy = policySchema.parse({
  ...demoPolicy,
  perTransactionCapCents: 20_00,
  autoApproveLimitCents: 10_00,
  recipientWindowLimitCents: 20_00,
  dailyBudgetCents: 40_00,
  totalBudgetCents: 200_00,
});

const HOUR = 3_600_000;

// Illustrative only: shown with a Sample label, no PayPal IDs, and never counted in budgets.
const sampleEvents = [
  [26, SUPPORT_AGENT_ID, "decision.allow", "8.00 USD to Demo Vendor 1"],
  [26, SUPPORT_AGENT_ID, "payment.executed", "Sent 8.00 USD to Demo Vendor 1"],
  [24, DEMO_AGENT_ID, "decision.allow", "19.00 USD to Demo Vendor 1"],
  [24, DEMO_AGENT_ID, "payment.executed", "Sent 19.00 USD to Demo Vendor 1"],
  [23, DEMO_AGENT_ID, "decision.deny", "75.00 USD to Demo Vendor 1: amount $75.00 exceeds per-transaction cap $50.00"],
  [22, DEMO_AGENT_ID, "decision.require_approval", "40.00 USD to Demo Vendor 1: amount $40.00 is above the auto-approve limit $25.00"],
  [22, DEMO_AGENT_ID, "approval.rejected", "A human rejected 40.00 USD to Demo Vendor 1"],
  [21, SUPPORT_AGENT_ID, "decision.deny", "5.00 USD to billing@luckyspin-casino.example.com: category gambling is blocked"],
] as const;

export function seed(db: Db): void {
  saveAgent(db, { id: DEMO_AGENT_ID, name: "Research Agent", policy: demoPolicy }, config.demoAgentKey);
  saveAgent(db, { id: SUPPORT_AGENT_ID, name: "Support Agent", policy: supportPolicy }, randomUUID());

  config.demoVendorEmails.forEach((email, index) => {
    saveRecipient(db, email, `Demo Vendor ${index + 1}`, { verified: true, category: "software" });
  });
  saveRecipient(db, "billing@luckyspin-casino.example.com", "Lucky Spin Casino", { verified: false, category: "gambling" });

  const hasHistory = db.prepare("SELECT 1 FROM audit_events LIMIT 1").get();
  if (hasHistory) return;
  for (const [hoursAgo, agentId, type, summary] of sampleEvents) {
    const at = new Date(Date.now() - hoursAgo * HOUR).toISOString();
    addAuditEvent(db, { agentId, paymentId: null, type, summary, at, sample: true });
  }
}
