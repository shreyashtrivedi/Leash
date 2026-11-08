// Drives refund and create_invoice through real MCP against a running server.
// Sends real sandbox transactions.
// Run from server/: npx tsx scripts/mcp-refund-e2e.ts <verified-vendor-email> <small-capture-id> <held-capture-id>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.LEASH_BASE ?? "http://localhost:3000";
const KEY = process.env.LEASH_DEMO_AGENT_KEY ?? "leash-demo-key";
const [vendor, smallCapture, heldCapture] = process.argv.slice(2);
if (!vendor || !smallCapture || !heldCapture) throw new Error("Usage: mcp-refund-e2e.ts <vendor> <capture> <capture>");

const client = new Client({ name: "leash-refund-e2e", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
  }),
);

const call = async (name: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  return result.structuredContent ?? result;
};
const show = (label: string, result: any) =>
  console.log(label.padEnd(34), result.status, "|", result.paypal_refund_id ?? result.paypal_invoice_id ?? result.paypal_transaction_id ?? "", "|", result.reason ?? "");

async function approveAndWait(id: string) {
  const res = await fetch(`${BASE}/api/approvals/${id}/approve`, { method: "POST" });
  let status = await call("check_approval", { approval_id: id });
  for (let i = 0; i < 20 && status.status === "processing"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    status = await call("check_approval", { approval_id: id });
  }
  return { ...status, httpApprove: res.status };
}

console.log("tools:", (await client.listTools()).tools.map((tool) => tool.name).join(", "));

show("full refund under limit", await call("refund", { capture_id: smallCapture, reason: "Item arrived damaged" }));
show("same capture refunded again", await call("refund", { capture_id: smallCapture }));
show("unknown capture", await call("refund", { capture_id: "NOPE123" }));
show("neither id given", await call("refund", {}));

const held = await call("refund", { capture_id: heldCapture });
show("refund over auto-approve", held);
show("after approval", await approveAndWait(held.approval_id));

const paid = await call("pay", { recipient: vendor, amount: "1.05", currency: "USD", category: "software" });
show("claimed payout sent", paid);
show("reverse claimed payout", await call("refund", { payment_id: paid.payment_id }));

show("invoice under limit", await call("create_invoice", {
  recipient: vendor, amount: "10.00", currency: "USD", description: "Consulting, October", category: "consulting",
}));
show("invoice over cap", await call("create_invoice", {
  recipient: vendor, amount: "120.00", currency: "USD", description: "Annual retainer", category: "consulting",
}));
show("invoice blocked category", await call("create_invoice", {
  recipient: vendor, amount: "5.00", currency: "USD", description: "Chips", category: "gambling",
}));
const heldInvoice = await call("create_invoice", {
  recipient: vendor, amount: "30.00", currency: "USD", description: "Workshop", category: "consulting",
});
show("invoice over auto-approve", heldInvoice);
show("after approval", await approveAndWait(heldInvoice.approval_id));

// Exercises the honest failure path. The policy normally refuses unknown recipients.
const state: any = await (await fetch(`${BASE}/api/state`)).json();
const policy = state.agents[0].policy;
const put = (body: unknown) =>
  fetch(`${BASE}/api/agents/${state.agents[0].id}/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
await put({ ...policy, requireVerifiedRecipient: false });
const unclaimed = await call("pay", {
  recipient: `leash-unclaimed-${Date.now()}@example.com`, amount: "1.15", currency: "USD", category: "software",
});
show("unclaimed payout sent", unclaimed);
await new Promise((resolve) => setTimeout(resolve, 15_000));
show("reverse unclaimed payout", await call("refund", { payment_id: unclaimed.payment_id }));
await put(policy);

const after: any = await (await fetch(`${BASE}/api/state`)).json();
console.log("audit chain:", after.auditChain, "| spent today cents:", after.agents[0].spend.spentTodayCents);
const counts: Record<string, number> = {};
for (const event of after.events.filter((event: any) => !event.sample)) counts[event.type] = (counts[event.type] ?? 0) + 1;
console.log(counts);
process.exit(0);
