import type { AuditEvent } from "../api";
import { eventMeta, formatTime } from "../format";
import { Icon } from "./Icon";

export function Timeline({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return <p className="empty">Nothing yet. Every decision this agent triggers will appear here as it happens.</p>;
  }

  return (
    <ol className="timeline">
      {events.map((event) => {
        const meta = eventMeta(event.type);
        return (
          <li key={event.id} className="timeline-item">
            <span className={`timeline-icon tone-${meta.tone}`}>
              <Icon name={meta.icon} />
            </span>
            <div className="timeline-text">
              <p>
                <strong className={`tone-${meta.tone}`}>{meta.label}</strong>
                {event.sample === 1 && (
                  <span className="sample" title="Illustrative history. Not a real payment, and not counted in any budget.">
                    Sample
                  </span>
                )}
              </p>
              <p className="timeline-summary">{event.summary}</p>
              {event.explanation && <p className="ai-note"><span>AI summary</span>{event.explanation}</p>}
            </div>
            <time dateTime={event.at}>{formatTime(event.at)}</time>
          </li>
        );
      })}
    </ol>
  );
}
