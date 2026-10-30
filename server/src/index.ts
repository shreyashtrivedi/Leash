import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { createPaymentService } from "./payments.js";
import { createPayPalClient } from "./paypal.js";
import { approvalRoutes, dashboardRoutes, mcpRoutes } from "./routes.js";
import { seed } from "./seed.js";

const db = openDb(config.dbPath);
seed(db);

const payments = createPaymentService(db, createPayPalClient(config.paypalClientId, config.paypalClientSecret));

const app = express();
app.use(express.json());
app.use(mcpRoutes(db, payments));
app.use(dashboardRoutes(db, payments));
app.use(approvalRoutes(payments));

const clientDist = fileURLToPath(new URL("../../client/dist", import.meta.url));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/.*/, (_req, res) => res.sendFile("index.html", { root: clientDist }));
}

app.listen(config.port, () => {
  console.log(`Leash is running on http://localhost:${config.port} (PayPal sandbox only)`);
});
