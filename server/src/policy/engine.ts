import { formatUsd, isSupportedCurrency, parseMinorUnits, toUsdCents } from "./money.js";
import type {
  Evaluation,
  PaymentKind,
  PaymentRequest,
  Policy,
  RuleId,
  RuleResult,
  SpendContext,
} from "./types.js";

// A refund goes back to the original payer, so recipient rules have nothing to judge.
// An invoice requests money, so budgets don't apply and customers need no vendor check.
const SKIPPED_RULES: Record<PaymentKind, RuleId[]> = {
  payment: [],
  refund: ["allowed_recipient", "verified_recipient", "allowed_category", "recipient_window"],
  invoice: ["daily_budget", "total_budget", "verified_recipient", "recipient_window"],
};

// Failing only these sends a payment to a human. Failing anything else blocks it.
export const APPROVAL_RULES: RuleId[] = ["auto_approve_limit", "recipient_window"];

const rule = (id: RuleId, passed: boolean, reason: string): RuleResult => ({ rule: id, passed, reason });

function checkCurrency(policy: Policy, currency: string): RuleResult {
  const code = currency.trim().toUpperCase();
  const allowed = policy.allowedCurrencies.includes(code) && isSupportedCurrency(code);
  return rule(
    "allowed_currency",
    allowed,
    allowed
      ? `currency ${code} is allowed`
      : `currency ${code.slice(0, 12) || "(none)"} is not allowed. Allowed: ${policy.allowedCurrencies.join(", ") || "none"}`,
  );
}

function checkRecipient(policy: Policy, recipient: string): RuleResult {
  if (policy.blockedRecipients.includes(recipient)) {
    return rule("allowed_recipient", false, `recipient ${recipient} is blocked`);
  }
  if (policy.allowedRecipients && !policy.allowedRecipients.includes(recipient)) {
    return rule("allowed_recipient", false, `recipient ${recipient} is not on the allowlist`);
  }
  return rule("allowed_recipient", true, `recipient ${recipient} is allowed`);
}

function checkVerified(policy: Policy, recipient: string, context: SpendContext): RuleResult {
  if (!policy.requireVerifiedRecipient) {
    return rule("verified_recipient", true, "policy does not require a verified recipient");
  }
  const verified = context.recipientRecord?.verified === true;
  return rule(
    "verified_recipient",
    verified,
    verified ? `recipient ${recipient} is verified` : `recipient ${recipient} is not a verified vendor`,
  );
}

// Both the agent's label and Leash's record must pass, so a false label gains nothing.
function checkCategory(policy: Policy, declared: string, context: SpendContext): RuleResult {
  const registered = context.recipientRecord?.category.trim().toLowerCase();
  const categories = [...new Set([declared.trim().toLowerCase(), ...(registered ? [registered] : [])])];

  const blocked = categories.find((category) => policy.blockedCategories.includes(category));
  if (blocked) return rule("allowed_category", false, `category ${blocked} is blocked`);

  const allowed = policy.allowedCategories;
  const outside = allowed && categories.find((category) => !allowed.includes(category));
  if (outside !== null && outside !== undefined) {
    return rule("allowed_category", false, `category ${outside || "(none)"} is not on the allowlist`);
  }
  return rule("allowed_category", true, `category ${categories.join(", ") || "(none)"} is allowed`);
}

function checkVelocity(policy: Policy, context: SpendContext): RuleResult {
  const max = policy.maxPaymentsPerHour;
  const passed = context.paymentsLastHour < max;
  return rule(
    "velocity_limit",
    passed,
    passed
      ? `${context.paymentsLastHour} of ${max} payments used this hour`
      : `velocity limit reached: ${context.paymentsLastHour} payments this hour, maximum ${max}`,
  );
}

function checkBudget(id: RuleId, label: string, amount: number, spent: number, budget: number): RuleResult {
  const passed = spent + amount <= budget;
  return rule(
    id,
    passed,
    passed
      ? `${formatUsd(budget - spent - amount)} of the ${label} remains after this payment`
      : `amount ${formatUsd(amount)} exceeds the ${label}: ${formatUsd(spent)} of ${formatUsd(budget)} already used`,
  );
}

// Stops an agent splitting one large payment into small ones that each look harmless.
function checkRecipientWindow(policy: Policy, amount: number, context: SpendContext): RuleResult {
  const limit = policy.recipientWindowLimitCents;
  const total = context.recipientRecentCents + amount;
  const underLimit = total <= limit;
  return rule(
    "recipient_window",
    underLimit || context.approvedByHuman,
    context.approvedByHuman
      ? "approved by a human"
      : underLimit
        ? `${formatUsd(total)} of the ${formatUsd(limit)} per-recipient limit used in 24 hours`
        : `this would bring the recipient's 24-hour total to ${formatUsd(total)}, above the ${formatUsd(limit)} per-recipient limit`,
  );
}

function checkAmountRules(policy: Policy, amount: number, context: SpendContext): RuleResult[] {
  const cap = policy.perTransactionCapCents;
  const limit = policy.autoApproveLimitCents;
  const underCap = amount <= cap;
  const underLimit = amount <= limit;

  return [
    rule(
      "per_transaction_cap",
      underCap,
      underCap
        ? `amount ${formatUsd(amount)} is within the per-transaction cap ${formatUsd(cap)}`
        : `amount ${formatUsd(amount)} exceeds per-transaction cap ${formatUsd(cap)}`,
    ),
    checkBudget("daily_budget", "daily budget", amount, context.spentTodayCents, policy.dailyBudgetCents),
    checkBudget("total_budget", "total budget", amount, context.spentTotalCents, policy.totalBudgetCents),
    rule(
      "auto_approve_limit",
      underLimit || context.approvedByHuman,
      context.approvedByHuman
        ? "approved by a human"
        : underLimit
          ? `amount ${formatUsd(amount)} is within the auto-approve limit ${formatUsd(limit)}`
          : `amount ${formatUsd(amount)} is above the auto-approve limit ${formatUsd(limit)}`,
    ),
    checkRecipientWindow(policy, amount, context),
  ];
}

// Pure function: same input, same decision. A failed hard rule always wins, and
// human approval can only satisfy the auto-approve limit.
export function evaluate(
  policy: Policy,
  request: PaymentRequest,
  context: SpendContext,
  kind: PaymentKind = "payment",
): Evaluation {
  const recipient = request.recipient.trim().toLowerCase();
  const currencyResult = checkCurrency(policy, request.currency);
  const minorUnits = parseMinorUnits(request.amount);

  const allResults: RuleResult[] = [
    rule(
      "valid_amount",
      minorUnits !== null,
      minorUnits !== null ? "amount is valid" : `amount ${String(JSON.stringify(request.amount)).slice(0, 40)} is not a valid payment amount`,
    ),
    currencyResult,
    checkRecipient(policy, recipient),
    checkVerified(policy, recipient, context),
    checkCategory(policy, request.category, context),
    checkVelocity(policy, context),
  ];

  // Amount rules need a known USD value, so they run only when one exists.
  const amountUsdCents =
    minorUnits !== null && currencyResult.passed
      ? toUsdCents(minorUnits, request.currency.trim().toUpperCase())
      : null;
  if (amountUsdCents !== null) allResults.push(...checkAmountRules(policy, amountUsdCents, context));

  const results = allResults.filter((result) => !SKIPPED_RULES[kind].includes(result.rule));
  const failed = results.filter((result) => !result.passed);
  const decision =
    failed.length === 0
      ? "ALLOW"
      : failed.every((result) => APPROVAL_RULES.includes(result.rule))
        ? "REQUIRE_APPROVAL"
        : "DENY";

  return { decision, results, amountUsdCents };
}
