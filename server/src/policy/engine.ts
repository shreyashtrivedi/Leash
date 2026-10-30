import { formatUsd, isSupportedCurrency, parseMinorUnits, toUsdCents } from "./money.js";
import type {
  Evaluation,
  PaymentRequest,
  Policy,
  RuleId,
  RuleResult,
  SpendContext,
} from "./types.js";

const rule = (id: RuleId, passed: boolean, reason: string): RuleResult => ({ rule: id, passed, reason });

function checkCurrency(policy: Policy, currency: string): RuleResult {
  const code = currency.trim().toUpperCase();
  const allowed = policy.allowedCurrencies.includes(code) && isSupportedCurrency(code);
  return rule(
    "allowed_currency",
    allowed,
    allowed
      ? `currency ${code} is allowed`
      : `currency ${code || "(none)"} is not in the allowlist: ${policy.allowedCurrencies.join(", ") || "none"}`,
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
  ];
}

// Pure function: same input, same decision. A failed hard rule always wins, and
// human approval can only satisfy the auto-approve limit.
export function evaluate(policy: Policy, request: PaymentRequest, context: SpendContext): Evaluation {
  const recipient = request.recipient.trim().toLowerCase();
  const currencyResult = checkCurrency(policy, request.currency);
  const minorUnits = parseMinorUnits(request.amount);

  const results: RuleResult[] = [
    rule(
      "valid_amount",
      minorUnits !== null,
      minorUnits !== null ? "amount is valid" : `amount ${JSON.stringify(request.amount)} is not a valid payment amount`,
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
  if (amountUsdCents !== null) results.push(...checkAmountRules(policy, amountUsdCents, context));

  const failed = results.filter((result) => !result.passed);
  const decision =
    failed.length === 0
      ? "ALLOW"
      : failed.every((result) => result.rule === "auto_approve_limit")
        ? "REQUIRE_APPROVAL"
        : "DENY";

  return { decision, results, amountUsdCents };
}
