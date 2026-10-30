import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { draftPolicy, savePolicy } from "../api";
import type { Agent, Policy, PolicyDraft } from "../api";

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

const EXAMPLE =
  "This agent may pay up to $25 on its own, never more than $50 at once, $100 per day. Only verified vendors. Never for gambling or crypto.";

export function PolicyEditor({ agent, aiEnabled, onSaved }: { agent: Agent; aiEnabled: boolean; onSaved: () => void }) {
  const [form, setForm] = useState(() => toForm(agent.policy));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<PolicyDraft | null>(null);

  // Live updates deliver a new policy object each time, so compare by content.
  // Otherwise every payment event would wipe whatever the human is typing.
  const savedPolicy = JSON.stringify(agent.policy);

  useEffect(() => {
    setForm(toForm(JSON.parse(savedPolicy)));
  }, [agent.id, savedPolicy]);

  useEffect(() => {
    setSaved(false);
    setError(null);
    setDraft(null);
    setRules("");
  }, [agent.id]);

  const update = (key: keyof FormValues, value: string | boolean) => {
    setForm((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };

  async function requestDraft() {
    setDrafting(true);
    setError(null);
    try {
      const result = await draftPolicy(agent.id, rules);
      setDraft(result);
      setForm(toForm(result.policy));
      setSaved(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await savePolicy(agent.id, toPolicy(form));
      setError(null);
      setDraft(null);
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

      {aiEnabled && (
        <div className="ai-draft">
          <label htmlFor="policy-rules">Describe the rules in plain English</label>
          <textarea
            id="policy-rules"
            rows={3}
            maxLength={2000}
            placeholder={EXAMPLE}
            value={rules}
            onChange={(event) => setRules(event.target.value)}
          />
          <div className="ai-draft-foot">
            <small>AI fills in the form below. Nothing is enforced until you review it and save.</small>
            <button type="button" className="button" disabled={drafting || !rules.trim()} onClick={requestDraft}>
              {drafting ? "Drafting" : "Draft policy"}
            </button>
          </div>
        </div>
      )}

      {draft && (
        <div className="draft-review" role="status">
          <strong>Draft ready. Not saved yet.</strong>
          <p>Check every value below, then save to enforce it.</p>
          {draft.unchanged.length > 0 && <p>Not mentioned, so left unchanged: {draft.unchanged.join(", ")}.</p>}
          {draft.warnings.map((warning) => (
            <p key={warning} className="tone-warn">
              {warning}
            </p>
          ))}
        </div>
      )}

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
