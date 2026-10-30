import { useCallback, useEffect, useRef, useState } from "react";

export interface Policy {
  perTransactionCapCents: number;
  autoApproveLimitCents: number;
  recipientWindowLimitCents: number;
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
  kind: "payment" | "refund" | "invoice";
  target: string | null;
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

export interface DemoStatus {
  available: boolean;
  running: boolean;
  report: string | null;
  error: string | null;
}

export interface LeashState {
  agents: Agent[];
  approvals: Approval[];
  events: AuditEvent[];
  aiEnabled: boolean;
  demo: DemoStatus;
  auditChain: { intact: boolean; events: number };
  auth: { required: boolean; hint: string };
}

export interface PolicyDraft {
  policy: Policy;
  unchanged: string[];
  warnings: string[];
}

const PASSWORD_KEY = "leash-dashboard-password";

function readPassword(): string {
  try {
    return sessionStorage.getItem(PASSWORD_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberPassword(value: string) {
  try {
    sessionStorage.setItem(PASSWORD_KEY, value);
  } catch {
    // Without storage, the password simply lasts until the page reloads.
  }
}

let password = readPassword();
let askForPassword: ((wrong: boolean) => Promise<string | null>) | null = null;

export function setPasswordPrompt(prompt: typeof askForPassword) {
  askForPassword = prompt;
}

async function send(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, {
    ...init,
    headers: { ...init?.headers, ...(password ? { "X-Leash-Password": password } : {}) },
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 401 && body.passwordRequired && askForPassword) {
    const entered = await askForPassword(password !== "");
    if (entered === null) throw new Error("The dashboard password is needed for that.");
    password = entered;
    rememberPassword(entered);
    return send(path, init);
  }

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

export const startDemo = () => send("/api/demo/run", { method: "POST" });

export const resetDemo = () => send("/api/demo/reset", { method: "POST" });

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
