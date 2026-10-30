// Tries to dodge the limits by splitting $120 into five $24 payments, through real MCP.
// Sends real sandbox payments. Needs a running server.
// Run from server/: npx tsx scripts/split-attack-e2e.ts <verified-vendor-email>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.LEASH_BASE ?? "http://localhost:3000";
const KEY = process.env.LEASH_DEMO_AGENT_KEY ?? "leash-demo-key";
const vendor = process.argv[2];
if (!vendor) throw new Error("Usage: split-attack-e2e.ts <verified-vendor-email>");

const client = new Client({ name: "leash-split-attack", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
  }),
);

for (let attempt = 1; attempt <= 5; attempt++) {
  const result: any = await client.callTool(
    { name: "pay", arguments: { recipient: vendor, amount: "24.00", currency: "USD", category: "software" } },
    undefined,
    { timeout: 90_000 },
  );
  const { status, reason, paypal_transaction_id: transaction } = result.structuredContent;
  console.log(`$24 attempt ${attempt}: ${status} ${transaction ?? ""} | ${reason}`);
}

const state: any = await (await fetch(`${BASE}/api/state`)).json();
console.log("waiting for a human:", state.approvals.length, "| spent cents:", state.agents[0].spend.spentTodayCents);
process.exit(0);
