import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { savePolicy } from "../api";
import type { Agent, Policy } from "../api";

interface FormValues {
  perTransactionCap: string;
  autoApproveLimit: string;
  dailyBudget: string;
  totalBudget: string;
  maxPaymentsPerHour: string;
  requireVerifiedRecipient: boolean;
  allowedRecipients: string;
  blockedRecipients: string;
  allowedCategories: string;
  blockedCategories: string;
  allowedCurrencies: string;
}

const toDollars = (cents: number) => (cents / 100).toFixed(2);
const toCents = (dollars: string) => Math.round(Number(dollars) * 100);
const joinList = (list: string[] | null) => (list ?? []).join(", ");
const splitList = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const optionalList = (text: string) => (splitList(text).length > 0 ? splitList(text) : null);

function toForm(policy: Policy): FormValues {
  return {
    perTransactionCap: toDollars(policy.perTransactionCapCents),
    autoApproveLimit: toDollars(policy.autoApproveLimitCents),
    dailyBudget: toDollars(policy.dailyBudgetCents),
    totalBudget: toDollars(policy.totalBudgetCents),
    maxPaymentsPerHour: String(policy.maxPaymentsPerHour),
    requireVerifiedRecipient: policy.requireVerifiedRecipient,
    allowedRecipients: joinList(policy.allowedRecipients),
    blockedRecipients: joinList(policy.blockedRecipients),
    allowedCategories: joinList(policy.allowedCategories),
    blockedCategories: joinList(policy.blockedCategories),
    allowedCurrencies: joinList(policy.allowedCurrencies),
  };
}

function toPolicy(form: FormValues): Policy {
  return {
    perTransactionCapCents: toCents(form.perTransactionCap),
    autoApproveLimitCents: toCents(form.autoApproveLimit),
    dailyBudgetCents: toCents(form.dailyBudget),
    totalBudgetCents: toCents(form.totalBudget),
    maxPaymentsPerHour: Number(form.maxPaymentsPerHour),
    requireVerifiedRecipient: form.requireVerifiedRecipient,
    allowedRecipients: optionalList(form.allowedRecipients),
    blockedRecipients: splitList(form.blockedRecipients),
    allowedCategories: optionalList(form.allowedCategories),
    blockedCategories: splitList(form.blockedCategories),
    allowedCurrencies: splitList(form.allowedCurrencies),
  };
}

const MONEY_FIELDS: [keyof FormValues, string, string][] = [
  ["autoApproveLimit", "Auto-approve limit", "Pays by itself up to this amount. Above it, you decide."],
  ["perTransactionCap", "Per-payment cap", "Anything above this is blocked outright."],
  ["dailyBudget", "Daily budget", "Resets at midnight UTC."],
  ["totalBudget", "Total budget", "Lifetime limit for this agent."],
];

const LIST_FIELDS: [keyof FormValues, string, string][] = [
  ["allowedRecipients", "Allowed recipients", "Leave empty to allow any recipient."],
  ["blockedRecipients", "Blocked recipients", "Always refused, even if allowed above."],
  ["allowedCategories", "Allowed categories", "Leave empty to allow any category."],
  ["blockedCategories", "Blocked categories", "Checked against Leash's vendor records too."],
  ["allowedCurrencies", "Allowed currencies", "Limits are enforced in USD."],
];

export function PolicyEditor({ agent, onSaved }: { agent: Agent; onSaved: () => void }) {
  const [form, setForm] = useState(() => toForm(agent.policy));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live updates deliver a new policy object each time, so compare by content.
  // Otherwise every payment event would wipe whatever the human is typing.
  const savedPolicy = JSON.stringify(agent.policy);

  useEffect(() => {
    setForm(toForm(JSON.parse(savedPolicy)));
  }, [agent.id, savedPolicy]);

  useEffect(() => {
    setSaved(false);
    setError(null);
  }, [agent.id]);

  const update = (key: keyof FormValues, value: string | boolean) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await savePolicy(agent.id, toPolicy(form));
      setError(null);
      setSaved(true);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="panel policy" onSubmit={submit}>
      <div className="policy-head">
        <div>
          <h2>Policy for {agent.name}</h2>
          <p>Enforced in plain code on every payment. Changes apply to the next payment.</p>
        </div>
      </div>

      <div className="policy-grid">
        {MONEY_FIELDS.map(([key, label, hint]) => (
          <label key={key} className="field">
            <span>{label}</span>
            <div className="money-input">
              <i>$</i>
              <input
                type="number"
                min="0"
                step="0.01"
                required
                value={form[key] as string}
                onChange={(event) => update(key, event.target.value)}
              />
            </div>
            <small>{hint}</small>
          </label>
        ))}
        <label className="field">
          <span>Payments per hour</span>
          <input
            type="number"
            min="0"
            step="1"
            required
            value={form.maxPaymentsPerHour}
            onChange={(event) => update("maxPaymentsPerHour", event.target.value)}
          />
          <small>Stops a runaway agent looping.</small>
        </label>
        <label className="field checkbox">
          <input
            type="checkbox"
            checked={form.requireVerifiedRecipient}
            onChange={(event) => update("requireVerifiedRecipient", event.target.checked)}
          />
          <span>
            Verified vendors only
            <small>Unknown recipients are blocked.</small>
          </span>
        </label>
      </div>

      <div className="policy-grid lists">
        {LIST_FIELDS.map(([key, label, hint]) => (
          <label key={key} className="field">
            <span>{label}</span>
            <input
              type="text"
              placeholder="Comma separated"
              value={form[key] as string}
              onChange={(event) => update(key, event.target.value)}
            />
            <small>{hint}</small>
          </label>
        ))}
      </div>

      <footer className="policy-foot">
        {error && <p className="form-error">{error}</p>}
        {saved && <p className="form-saved">Policy saved and logged.</p>}
        <button className="button primary" type="submit">
          Save policy
        </button>
      </footer>
    </form>
  );
}
