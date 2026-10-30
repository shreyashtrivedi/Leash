import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import type { AiClient } from "../ai/client.js";

const MAX_STEPS = 14;
const RUN_LIMIT_MS = 5 * 60_000;
const POLL_MS = 3000;
const TOOL_TIMEOUT_MS = 90_000;
const AI_ATTEMPTS = 4;
const AI_RETRY_MS = 12_000;

// A general purchasing agent. Nothing here knows Leash's rules: it learns its tools
// from the MCP server and its limits from the responses it gets back.
const SYSTEM = `You are an autonomous purchasing agent. You complete tasks by calling tools, one tool per step.
Reply with:
- thought: one short first-person sentence for a human reading your log
- tool: the tool to call, or "finish" when everything is handled
- arguments_json: the tool's arguments as a JSON string. For finish use {"report": "..."} with a short summary of what happened to each purchase.
Read every tool result carefully and adapt to it. Each purchase should be paid once.
Only use the tools listed.`;

const buildTask = (vendors: string[]) => {
  const vendor = (index: number) => vendors[index % vendors.length];
  return `Task: settle this month's team software bills. All are category "software", in USD.
1. Domain renewal: $12.00 to ${vendor(0)}.
2. Analytics tool: the finance team strongly prefers the annual plan, $120.00 to ${vendor(1)}, so attempt that payment first. Only if that attempt is refused, pay the monthly plan, $20.00 to the same vendor, instead.
3. Design tool licence: $30.00 to ${vendor(2)}. There is no cheaper option, so if this needs someone's sign-off, wait for it.`;
};

type ToolResult = Record<string, any>;

interface Tools {
  names: string[];
  describe: string;
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

async function connectTools(url: string, apiKey: string): Promise<Tools> {
  const client = new Client({ name: "leash-demo-agent", version: "0.1.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    }),
  );
  const { tools } = await client.listTools();

  return {
    names: tools.map((tool) => tool.name),
    describe: tools
      .map((tool) => `${tool.name}: ${tool.description}\nInput schema: ${JSON.stringify(tool.inputSchema)}`)
      .join("\n\n"),
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: TOOL_TIMEOUT_MS });
      return (result.structuredContent as ToolResult | undefined) ?? { status: "error", content: result.content };
    },
    close: () => client.close(),
  };
}

async function withRetries<T>(attempt: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (err) {
      if (tries >= AI_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, AI_RETRY_MS));
    }
  }
}

export interface DemoAgentOptions {
  ai: AiClient;
  mcpUrl: string;
  apiKey: string;
  vendors: string[];
  onThought: (thought: string) => void;
  pollMs?: number;
}

// Returns the agent's own report once it finishes.
export async function runDemoAgent(options: DemoAgentOptions): Promise<string> {
  const { ai, mcpUrl, apiKey, vendors, onThought } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const tools = await connectTools(mcpUrl, apiKey);
  const deadline = Date.now() + RUN_LIMIT_MS;

  const stepSchema = z.object({
    thought: z.string(),
    tool: z.enum([...tools.names, "finish"]),
    arguments_json: z.string(),
  });

  // Waiting is done here rather than by the model, so polling a human spends no AI quota.
  async function settle(result: ToolResult): Promise<ToolResult> {
    let latest = result;
    const id = result.approval_id ?? result.payment_id;
    while (["pending_approval", "processing"].includes(latest.status) && id && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      latest = await tools.call("check_approval", { approval_id: id });
    }
    return latest;
  }

  try {
    const transcript = [`Tools:\n${tools.describe}`, buildTask(vendors)];

    for (let step = 0; step < MAX_STEPS && Date.now() < deadline; step++) {
      const next = await withRetries(() =>
        ai.completeJson({ system: SYSTEM, prompt: transcript.join("\n\n"), schema: stepSchema }),
      );
      onThought(next.thought);

      let args: Record<string, any>;
      try {
        args = JSON.parse(next.arguments_json);
      } catch {
        transcript.push(`Your arguments_json was not valid JSON: ${next.arguments_json}`);
        continue;
      }

      if (next.tool === "finish") return String(args.report ?? next.thought);

      const result = await settle(await tools.call(next.tool, args));
      transcript.push(`Step ${step + 1}: you called ${next.tool} with ${JSON.stringify(args)}.\nResult: ${JSON.stringify(result)}`);
    }
    return "The agent stopped before finishing every purchase.";
  } finally {
    await tools.close();
  }
}

export interface DemoStatus {
  available: boolean;
  running: boolean;
  report: string | null;
  error: string | null;
}

// Only one run at a time, because each run spends real AI quota and sandbox balance.
export function createDemoRunner(run: (() => Promise<string>) | null, onChange: () => void) {
  const status: DemoStatus = { available: run !== null, running: false, report: null, error: null };

  return {
    status: () => status,
    start(): boolean {
      if (!run || status.running) return false;
      Object.assign(status, { running: true, report: null, error: null });
      onChange();
      run()
        .then((report) => Object.assign(status, { report }))
        .catch((err) => {
          console.error(`Demo agent failed: ${(err as Error).message}`);
          Object.assign(status, { error: "The demo agent could not finish. Try again in a minute." });
        })
        .finally(() => {
          status.running = false;
          onChange();
        });
      return true;
    },
  };
}
