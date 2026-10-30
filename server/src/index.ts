import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { createAiClient } from "./ai/client.js";
import { createExplainer } from "./ai/explain.js";
import { config } from "./config.js";
import { addAuditEvent, auditBus, openDb } from "./db.js";
import { createDemoRunner, runDemoAgent } from "./demo/agent.js";
import { createPaymentService } from "./payments.js";
import { createPayPalClient } from "./paypal.js";
import { approvalRoutes, dashboardRoutes, mcpRoutes } from "./routes.js";
import { DEMO_AGENT_ID, seed } from "./seed.js";

const db = openDb(config.dbPath);
seed(db);

const ai = createAiClient();
const payments = createPaymentService(db, createPayPalClient(config.paypalClientId, config.paypalClientSecret), {
  explain: ai ? createExplainer(ai) : null,
});

const noteFromAgent = (type: string, summary: string) =>
  addAuditEvent(db, { agentId: DEMO_AGENT_ID, paymentId: null, type, summary });

const demo = createDemoRunner(
  ai && config.demoVendorEmails.length > 0
    ? async () => {
        const report = await runDemoAgent({
          ai,
          mcpUrl: `http://localhost:${config.port}/mcp`,
          apiKey: config.demoAgentKey,
          vendors: config.demoVendorEmails,
          onThought: (thought) => noteFromAgent("agent.note", thought),
        });
        noteFromAgent("agent.report", report);
        return report;
      }
    : null,
  () => auditBus.emit("event"),
);

const app = express();
app.use(express.json());
app.use(mcpRoutes(db, payments));
app.use(dashboardRoutes(db, payments, ai, demo));
app.use(approvalRoutes(payments));

const clientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/.*/, (_req, res) => res.sendFile("index.html", { root: clientDist }));
}

app.listen(config.port, () => {
  console.log(`Leash is running on http://localhost:${config.port} (PayPal sandbox only)`);
});
