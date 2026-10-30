import { describe, expect, it } from "vitest";
import { evaluate } from "./engine.js";
import { parseMinorUnits, toUsdCents } from "./money.js";
import { policySchema } from "./types.js";
import type { PaymentRequest, Policy, RuleId, SpendContext } from "./types.js";

const policy = (overrides: Partial<Policy> = {}): Policy => ({
  perTransactionCapCents: 50_00,
  autoApproveLimitCents: 25_00,
  dailyBudgetCents: 100_00,
  totalBudgetCents: 500_00,
  allowedRecipients: null,
  blockedRecipients: [],
  requireVerifiedRecipient: false,
  allowedCategories: null,
  blockedCategories: [],
  maxPaymentsPerHour: 10,
  allowedCurrencies: ["USD"],
  ...overrides,
});

const request = (overrides: Partial<PaymentRequest> = {}): PaymentRequest => ({
  recipient: "vendor@example.com",
  amount: "10.00",
  currency: "USD",
  category: "software",
  ...overrides,
});

const context = (overrides: Partial<SpendContext> = {}): SpendContext => ({
  spentTodayCents: 0,
  spentTotalCents: 0,
  paymentsLastHour: 0,
  recipientRecord: null,
  approvedByHuman: false,
  ...overrides,
});

const failedRules = (result: ReturnType<typeof evaluate>): RuleId[] =>
  result.results.filter((r) => !r.passed).map((r) => r.rule);

const reasonFor = (result: ReturnType<typeof evaluate>, rule: RuleId) =>
  result.results.find((r) => r.rule === rule)?.reason;

describe("decisions", () => {
  it("allows a payment that passes every rule", () => {
    const result = evaluate(policy(), request(), context());
    expect(result.decision).toBe("ALLOW");
    expect(failedRules(result)).toEqual([]);
    expect(result.amountUsdCents).toBe(10_00);
  });

  it("returns a result with a reason for all ten rules", () => {
    const { results } = evaluate(policy(), request(), context());
    expect(results).toHaveLength(10);
    for (const result of results) expect(result.reason).not.toBe("");
  });

  it("is deterministic", () => {
    const run = () => evaluate(policy(), request({ amount: "30" }), context());
    expect(run()).toEqual(run());
  });
});

describe("amount", () => {
  it.each(["0", "0.00", "-5", "", " 5", "5.001", "1e3", "0x10", "abc", "5.", ".5", "1,000", "NaN", "Infinity"])(
    "denies %j",
    (amount) => {
      const result = evaluate(policy(), request({ amount }), context());
      expect(result.decision).toBe("DENY");
      expect(failedRules(result)).toContain("valid_amount");
      expect(result.amountUsdCents).toBeNull();
    },
  );

  it.each([[NaN], [Infinity], [-1], [0.1 + 0.2], [null], [undefined], [{}], [["10"]]])("denies %j", (amount) => {
    expect(evaluate(policy(), request({ amount }), context()).decision).toBe("DENY");
  });

  it("denies an absurdly large amount rather than losing precision", () => {
    expect(parseMinorUnits("99999999999999999999")).toBeNull();
  });

  it("accepts whole, one-decimal, and numeric amounts", () => {
    expect(parseMinorUnits("10")).toBe(1000);
    expect(parseMinorUnits("10.5")).toBe(1050);
    expect(parseMinorUnits(19.99)).toBe(1999);
  });

  it("skips amount rules when the amount is invalid but still reports other rules", () => {
    const result = evaluate(policy({ blockedRecipients: ["vendor@example.com"] }), request({ amount: "x" }), context());
    expect(failedRules(result)).toEqual(["valid_amount", "allowed_recipient"]);
  });
});

describe("per-transaction cap", () => {
  it("passes exactly at the cap", () => {
    const result = evaluate(policy(), request({ amount: "50.00" }), context({ approvedByHuman: true }));
    expect(failedRules(result)).toEqual([]);
  });

  it("denies one cent over the cap and explains why", () => {
    const result = evaluate(policy(), request({ amount: "50.01" }), context());
    expect(result.decision).toBe("DENY");
    expect(reasonFor(result, "per_transaction_cap")).toBe("amount $50.01 exceeds per-transaction cap $50.00");
  });
});

describe("auto-approve limit", () => {
  it("allows exactly at the limit", () => {
    expect(evaluate(policy(), request({ amount: "25.00" }), context()).decision).toBe("ALLOW");
  });

  it("requires approval one cent over the limit", () => {
    const result = evaluate(policy(), request({ amount: "25.01" }), context());
    expect(result.decision).toBe("REQUIRE_APPROVAL");
    expect(failedRules(result)).toEqual(["auto_approve_limit"]);
  });

  it("allows a held payment once a human approves it", () => {
    const result = evaluate(policy(), request({ amount: "30.00" }), context({ approvedByHuman: true }));
    expect(result.decision).toBe("ALLOW");
    expect(reasonFor(result, "auto_approve_limit")).toBe("approved by a human");
  });

  it("does not let human approval override a hard rule", () => {
    const result = evaluate(policy(), request({ amount: "60.00" }), context({ approvedByHuman: true }));
    expect(result.decision).toBe("DENY");
  });

  it("denies a held payment when the budget ran out before approval", () => {
    const held = request({ amount: "30.00" });
    expect(evaluate(policy(), held, context()).decision).toBe("REQUIRE_APPROVAL");
    const later = context({ approvedByHuman: true, spentTodayCents: 80_00 });
    expect(evaluate(policy(), held, later).decision).toBe("DENY");
  });
});

describe("budgets", () => {
  it("passes when a payment lands exactly on the daily budget", () => {
    expect(evaluate(policy(), request(), context({ spentTodayCents: 90_00 })).decision).toBe("ALLOW");
  });

  it("denies one cent past the daily budget", () => {
    const result = evaluate(policy(), request({ amount: "10.01" }), context({ spentTodayCents: 90_00 }));
    expect(result.decision).toBe("DENY");
    expect(failedRules(result)).toEqual(["daily_budget"]);
  });

  it("passes when a payment lands exactly on the total budget", () => {
    expect(evaluate(policy(), request(), context({ spentTotalCents: 490_00 })).decision).toBe("ALLOW");
  });

  it("denies one cent past the total budget", () => {
    const result = evaluate(policy(), request({ amount: "10.01" }), context({ spentTotalCents: 490_00 }));
    expect(result.decision).toBe("DENY");
    expect(failedRules(result)).toEqual(["total_budget"]);
  });

  it("exhausts the budget across calls", () => {
    let spent = 0;
    const decisions = [1, 2, 3, 4, 5].map(() => {
      const result = evaluate(policy({ dailyBudgetCents: 45_00 }), request({ amount: "15.00" }), context({ spentTodayCents: spent }));
      if (result.decision === "ALLOW") spent += result.amountUsdCents ?? 0;
      return result.decision;
    });
    expect(decisions).toEqual(["ALLOW", "ALLOW", "ALLOW", "DENY", "DENY"]);
    expect(spent).toBe(45_00);
  });

  it("denies everything on a zero budget", () => {
    expect(evaluate(policy({ dailyBudgetCents: 0 }), request({ amount: "0.01" }), context()).decision).toBe("DENY");
  });
});

describe("recipients", () => {
  it("denies a blocked recipient", () => {
    const result = evaluate(policy({ blockedRecipients: ["vendor@example.com"] }), request(), context());
    expect(result.decision).toBe("DENY");
    expect(reasonFor(result, "allowed_recipient")).toBe("recipient vendor@example.com is blocked");
  });

  it("cannot be bypassed with case or spaces", () => {
    const list = { blockedRecipients: ["vendor@example.com"] };
    expect(evaluate(policy(list), request({ recipient: " VENDOR@Example.com " }), context()).decision).toBe("DENY");
  });

  it("allows a listed recipient and denies an unlisted one", () => {
    const list = { allowedRecipients: ["vendor@example.com"] };
    expect(evaluate(policy(list), request(), context()).decision).toBe("ALLOW");
    expect(evaluate(policy(list), request({ recipient: "other@example.com" }), context()).decision).toBe("DENY");
  });

  it("treats an empty allowlist as nobody", () => {
    expect(evaluate(policy({ allowedRecipients: [] }), request(), context()).decision).toBe("DENY");
  });

  it("lets a block win over an allow", () => {
    const list = { allowedRecipients: ["vendor@example.com"], blockedRecipients: ["vendor@example.com"] };
    expect(evaluate(policy(list), request(), context()).decision).toBe("DENY");
  });
});

describe("verified recipients", () => {
  const strict = policy({ requireVerifiedRecipient: true });

  it("allows a verified vendor", () => {
    const record = { verified: true, category: "software" };
    expect(evaluate(strict, request(), context({ recipientRecord: record })).decision).toBe("ALLOW");
  });

  it("denies an unverified vendor", () => {
    const record = { verified: false, category: "software" };
    expect(evaluate(strict, request(), context({ recipientRecord: record })).decision).toBe("DENY");
  });

  it("denies an unknown recipient", () => {
    const result = evaluate(strict, request(), context());
    expect(failedRules(result)).toEqual(["verified_recipient"]);
  });
});

describe("categories", () => {
  it("denies a blocked category and ignores case", () => {
    const result = evaluate(policy({ blockedCategories: ["gambling"] }), request({ category: "Gambling" }), context());
    expect(result.decision).toBe("DENY");
    expect(reasonFor(result, "allowed_category")).toBe("category gambling is blocked");
  });

  it("denies an agent that mislabels a blocked vendor", () => {
    const record = { verified: true, category: "gambling" };
    const result = evaluate(policy({ blockedCategories: ["gambling"] }), request({ category: "software" }), context({ recipientRecord: record }));
    expect(result.decision).toBe("DENY");
  });

  it("enforces a category allowlist", () => {
    const list = { allowedCategories: ["software"] };
    expect(evaluate(policy(list), request(), context()).decision).toBe("ALLOW");
    expect(evaluate(policy(list), request({ category: "travel" }), context()).decision).toBe("DENY");
  });

  it("denies a blank category under an allowlist", () => {
    expect(evaluate(policy({ allowedCategories: ["software"] }), request({ category: " " }), context()).decision).toBe("DENY");
  });

  it("does not pass an allowlist just because the agent says so", () => {
    const record = { verified: true, category: "gambling" };
    const result = evaluate(policy({ allowedCategories: ["software"] }), request(), context({ recipientRecord: record }));
    expect(result.decision).toBe("DENY");
  });
});

describe("velocity limit", () => {
  it("allows the last payment in the window", () => {
    expect(evaluate(policy(), request(), context({ paymentsLastHour: 9 })).decision).toBe("ALLOW");
  });

  it("denies at the limit", () => {
    const result = evaluate(policy(), request(), context({ paymentsLastHour: 10 }));
    expect(result.decision).toBe("DENY");
    expect(reasonFor(result, "velocity_limit")).toBe("velocity limit reached: 10 payments this hour, maximum 10");
  });
});

describe("currency", () => {
  it("denies a currency outside the allowlist", () => {
    const result = evaluate(policy(), request({ currency: "EUR" }), context());
    expect(result.decision).toBe("DENY");
    expect(result.amountUsdCents).toBeNull();
  });

  it("denies an allowlisted currency Leash cannot convert", () => {
    expect(evaluate(policy({ allowedCurrencies: ["XYZ"] }), request({ currency: "XYZ" }), context()).decision).toBe("DENY");
  });

  it("ignores case", () => {
    expect(evaluate(policy(), request({ currency: "usd" }), context()).decision).toBe("ALLOW");
  });

  it("enforces limits on the converted amount", () => {
    const eur = policy({ allowedCurrencies: ["USD", "EUR"] });
    const result = evaluate(eur, request({ amount: "47.00", currency: "EUR" }), context());
    expect(result.amountUsdCents).toBe(50_76);
    expect(failedRules(result)).toContain("per_transaction_cap");
  });

  it("rounds conversion up", () => {
    expect(toUsdCents(1, "EUR")).toBe(2);
  });
});

describe("multiple failures", () => {
  it("reports every failed rule, not just the first", () => {
    const strict = policy({ blockedRecipients: ["vendor@example.com"], blockedCategories: ["gambling"] });
    const result = evaluate(
      strict,
      request({ amount: "120.00", category: "gambling" }),
      context({ paymentsLastHour: 10, spentTodayCents: 95_00 }),
    );
    expect(result.decision).toBe("DENY");
    expect(failedRules(result)).toEqual([
      "allowed_recipient",
      "allowed_category",
      "velocity_limit",
      "per_transaction_cap",
      "daily_budget",
      "auto_approve_limit",
    ]);
  });

  it("prefers DENY over REQUIRE_APPROVAL", () => {
    const result = evaluate(policy({ blockedCategories: ["software"] }), request({ amount: "30.00" }), context());
    expect(result.decision).toBe("DENY");
  });
});

describe("policy schema", () => {
  it("normalizes list values so they match requests", () => {
    const parsed = policySchema.parse(policy({ blockedRecipients: [" Vendor@Example.com "], allowedCurrencies: ["usd"] }));
    expect(parsed.blockedRecipients).toEqual(["vendor@example.com"]);
    expect(parsed.allowedCurrencies).toEqual(["USD"]);
  });

  it("rejects fractional and negative limits", () => {
    expect(policySchema.safeParse(policy({ perTransactionCapCents: 10.5 })).success).toBe(false);
    expect(policySchema.safeParse(policy({ dailyBudgetCents: -1 })).success).toBe(false);
  });
});
