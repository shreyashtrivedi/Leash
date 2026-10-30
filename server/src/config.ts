import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

// Leash must never touch real money, so anything but an explicit "sandbox" stops startup.
if (process.env.PAYPAL_ENV !== "sandbox") {
  throw new Error(`Refusing to start: PAYPAL_ENV must be "sandbox", got "${process.env.PAYPAL_ENV ?? ""}".`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  paypalClientId: required("PAYPAL_CLIENT_ID"),
  paypalClientSecret: required("PAYPAL_CLIENT_SECRET"),
  aiProvider: process.env.AI_PROVIDER || "gemini",
  aiApiKey: process.env.AI_API_KEY ?? "",
  aiModel: process.env.AI_MODEL || "gemini-3.5-flash-lite",
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.LEASH_DB ?? fileURLToPath(new URL("../leash.db", import.meta.url)),
  demoAgentKey: process.env.LEASH_DEMO_AGENT_KEY ?? "leash-demo-key",
  demoVendorEmails: (process.env.DEMO_VENDOR_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
};
