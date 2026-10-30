import express from "express";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { createPaymentService } from "./payments.js";
import { createPayPalClient } from "./paypal.js";
import { approvalRoutes, mcpRoutes } from "./routes.js";
import { seed } from "./seed.js";

const db = openDb(config.dbPath);
seed(db);

const payments = createPaymentService(db, createPayPalClient(config.paypalClientId, config.paypalClientSecret));

const app = express();
app.use(express.json());
app.use(mcpRoutes(db, payments));
app.use(approvalRoutes(payments));

app.listen(config.port, () => {
  console.log(`Leash is running on http://localhost:${config.port} (PayPal sandbox only)`);
});
