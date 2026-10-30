import { useState } from "react";
import { resolveApproval } from "../api";
import type { Approval } from "../api";
import { formatMoney, formatTime } from "../format";
import { Icon } from "./Icon";

const ACTIONS = {
  payment: { label: "Payment", approve: "Approve and pay" },
  refund: { label: "Refund", approve: "Approve refund" },
  invoice: { label: "Invoice", approve: "Approve and send" },
};

export function ApprovalCard({ approval, agentName }: { approval: Approval; agentName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trigger = approval.rule_results.find((result) => !result.passed);
  const action = ACTIONS[approval.kind];

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setError(null);
    try {
      await resolveApproval(approval.id, action);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <article className="approval">
      <header className="approval-head">
        <span className="tag tone-warn">
          <Icon name="pause" size={14} /> {action.label} waiting for you
        </span>
        <span className="approval-meta">
          {agentName} · {formatTime(approval.created_at)}
        </span>
      </header>

      <div className="approval-body">
        <div>
          <p className="approval-amount">{formatMoney(approval.amount, approval.currency)}</p>
          <p className="approval-to">
            {approval.kind === "refund" ? "back to " : "to "}
            <strong>{approval.recipient}</strong>
          </p>
          <p className="approval-category">Category: {approval.category || "not given"}</p>
        </div>
        <div className="approval-actions">
          <button className="button primary" disabled={busy} onClick={() => decide("approve")}>
            {action.approve}
          </button>
          <button className="button" disabled={busy} onClick={() => decide("reject")}>
            Reject
          </button>
        </div>
      </div>

      {trigger && (
        <p className="approval-why">
          <strong>Why it stopped:</strong> {trigger.reason}
        </p>
      )}

      {approval.explanation && <p className="ai-note"><span>AI summary</span>{approval.explanation}</p>}

      {approval.memo && (
        <blockquote className="approval-memo">
          <span>The agent says (unverified)</span>
          {approval.memo}
        </blockquote>
      )}

      {error && <p className="form-error">{error}</p>}

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
    </article>
  );
}
