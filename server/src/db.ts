import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import type { PaymentKind, Policy, RecipientRecord, RuleResult } from "./policy/types.js";

export type Db = Database.Database;

const FIRST_HASH = "leash-audit-log";

export type PaymentStatus =
  | "blocked"
  | "pending_approval"
  | "rejected"
  | "sending"
  | "executed"
  | "refunded"
  | "expired"
  | "failed";

export interface Agent {
  id: string;
  name: string;
  policy: Policy;
}

export interface AuditEvent {
  id: number;
  at: string;
  agent_id: string | null;
  payment_id: string | null;
  type: string;
  summary: string;
  sample: number;
  hash: string;
  explanation: string | null;
}

// Every audit write is announced here, which is what feeds the live timeline.
export const auditBus = new EventEmitter().setMaxListeners(0);

export interface PaymentRow {
  id: string;
  agent_id: string;
  kind: PaymentKind;
  target: string | null;
  recipient: string;
  amount: string;
  currency: string;
  amount_usd_cents: number | null;
  category: string;
  memo: string;
  status: PaymentStatus;
  rule_results: string;
  idempotency_key: string | null;
  payout_batch_id: string | null;
  payout_item_id: string | null;
  transaction_id: string | null;
  paypal_status: string | null;
  error: string | null;
  explanation: string | null;
  created_at: string;
  reserved_at: string | null;
  archived: number;
}

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key_hash TEXT NOT NULL UNIQUE,
      policy TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipients (
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      verified INTEGER NOT NULL,
      category TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      kind TEXT NOT NULL DEFAULT 'payment',
      target TEXT,
      recipient TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      amount_usd_cents INTEGER,
      category TEXT NOT NULL,
      memo TEXT NOT NULL,
      status TEXT NOT NULL,
      rule_results TEXT NOT NULL,
      idempotency_key TEXT,
      payout_batch_id TEXT,
      payout_item_id TEXT,
      transaction_id TEXT,
      paypal_status TEXT,
      error TEXT,
      explanation TEXT,
      created_at TEXT NOT NULL,
      reserved_at TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      UNIQUE (agent_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      agent_id TEXT,
      payment_id TEXT,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      sample INTEGER NOT NULL DEFAULT 0,
      hash TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'The audit log is append-only.'); END;
    CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
      BEGIN SELECT RAISE(ABORT, 'The audit log is append-only.'); END;
  `);
  return db;
}

export const hashApiKey = (key: string): string => createHash("sha256").update(key).digest("hex");

export function findAgentByKey(db: Db, key: string): Agent | null {
  const row = db.prepare("SELECT id FROM agents WHERE api_key_hash = ?").pluck().get(hashApiKey(key)) as string | undefined;
  return row ? getAgent(db, row) : null;
}

export function getAgent(db: Db, id: string): Agent | null {
  const row = db.prepare("SELECT id, name, policy FROM agents WHERE id = ?").get(id) as
    | { id: string; name: string; policy: string }
    | undefined;
  return row ? { id: row.id, name: row.name, policy: JSON.parse(row.policy) } : null;
}

export function saveAgent(db: Db, agent: Agent, apiKey: string): void {
  db.prepare(
    `INSERT INTO agents (id, name, api_key_hash, policy) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, api_key_hash = excluded.api_key_hash`,
  ).run(agent.id, agent.name, hashApiKey(apiKey), JSON.stringify(agent.policy));
}

export function saveRecipient(db: Db, email: string, name: string, record: RecipientRecord): void {
  db.prepare(
    `INSERT INTO recipients (email, name, verified, category) VALUES (?, ?, ?, ?)
     ON CONFLICT (email) DO UPDATE SET name = excluded.name, verified = excluded.verified, category = excluded.category`,
  ).run(email, name, record.verified ? 1 : 0, record.category);
}

export function getRecipient(db: Db, email: string): RecipientRecord | null {
  const row = db.prepare("SELECT verified, category FROM recipients WHERE email = ?").get(email) as
    | { verified: number; category: string }
    | undefined;
  return row ? { verified: row.verified === 1, category: row.category } : null;
}

export function listAgents(db: Db): Agent[] {
  const ids = db.prepare("SELECT id FROM agents ORDER BY rowid").pluck().all() as string[];
  return ids.map((id) => getAgent(db, id)!);
}

export function saveAgentPolicy(db: Db, id: string, policy: Policy): void {
  db.prepare("UPDATE agents SET policy = ? WHERE id = ?").run(JSON.stringify(policy), id);
}

const hashEvent = (previous: string, fields: unknown[]) =>
  createHash("sha256").update(JSON.stringify([previous, ...fields])).digest("hex");

// Each entry's hash covers the one before it, so editing history breaks the chain.
export function addAuditEvent(
  db: Db,
  event: { agentId: string | null; paymentId: string | null; type: string; summary: string; at?: string; sample?: boolean },
): void {
  const fields = [
    event.at ?? new Date().toISOString(),
    event.agentId,
    event.paymentId,
    event.type,
    event.summary,
    event.sample ? 1 : 0,
  ];
  const previous = db.prepare("SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1").pluck().get() as string | undefined;
  db.prepare("INSERT INTO audit_events (at, agent_id, payment_id, type, summary, sample, hash) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    ...fields,
    hashEvent(previous ?? FIRST_HASH, fields),
  );
  auditBus.emit("event");
}

// Detects edits and gaps. It can't stop someone rewriting the whole file and every hash.
export function verifyAuditChain(db: Db): { intact: boolean; events: number } {
  const rows = db.prepare("SELECT * FROM audit_events ORDER BY id").all() as AuditEvent[];
  let previous = FIRST_HASH;
  for (const row of rows) {
    const fields = [row.at, row.agent_id, row.payment_id, row.type, row.summary, row.sample];
    if (row.hash !== hashEvent(previous, fields)) return { intact: false, events: rows.length };
    previous = row.hash;
  }
  return { intact: true, events: rows.length };
}

export function listAuditEvents(db: Db, limit: number): AuditEvent[] {
  return db
    .prepare(
      `SELECT e.*, CASE WHEN e.type IN ('decision.deny', 'decision.require_approval') THEN p.explanation END AS explanation
       FROM audit_events e LEFT JOIN payments p ON p.id = e.payment_id
       ORDER BY e.at DESC, e.id DESC LIMIT ?`,
    )
    .all(limit) as AuditEvent[];
}

export const parseRuleResults = (row: PaymentRow): RuleResult[] => JSON.parse(row.rule_results);
