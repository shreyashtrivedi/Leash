import { useState } from "react";
import { resetDemo, startDemo } from "../api";
import type { DemoStatus } from "../api";

export function DemoPanel({ demo, waiting }: { demo: DemoStatus; waiting: boolean }) {
  const [error, setError] = useState<string | null>(null);

  if (!demo.available) return null;

  async function perform(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
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
            A general-purpose AI agent connects over MCP with one task: pay three bills. It has no PayPal credentials, and
            none of the rules are in its code. Leash decides each payment for real in the sandbox, and one will wait for you here.
          </p>
        </div>
        <div className="demo-actions">
          <button className="button primary" disabled={demo.running} onClick={() => perform(startDemo)}>
            {demo.running ? "Agent running" : "Run demo agent"}
          </button>
          <button
            className="button"
            disabled={demo.running}
            title="Restores the original rules and clears spending. The audit log keeps everything."
            onClick={() => perform(resetDemo)}
          >
            Reset demo
          </button>
        </div>
      </div>
      {demo.running && (
        <p className="demo-status" role="status">
          <i /> {waiting ? "The agent is waiting. Approve or reject the payment above." : "The agent is working. Each PayPal payment takes about 20 seconds."}
        </p>
      )}
      {demo.report && !demo.running && (
        <p className="ai-note">
          <span>What actually happened</span>
          {demo.report}
        </p>
      )}
      {(error ?? demo.error) && <p className="form-error">{error ?? demo.error}</p>}
    </section>
  );
}
