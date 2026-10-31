import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { createAiClient } from "./ai/client.js";
import { createExplainer } from "./ai/explain.js";
import { config } from "./config.js";
import { addAuditEvent, auditBus, openDb, saveAgentPolicy } from "./db.js";
import { createDemoRunner, runDemoAgent } from "./demo/agent.js";
import { createPaymentService } from "./payments.js";
import { createPayPalClient } from "./paypal.js";
import { approvalRoutes, dashboardRoutes, errorHandler, mcpRoutes } from "./routes.js";
import { DEMO_AGENT_ID, demoPolicy, seed, SUPPORT_AGENT_ID, supportPolicy } from "./seed.js";

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
        payments.startFresh(DEMO_AGENT_ID, "Demo run started with a clean spending slate");
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
  () => {
    saveAgentPolicy(db, DEMO_AGENT_ID, demoPolicy);
    saveAgentPolicy(db, SUPPORT_AGENT_ID, supportPolicy);
    payments.startFresh(DEMO_AGENT_ID, "Demo reset: rules restored, and spending cleared");
  },
);

const auth = { password: config.dashboardPassword, hint: config.dashboardPasswordHint };
if (!auth.password) console.warn("DASHBOARD_PASSWORD is not set, so anyone who can reach this server can approve payments.");

setInterval(() => payments.expireApprovals(), 30_000).unref();

const app = express();
app.disable("x-powered-by");
app.use(express.json());
app.use(mcpRoutes(db, payments));
app.use(dashboardRoutes(db, payments, ai, demo, auth));
app.use(approvalRoutes(payments, auth));
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found." });
});

const clientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/.*/, (_req, res) => res.sendFile("index.html", { root: clientDist }));
}

app.use(errorHandler);

app.listen(config.port, (err) => {
  if (err) {
    console.error(`Leash could not start on port ${config.port}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Leash is running on http://localhost:${config.port} (PayPal sandbox only)`);
});
