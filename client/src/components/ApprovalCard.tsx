import { useState } from "react";
import { resolveApproval } from "../api";
import type { Approval } from "../api";
import { formatMoney, formatTime } from "../format";
import { Icon } from "./Icon";

const ACTIONS = {
  payment: { label: "Payment", approve: "Approve and pay", payeeLabel: "Pay to the order of" },
  refund: { label: "Refund", approve: "Approve refund", payeeLabel: "Refund back to" },
  invoice: { label: "Invoice", approve: "Approve and send", payeeLabel: "Invoice to" },
};

// A held payment is drawn as an unsigned cheque, because that's what it is.
export function ApprovalCard({ approval, agentName }: { approval: Approval; agentName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const triggers = approval.rule_results.filter((result) => !result.passed);
  const action = ACTIONS[approval.kind];
  const payee = approval.recipient_name ?? approval.recipient;

  async function decide(decision: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await resolveApproval(approval.id, decision);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <article className="approval">
      <div className="cheque-stub" aria-hidden="true">
        <span>Unsigned</span>
      </div>

      <div className="cheque-body">
        <header className="cheque-head">
          <p className="tag tone-warn">
            <Icon name="pause" size={14} /> {action.label} waiting for you
          </p>
          <p className="approval-meta">
            {agentName} · {formatTime(approval.created_at)}
          </p>
        </header>

        <div className="cheque-line">
          <div className="cheque-payee">
            <span>{action.payeeLabel}</span>
            <strong>{payee}</strong>
            {payee !== approval.recipient && <small>{approval.recipient}</small>}
          </div>
          <p className="approval-amount">{formatMoney(approval.amount, approval.currency)}</p>
        </div>

        {approval.memo && (
          <p className="cheque-memo">
            <span>Memo · the agent says, unverified</span>
            {approval.memo}
          </p>
        )}

        {triggers.length > 0 && (
          <p className="approval-why">
            <strong>Why it stopped:</strong> {triggers.map((result) => result.reason).join("; ")}
          </p>
        )}

        {approval.explanation && (
          <p className="ai-note">
            <span>AI summary</span>
            {approval.explanation}
          </p>
        )}

        {error && <p className="form-error">{error}</p>}

        <footer className="cheque-foot">
          <details className="approval-rules">
            <summary>All {approval.rule_results.length} policy checks</summary>
            <ul>
              {approval.rule_results.map((result) => (
                <li key={result.rule} className={result.passed ? "tone-good" : "tone-warn"}>
                  <Icon name={result.passed ? "check" : "pause"} size={14} />
                  <span>{result.reason}</span>
                </li>
              ))}
            </ul>
          </details>
          <div className="approval-actions">
            <button className="button" disabled={busy} onClick={() => decide("reject")}>
              Reject
            </button>
            <button className="button primary" disabled={busy} onClick={() => decide("approve")}>
              {action.approve}
            </button>
          </div>
        </footer>
      </div>
    </article>
  );
}
