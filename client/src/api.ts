import { useCallback, useEffect, useRef, useState } from "react";

export interface Policy {
  perTransactionCapCents: number;
  autoApproveLimitCents: number;
  dailyBudgetCents: number;
  totalBudgetCents: number;
  allowedRecipients: string[] | null;
  blockedRecipients: string[];
  requireVerifiedRecipient: boolean;
  allowedCategories: string[] | null;
  blockedCategories: string[];
  maxPaymentsPerHour: number;
  allowedCurrencies: string[];
}

export interface Spend {
  spentTodayCents: number;
  spentTotalCents: number;
  paymentsLastHour: number;
  remainingTodayCents: number;
  remainingTotalCents: number;
}

export interface Agent {
  id: string;
  name: string;
  policy: Policy;
  spend: Spend;
}

export interface RuleResult {
  rule: string;
  passed: boolean;
  reason: string;
}

export interface Approval {
  id: string;
  agent_id: string;
  recipient: string;
  amount: string;
  currency: string;
  category: string;
  memo: string;
  explanation: string | null;
  created_at: string;
  rule_results: RuleResult[];
}

export interface AuditEvent {
  id: number;
  at: string;
  agent_id: string | null;
  payment_id: string | null;
  type: string;
  summary: string;
  sample: number;
  explanation: string | null;
}

export interface LeashState {
  agents: Agent[];
  approvals: Approval[];
  events: AuditEvent[];
  aiEnabled: boolean;
}

export interface PolicyDraft {
  policy: Policy;
  unchanged: string[];
  warnings: string[];
}

async function send(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

export const resolveApproval = (id: string, action: "approve" | "reject") =>
  send(`/api/approvals/${id}/${action}`, { method: "POST" });

export const savePolicy = (agentId: string, policy: Policy) =>
  send(`/api/agents/${agentId}/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(policy),
  });

export const draftPolicy = (agentId: string, text: string): Promise<PolicyDraft> =>
  send(`/api/agents/${agentId}/policy/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

export type Connection = "connecting" | "live" | "offline";

// Loads the state, then refetches whenever the server announces an audit event.
export function useLeashState() {
  const [state, setState] = useState<LeashState | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await send("/api/state"));
    } catch {
      setConnection("offline");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const stream = new EventSource("/api/stream");
    stream.onopen = () => {
      setConnection("live");
      void refresh();
    };
    stream.onerror = () => setConnection("offline");
    stream.onmessage = () => {
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        void refresh();
      }, 80);
    };
    return () => stream.close();
  }, [refresh]);

  return { state, connection, refresh };
}
