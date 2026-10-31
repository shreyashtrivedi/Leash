// Lets stdio agents reach a running Leash server. It holds only the agent's Leash key,
// so PayPal credentials are never in the agent's environment.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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

// Without this, an agent would wait forever for a reply that can never come.
function refuse(message: JSONRPCMessage, err: Error) {
  reportError(err);
  if ("id" in message && "method" in message) {
    const reason = `Could not reach Leash at ${url}. Check the server is running and LEASH_API_KEY is right. ${err.message}`;
    void agentSide.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: reason } });
  }
}

agentSide.onmessage = (message) => void leashSide.send(message).catch((err: Error) => refuse(message, err));
leashSide.onmessage = (message) => void agentSide.send(message).catch(reportError);
agentSide.onclose = () => process.exit(0);
leashSide.onerror = reportError;

await leashSide.start();
await agentSide.start();
