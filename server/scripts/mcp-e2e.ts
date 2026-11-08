// Drives a running Leash server with the real MCP client, over both transports.
// Needs `npm run dev` running. Sends real sandbox payments.
// Run: npx tsx server/scripts/mcp-e2e.ts <verified-vendor-email>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";

const BASE = process.env.LEASH_BASE ?? "http://localhost:3000";
const KEY = process.env.LEASH_DEMO_AGENT_KEY ?? "leash-demo-key";
const vendor = process.argv[2];
if (!vendor) throw new Error("Usage: mcp-e2e.ts <verified-vendor-email>");

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  return result.structuredContent ?? result;
};

const payment = (amount: string) => ({ recipient: vendor, amount, currency: "USD", category: "software", memo: "Leash MCP test" });

async function run(label: string, client: Client) {
  await client.connect(
    label === "http"
      ? new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
        })
      : new StdioClientTransport({
          command: process.execPath,
          args: ["--import", "tsx", fileURLToPath(new URL("../src/mcp/stdio-bridge.ts", import.meta.url))],
          // Deliberately no PayPal variables: the agent side must work without them.
          env: { LEASH_URL: `${BASE}/mcp`, LEASH_API_KEY: KEY, PATH: process.env.PATH ?? "" },
          cwd: fileURLToPath(new URL("..", import.meta.url)),
        }),
  );
  const { tools } = await client.listTools();
  console.log(`[${label}] tools:`, tools.map((tool) => tool.name).join(", "));

  console.log(`[${label}] spend summary:`, await call(client, "get_spend_summary", {}));
  console.log(`[${label}] small payment:`, await call(client, "pay", payment("1.10")));
  console.log(`[${label}] over cap:`, await call(client, "pay", payment("120.00")));
  console.log(`[${label}] unverified recipient:`, await call(client, "pay", {
    recipient: "billing@luckyspin-casino.example.com", amount: "5.00", currency: "USD", category: "software",
  }));

  const held = await call(client, "pay", payment("30.00"));
  console.log(`[${label}] above auto-approve:`, held);
  console.log(`[${label}] before approval:`, (await call(client, "check_approval", { approval_id: held.approval_id })).status);

  const approve = await fetch(`${BASE}/api/approvals/${held.approval_id}/approve`, { method: "POST" });
  console.log(`[${label}] human approves: HTTP ${approve.status}`);
  const again = await fetch(`${BASE}/api/approvals/${held.approval_id}/approve`, { method: "POST" });
  console.log(`[${label}] second approve: HTTP ${again.status}`);

  let status = await call(client, "check_approval", { approval_id: held.approval_id });
  for (let i = 0; i < 45 && status.status === "processing"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    status = await call(client, "check_approval", { approval_id: held.approval_id });
  }
  console.log(`[${label}] after approval:`, status);
  await client.close();
}

const bad = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
console.log("no API key: HTTP", bad.status);

await run("http", new Client({ name: "leash-e2e", version: "0.1.0" }));
await run("stdio", new Client({ name: "leash-e2e", version: "0.1.0" }));
process.exit(0);
