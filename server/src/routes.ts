import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router } from "express";
import type { Db } from "./db.js";
import { findAgentByKey } from "./db.js";
import { createMcpServer } from "./mcp/tools.js";
import type { PaymentService } from "./payments.js";

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

export function approvalRoutes(payments: PaymentService): Router {
  const router = Router();

  router.get("/api/approvals", (_req, res) => {
    res.json(payments.listPendingApprovals());
  });

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
