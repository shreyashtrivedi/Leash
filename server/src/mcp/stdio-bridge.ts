// Lets stdio agents reach a running Leash server. It holds only the agent's Leash key,
// so PayPal credentials are never in the agent's environment.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const url = process.env.LEASH_URL ?? "http://localhost:3000/mcp";
const apiKey = process.env.LEASH_API_KEY;
if (!apiKey) {
  console.error("LEASH_API_KEY is required.");
  process.exit(1);
}

const agentSide = new StdioServerTransport();
const leashSide = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
});

const reportError = (err: Error) => console.error(`Leash bridge error: ${err.message}`);
agentSide.onmessage = (message) => void leashSide.send(message).catch(reportError);
leashSide.onmessage = (message) => void agentSide.send(message).catch(reportError);
agentSide.onclose = () => process.exit(0);
leashSide.onerror = reportError;

await leashSide.start();
await agentSide.start();
