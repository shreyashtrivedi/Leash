import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router } from "express";
import type { Db } from "./db.js";
import { addAuditEvent, auditBus, findAgentByKey, getAgent, listAgents, listAuditEvents, saveAgentPolicy } from "./db.js";
import { createMcpServer } from "./mcp/tools.js";
import type { PaymentService } from "./payments.js";
import { policySchema } from "./policy/types.js";

export function mcpRoutes(db: Db, payments: PaymentService): Router {
  const router = Router();

  // Stateless: every request authenticates and gets its own server.
  router.post("/mcp", async (req, res) => {
    const key = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const agent = key ? findAgentByKey(db, key) : null;
    if (!agent) {
      res.status(401).json({ error: "A valid Leash API key is required." });
      return;
    }

    const server = createMcpServer(agent, payments);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  router.all("/mcp", (_req, res) => {
    res.status(405).json({ error: "Method not allowed." });
  });

  return router;
}

export function dashboardRoutes(db: Db, payments: PaymentService): Router {
  const router = Router();

  router.get("/api/state", (_req, res) => {
    res.json({
      agents: listAgents(db).map((agent) => ({ ...agent, spend: payments.spendSummary(agent) })),
      approvals: payments.listPendingApprovals(),
      events: listAuditEvents(db, 500),
    });
  });

  // Each audit write nudges connected dashboards, which then refetch the state.
  router.get("/api/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");

    const notify = () => res.write("data: changed\n\n");
    const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 25_000);
    auditBus.on("event", notify);
    req.on("close", () => {
      clearInterval(heartbeat);
      auditBus.off("event", notify);
    });
  });

  router.put("/api/agents/:id/policy", (req, res) => {
    const agent = getAgent(db, req.params.id);
    if (!agent) {
      res.status(404).json({ error: "No such agent." });
      return;
    }
    const parsed = policySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "That policy is not valid." });
      return;
    }
    saveAgentPolicy(db, agent.id, parsed.data);
    addAuditEvent(db, {
      agentId: agent.id,
      paymentId: null,
      type: "policy.updated",
      summary: `A human updated the policy for ${agent.name}`,
    });
    res.json(parsed.data);
  });

  return router;
}

export function approvalRoutes(payments: PaymentService): Router {
  const router = Router();

  for (const [action, approved] of [["approve", true], ["reject", false]] as const) {
    router.post(`/api/approvals/:id/${action}`, (req, res) => {
      const result = payments.resolveApproval(req.params.id, approved);
      if (!result) {
        res.status(409).json({ error: "This payment is not waiting for approval." });
        return;
      }
      res.json(result);
    });
  }

  return router;
}
