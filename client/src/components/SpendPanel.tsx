import type { Agent } from "../api";
import { usd } from "../format";

export function Meter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const percent = limit > 0 ? Math.min((used / limit) * 100, 100) : 100;
  return (
    <div
      className={`meter ${percent >= 80 ? "meter-high" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={used}
    >
      <span style={{ width: `${Math.max(percent, used > 0 ? 2 : 0)}%` }} />
    </div>
  );
}

function Budget({ label, used, limit, remaining }: { label: string; used: number; limit: number; remaining: number }) {
  return (
    <div className="budget">
      <div className="budget-row">
        <span>{label}</span>
        <strong>{usd(remaining)} left</strong>
      </div>
      <Meter used={used} limit={limit} label={`${label} used`} />
      <p>
        {usd(used)} of {usd(limit)} used
      </p>
    </div>
  );
}

export function SpendPanel({ agent }: { agent: Agent }) {
  const { policy, spend } = agent;
  const limits = [
    ["Pays by itself up to", usd(policy.autoApproveLimitCents)],
    ["Never pays more than", usd(policy.perTransactionCapCents)],
    ["To one recipient, 24 hours", usd(policy.recipientWindowLimitCents)],
    ["Payments this hour", `${spend.paymentsLastHour} of ${policy.maxPaymentsPerHour}`],
    ["Recipients", policy.requireVerifiedRecipient ? "Verified vendors only" : "Any allowed recipient"],
    ["Never for", policy.blockedCategories.join(", ") || "No blocked categories"],
  ];

  return (
    <aside className="panel spend">
      <h2>The allowance</h2>
      <Budget label="Today" used={spend.spentTodayCents} limit={policy.dailyBudgetCents} remaining={spend.remainingTodayCents} />
      <Budget label="All time" used={spend.spentTotalCents} limit={policy.totalBudgetCents} remaining={spend.remainingTotalCents} />
      <h2>The rules</h2>
      <dl>
        {limits.map(([term, value]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
