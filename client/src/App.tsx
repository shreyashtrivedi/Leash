import { lazy, Suspense, useState } from "react";
import { useLeashState } from "./api";
import type { Agent, Connection } from "./api";
import { ApprovalCard } from "./components/ApprovalCard";
import { PolicyEditor } from "./components/PolicyEditor";
import { Meter, SpendPanel } from "./components/SpendPanel";
import { Timeline } from "./components/Timeline";
import { usd } from "./format";

const AuditGrid = lazy(() => import("./components/AuditGrid"));

type View = "overview" | "audit" | "policy";

const TIMELINE_LIMIT = 30;

const VIEWS: [View, string][] = [
  ["overview", "Overview"],
  ["audit", "Audit log"],
  ["policy", "Policy"],
];

const CONNECTION_LABELS: Record<Connection, string> = {
  connecting: "Connecting",
  live: "Live",
  offline: "Reconnecting",
};

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <circle cx="12" cy="12" r="5" fill="none" stroke="#fff" strokeWidth="3" />
      <path d="M16 16l9 9" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function AgentRail({
  agents,
  selected,
  pending,
  onSelect,
}: {
  agents: Agent[];
  selected: string;
  pending: (id: string) => number;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="rail" aria-label="Agents">
      <h2>Agents</h2>
      {agents.map((agent) => (
        <button
          key={agent.id}
          className={`rail-agent ${agent.id === selected ? "active" : ""}`}
          aria-current={agent.id === selected}
          onClick={() => onSelect(agent.id)}
        >
          <span className="rail-name">
            {agent.name}
            {pending(agent.id) > 0 && <b>{pending(agent.id)} waiting</b>}
          </span>
          <Meter used={agent.spend.spentTodayCents} limit={agent.policy.dailyBudgetCents} label={`${agent.name} spend today`} />
          <small>
            {usd(agent.spend.spentTodayCents)} of {usd(agent.policy.dailyBudgetCents)} today
          </small>
        </button>
      ))}
    </nav>
  );
}

export function App() {
  const { state, connection, refresh } = useLeashState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");

  if (!state) {
    return (
      <div className="loading">
        <Logo />
        <p>{connection === "offline" ? "Can't reach the Leash server. Retrying." : "Loading Leash"}</p>
      </div>
    );
  }

  const agent = state.agents.find((candidate) => candidate.id === selectedId) ?? state.agents[0];
  if (!agent) return <div className="loading">No agents are set up yet.</div>;

  const nameOf = (id: string) => state.agents.find((candidate) => candidate.id === id)?.name ?? id;
  const pending = (id: string) => state.approvals.filter((approval) => approval.agent_id === id).length;
  const agentEvents = state.events.filter((event) => event.agent_id === agent.id);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <div>
            <strong>Leash</strong>
            <span>Payment firewall for AI agents</span>
          </div>
        </div>
        <div className="topbar-status">
          <span className="pill">PayPal sandbox</span>
          <span className={`pill connection ${connection}`}>
            <i /> {CONNECTION_LABELS[connection]}
          </span>
        </div>
      </header>

      <div className="layout">
        <AgentRail agents={state.agents} selected={agent.id} pending={pending} onSelect={setSelectedId} />

        <main>
          <div className="tabs" role="tablist">
            {VIEWS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
                {label}
                {id === "overview" && state.approvals.length > 0 && <b>{state.approvals.length}</b>}
              </button>
            ))}
          </div>

          {view === "overview" && (
            <div className="overview">
              <div className="overview-main">
                {state.approvals.length > 0 && (
                  <section className="approvals" aria-label="Payments waiting for approval">
                    {state.approvals.map((approval) => (
                      <ApprovalCard key={approval.id} approval={approval} agentName={nameOf(approval.agent_id)} />
                    ))}
                  </section>
                )}
                <section className="panel">
                  <h2>Live timeline · {agent.name}</h2>
                  <Timeline events={agentEvents.slice(0, TIMELINE_LIMIT)} />
                  {agentEvents.length > TIMELINE_LIMIT && (
                    <button className="link" onClick={() => setView("audit")}>
                      See the full history in the audit log
                    </button>
                  )}
                </section>
              </div>
              <SpendPanel agent={agent} />
            </div>
          )}

          {view === "audit" && (
            <Suspense fallback={<p className="empty">Loading the audit log</p>}>
              <AuditGrid events={state.events} agents={state.agents} />
            </Suspense>
          )}

          {view === "policy" && <PolicyEditor agent={agent} aiEnabled={state.aiEnabled} onSaved={refresh} />}
        </main>
      </div>
    </div>
  );
}
