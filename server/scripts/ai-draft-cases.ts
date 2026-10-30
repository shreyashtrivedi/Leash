// Checks how the live model reads different phrasings of the same two limits.
// Run from server/: npx tsx scripts/ai-draft-cases.ts
import { createAiClient } from "../src/ai/client.js";
import { draftPolicy } from "../src/ai/draftPolicy.js";
import type { Policy } from "../src/policy/types.js";

const ai = createAiClient();
if (!ai) throw new Error("AI_API_KEY is not set.");

const current: Policy = {
  perTransactionCapCents: 50_00,
  autoApproveLimitCents: 25_00,
  recipientWindowLimitCents: 50_00,
  dailyBudgetCents: 500_00,
  totalBudgetCents: 5000_00,
  allowedRecipients: null,
  blockedRecipients: [],
  requireVerifiedRecipient: false,
  allowedCategories: null,
  blockedCategories: [],
  maxPaymentsPerHour: 30,
  allowedCurrencies: ["USD"],
};

// [text, expected auto-approve cents, expected cap cents]
const cases: [string, number, number][] = [
  ["Pay up to $10 by yourself.", 10_00, 50_00],
  ["It can spend $15 on its own, anything more needs my OK.", 15_00, 50_00],
  ["Auto-approve up to $10. Hard maximum of $40 per payment.", 10_00, 40_00],
  ["Ask me above $20, and never more than $45 at once.", 20_00, 45_00],
  ["this agent may pay up to $25 per payment, ask me for anything over $25", 25_00, 50_00],
  ["No approval needed under $5. Block anything over $30.", 5_00, 30_00],
  ["Without asking, it may pay $8. Refuse anything above $20.", 8_00, 20_00],
];

let passed = 0;
for (const [text, auto, cap] of cases) {
  try {
    const { policy } = await draftPolicy(ai, text, current);
    const ok = policy.autoApproveLimitCents === auto && policy.perTransactionCapCents === cap;
    if (ok) passed++;
    console.log(`${ok ? "PASS" : "FAIL"} auto=${policy.autoApproveLimitCents} cap=${policy.perTransactionCapCents} (want ${auto}/${cap}): ${text}`);
  } catch (err) {
    console.log(`ERROR ${(err as Error).message.slice(0, 100)}: ${text}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
}
console.log(`${passed} of ${cases.length} correct`);
