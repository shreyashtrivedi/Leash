import type { AuditEvent } from "../api";
import { eventMeta, formatMoney, formatTime } from "../format";
import { stampFor } from "../ledger";
import type { LedgerEntry, PaymentEntry } from "../ledger";

function Stamp({ entry }: { entry: PaymentEntry }) {
  const stamp = stampFor(entry);
  // Keyed by label, so a held payment gets a fresh stamp when it's paid.
  return (
    <span key={stamp.label} className={`stamp tone-${stamp.tone}`}>
      {stamp.label}
    </span>
  );
}

function PaymentRow({ entry }: { entry: PaymentEntry }) {
  const prefix = { payment: "", refund: "Refund · ", invoice: "Invoice · " }[entry.kind];
  const details = [entry.memo && `“${entry.memo}”`, entry.category].filter(Boolean).join(" · ");

  return (
    <li className={`entry stage-${entry.stage}`}>
      <p className="entry-amount">{formatMoney(entry.amount, entry.currency)}</p>
      <div className="entry-main">
        <p className="entry-payee">
          {prefix}
          {entry.payee}
        </p>
        {details && <p className="entry-memo">{details}</p>}
        {entry.reason && <p className="entry-reason">{entry.reason}</p>}
        {entry.explanation && (
          <p className="ai-note">
            <span>AI summary</span>
            {entry.explanation}
          </p>
        )}
        <ol className="entry-steps">
          {entry.steps.map((step, index) => (
            <li key={`${step}-${index}`}>{step}</li>
          ))}
        </ol>
        {entry.transactionId && <p className="entry-id">PayPal {entry.transactionId}</p>}
      </div>
      <div className="entry-side">
        <Stamp entry={entry} />
        <time dateTime={entry.lastAt}>{formatTime(entry.lastAt)}</time>
      </div>
    </li>
  );
}

function SampleRow({ event }: { event: AuditEvent }) {
  const meta = eventMeta(event.type);
  return (
    <li>
      <strong className={`tone-${meta.tone}`}>{meta.label}</strong>
      <span>{event.summary}</span>
      <time dateTime={event.at}>{formatTime(event.at)}</time>
    </li>
  );
}

function Row({ entry }: { entry: LedgerEntry }) {
  if (entry.type === "payment") return <PaymentRow entry={entry} />;
  if (entry.type === "note") {
    return (
      <li className="note">
        <span>Agent</span>
        <p>{entry.text}</p>
      </li>
    );
  }
  return (
    <li className="divider">
      <span>{entry.text}</span>
    </li>
  );
}

interface LedgerProps {
  entries: LedgerEntry[];
  samples: AuditEvent[];
  limit: number;
  onSeeAll: () => void;
}

export function Ledger({ entries, samples, limit, onSeeAll }: LedgerProps) {
  const newest = [...entries].reverse();

  return (
    <section className="panel ledger">
      <header className="ledger-head">
        <h2>The ledger</h2>
        <p>One line per payment, stamped by the policy engine.</p>
      </header>

      {newest.length === 0 && (
        <p className="empty">Nothing yet. Every decision this agent triggers appears here as it happens.</p>
      )}

      {newest.length > 0 && (
        <ol className="entries">
          {newest.slice(0, limit).map((entry) => (
            <Row key={entry.key} entry={entry} />
          ))}
        </ol>
      )}

      {newest.length > limit && (
        <button className="link" onClick={onSeeAll}>
          See the full history in the audit log
        </button>
      )}

      {samples.length > 0 && (
        <details className="samples" open={newest.length === 0}>
          <summary>Sample history · illustrative, not real payments</summary>
          <ul>
            {samples.map((event) => (
              <SampleRow key={event.id} event={event} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
