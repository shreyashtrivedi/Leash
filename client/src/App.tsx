import { lazy, Suspense, useEffect, useState } from "react";
import { setPasswordPrompt, useLeashState } from "./api";
import type { Connection } from "./api";
import { ApprovalCard } from "./components/ApprovalCard";
import { GateHero } from "./components/GateHero";
import { Ledger } from "./components/Ledger";
import { PasswordDialog } from "./components/PasswordDialog";
import { PolicyEditor } from "./components/PolicyEditor";
import { SpendPanel } from "./components/SpendPanel";
import { buildLedger, currentRun } from "./ledger";

const AuditGrid = lazy(() => import("./components/AuditGrid"));

type View = "overview" | "audit" | "policy";

const LEDGER_LIMIT = 40;

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
    <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--forest)" />
      <circle cx="11.5" cy="20.5" r="5.5" fill="none" stroke="var(--mint)" strokeWidth="2.6" />
      <path
        d="M15.6 16.6C20 13 17.6 8.8 22.4 7.8"
        fill="none"
        stroke="var(--paper)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      <circle cx="24.4" cy="7.4" r="2.5" fill="var(--paper)" />
    </svg>
  );
}

export function App() {
  const { state, connection, refresh } = useLeashState();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [passwordRequest, setPasswordRequest] = useState<{
    wrong: boolean;
    resolve: (password: string | null) => void;
  } | null>(null);

  useEffect(() => {
    setPasswordPrompt((wrong) => new Promise((resolve) => setPasswordRequest({ wrong, resolve })));
    return () => setPasswordPrompt(null);
  }, []);

  function answerPassword(password: string | null) {
    passwordRequest?.resolve(password);
    setPasswordRequest(null);
  }

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
  const { entries, samples } = buildLedger(state.events.filter((event) => event.agent_id === agent.id));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <strong>Leash</strong>
        </div>

        <nav className="agents" aria-label="Agents">
          {state.agents.map((candidate) => (
            <button
              key={candidate.id}
              className={candidate.id === agent.id ? "active" : ""}
              aria-current={candidate.id === agent.id}
              onClick={() => setSelectedId(candidate.id)}
            >
              {candidate.name}
              {pending(candidate.id) > 0 && <b>{pending(candidate.id)}</b>}
            </button>
          ))}
        </nav>

        <div className="tabs" role="tablist">
          {VIEWS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={view === id} className={view === id ? "active" : ""} onClick={() => setView(id)}>
              {label}
            </button>
          ))}
        </div>

        <div className="topbar-status">
          <span className="pill">PayPal sandbox</span>
          <span className={`pill connection ${connection}`}>
            <i /> {CONNECTION_LABELS[connection]}
          </span>
        </div>
      </header>

      <main className="page">
        {view === "overview" && (
          <>
            <GateHero agentName={agent.name} run={currentRun(entries)} demo={state.demo} waiting={state.approvals.length > 0} />
            <div className="overview">
              <div className="overview-main">
                {state.approvals.length > 0 && (
                  <section className="approvals" aria-label="Payments waiting for approval">
                    {state.approvals.map((approval) => (
                      <ApprovalCard key={approval.id} approval={approval} agentName={nameOf(approval.agent_id)} />
                    ))}
                  </section>
                )}
                <Ledger entries={entries} samples={samples} limit={LEDGER_LIMIT} onSeeAll={() => setView("audit")} />
              </div>
              <SpendPanel agent={agent} />
            </div>
          </>
        )}

        {view === "audit" && (
          <Suspense fallback={<p className="empty">Loading the audit log</p>}>
            <AuditGrid events={state.events} agents={state.agents} chain={state.auditChain} />
          </Suspense>
        )}

        {view === "policy" && <PolicyEditor agent={agent} aiEnabled={state.aiEnabled} onSaved={refresh} />}
      </main>

      {passwordRequest && (
        <PasswordDialog
          wrong={passwordRequest.wrong}
          hint={state.auth.hint}
          onSubmit={answerPassword}
          onCancel={() => answerPassword(null)}
        />
      )}
    </div>
  );
}
