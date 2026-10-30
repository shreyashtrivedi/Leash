import { z } from "zod";

const cents = z.number().int().nonnegative();
const list = z.array(z.string().trim().toLowerCase().min(1));

// A null allow-list means "no restriction". An empty one allows nothing.
export const policySchema = z.object({
  perTransactionCapCents: cents,
  autoApproveLimitCents: cents,
  recipientWindowLimitCents: cents,
  dailyBudgetCents: cents,
  totalBudgetCents: cents,
  allowedRecipients: list.nullable(),
  blockedRecipients: list,
  requireVerifiedRecipient: z.boolean(),
  allowedCategories: list.nullable(),
  blockedCategories: list,
  maxPaymentsPerHour: z.number().int().nonnegative(),
  allowedCurrencies: z.array(z.string().trim().toUpperCase().length(3)),
});

export type Policy = z.infer<typeof policySchema>;

export interface PaymentRequest {
  recipient: string;
  amount: unknown;
  currency: string;
  category: string;
}

// Leash's own record of a recipient. An agent's claims never override this.
export interface RecipientRecord {
  verified: boolean;
  category: string;
}

export interface SpendContext {
  spentTodayCents: number;
  spentTotalCents: number;
  paymentsLastHour: number;
  recipientRecentCents: number;
  recipientRecord: RecipientRecord | null;
  approvedByHuman: boolean;
}

export type PaymentKind = "payment" | "refund" | "invoice";

export type Decision = "ALLOW" | "REQUIRE_APPROVAL" | "DENY";

export type RuleId =
  | "valid_amount"
  | "allowed_currency"
  | "per_transaction_cap"
  | "daily_budget"
  | "total_budget"
  | "allowed_recipient"
  | "verified_recipient"
  | "allowed_category"
  | "velocity_limit"
  | "auto_approve_limit"
  | "recipient_window";

export interface RuleResult {
  rule: RuleId;
  passed: boolean;
  reason: string;
}

export interface Evaluation {
  decision: Decision;
  results: RuleResult[];
  amountUsdCents: number | null;
}
