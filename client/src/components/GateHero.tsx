import { useEffect, useState } from "react";
import { resetDemo, startDemo } from "../api";
import type { DemoStatus } from "../api";
import { formatMoney, usd } from "../format";
import { runTotals, stampFor } from "../ledger";
import type { PaymentEntry, Stage } from "../ledger";
import { Icon } from "./Icon";

const START = "6%";
const POSITIONS: Record<Stage, string> = {
  held: "44%",
  blocked: "44%",
  rejected: "44%",
  expired: "44%",
  sending: "70%",
  failed: "70%",
  paid: "94%",
  reversed: "94%",
};

// How long a finished payment stays on the track, so a human can see what happened.
const LINGER_MS = 5000;

const GATE_LABELS = {
  closed: "Closed by default",
  open: "Open",
  stopped: "Blocked",
  holding: "Holding for you",
};

type GateState = keyof typeof GATE_LABELS;

function Token({ entry }: { entry: PaymentEntry }) {
  const [moved, setMoved] = useState(false);

  // One frame at the start line first, so the token visibly travels.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMoved(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const stamp = stampFor(entry);
  return (
    <div className={`token stage-${entry.stage}`} style={{ left: moved ? POSITIONS[entry.stage] : START }}>
      <strong>{formatMoney(entry.amount, entry.currency)}</strong>
      <span className={`token-stamp tone-${stamp.tone}`}>{stamp.label}</span>
    </div>
  );
}

function gateStateFor(tokens: PaymentEntry[]): GateState {
  if (tokens.some((entry) => entry.stage === "held")) return "holding";
  if (tokens.some((entry) => entry.stage === "blocked")) return "stopped";
  if (tokens.some((entry) => entry.stage === "sending" || entry.stage === "paid")) return "open";
  return "closed";
}

function GateTrack({ run, agentName }: { run: PaymentEntry[]; agentName: string }) {
  const [now, setNow] = useState(Date.now);

  // The gate has to close again on its own, even when no new event arrives.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const tokens = run.filter(
    (entry) =>
      entry.stage === "held" || entry.stage === "sending" || now - Date.parse(entry.lastAt) < LINGER_MS,
  );
  const gate = gateStateFor(tokens);

  return (
    <div className="track" data-gate={gate} role="img" aria-label={`Payment gate is ${GATE_LABELS[gate].toLowerCase()}`}>
      <div className="track-line" />

      <div className="track-node node-agent">
        <span className="node-icon">
          <Icon name="agent" size={24} />
        </span>
        <small>{agentName}</small>
      </div>

      <div className="gate">
        <div className="gate-frame">
          <div className="gate-bars" />
        </div>
        <small>{GATE_LABELS[gate]}</small>
      </div>

      <div className="track-node node-paypal">
        <span className="node-icon">
          <Icon name="paid" size={24} />
        </span>
        <small>PayPal sandbox</small>
      </div>

      {tokens.map((entry) => (
        <Token key={entry.key} entry={entry} />
      ))}
    </div>
  );
}

interface GateHeroProps {
  agentName: string;
  run: PaymentEntry[];
  demo: DemoStatus;
  waiting: boolean;
  onRunStarted: () => void;
}

export function GateHero({ agentName, run, demo, waiting, onRunStarted }: GateHeroProps) {
  const [error, setError] = useState<string | null>(null);
  const totals = runTotals(run);

  async function perform(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="hero demo" aria-label="Live payment gate">
      <div className="hero-top">
        <div>
          <p className="eyebrow">
            <i /> Live firewall · {agentName}
          </p>
          <h1>
            The AI proposes. <em>The code decides.</em>
          </h1>
        </div>
        <dl className="hero-stats">
          <div className="stat-paid">
            <dt>Paid</dt>
            <dd>{usd(totals.paidCents)}</dd>
          </div>
          <div className="stat-stopped">
            <dt>Stopped</dt>
            <dd>{usd(totals.stoppedCents)}</dd>
          </div>
          <div className="stat-waiting">
            <dt>Waiting for you</dt>
            <dd>{usd(totals.waitingCents)}</dd>
          </div>
        </dl>
      </div>

      <GateTrack run={run} agentName={agentName} />

      {demo.available && (
        <div className="hero-foot">
          <div className="hero-copy">
            {demo.running ? (
              <p className="demo-status" role="status">
                <i />
                {waiting
                  ? "The agent is waiting. Approve or reject the payment below."
                  : "The agent is working. Each PayPal payment takes about 20 seconds."}
              </p>
            ) : demo.report ? (
              <p className="demo-report">
                <span>What actually happened</span>
                {demo.report}
              </p>
            ) : (
              <p>
                Give a real AI agent three bills to pay. It holds no PayPal keys, and none of these rules are in its code.
              </p>
            )}
            {(error ?? demo.error) && <p className="hero-error">{error ?? demo.error}</p>}
          </div>
          <div className="hero-actions">
            <button
              className="button light"
              disabled={demo.running}
              onClick={() => perform(() => startDemo().then(onRunStarted))}
            >
              {demo.running ? "Agent running" : "Run demo agent"}
            </button>
            <button
              className="button ghost"
              disabled={demo.running}
              title="Restores the original rules and clears spending. The audit log keeps everything."
              onClick={() => perform(resetDemo)}
            >
              Reset demo
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
