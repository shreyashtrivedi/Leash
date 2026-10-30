import { useState } from "react";
import { startDemo } from "../api";
import type { DemoStatus } from "../api";

export function DemoPanel({ demo }: { demo: DemoStatus }) {
  const [error, setError] = useState<string | null>(null);

  if (!demo.available) return null;

  async function start() {
    setError(null);
    try {
      await startDemo();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="panel demo">
      <div className="demo-head">
        <div>
          <h2>Try it with a real AI agent</h2>
          <p>
            An unmodified agent connects over MCP and tries to pay three bills. Leash decides each one with real sandbox
            payments, and one will wait for you here.
          </p>
        </div>
        <button className="button primary" disabled={demo.running} onClick={start}>
          {demo.running ? "Agent running" : "Run demo agent"}
        </button>
      </div>
      {demo.running && (
        <p className="demo-status" role="status">
          <i /> The agent is working. Each PayPal payment takes about 20 seconds.
        </p>
      )}
      {demo.report && !demo.running && (
        <p className="ai-note">
          <span>The agent's report</span>
          {demo.report}
        </p>
      )}
      {(error ?? demo.error) && <p className="form-error">{error ?? demo.error}</p>}
    </section>
  );
}
