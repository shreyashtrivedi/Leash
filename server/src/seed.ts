import { config } from "./config.js";
import type { Db } from "./db.js";
import { saveAgent, saveRecipient } from "./db.js";
import { policySchema } from "./policy/types.js";

export const DEMO_AGENT_ID = "research-agent";

const demoPolicy = policySchema.parse({
  perTransactionCapCents: 50_00,
  autoApproveLimitCents: 25_00,
  dailyBudgetCents: 100_00,
  totalBudgetCents: 500_00,
  allowedRecipients: null,
  blockedRecipients: [],
  requireVerifiedRecipient: true,
  allowedCategories: null,
  blockedCategories: ["gambling", "crypto"],
  maxPaymentsPerHour: 20,
  allowedCurrencies: ["USD"],
});

export function seed(db: Db): void {
  saveAgent(db, { id: DEMO_AGENT_ID, name: "Research Agent", policy: demoPolicy }, config.demoAgentKey);

  config.demoVendorEmails.forEach((email, index) => {
    saveRecipient(db, email, `Demo Vendor ${index + 1}`, { verified: true, category: "software" });
  });
  saveRecipient(db, "billing@luckyspin-casino.example.com", "Lucky Spin Casino", { verified: false, category: "gambling" });
}
