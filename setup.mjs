// One-command setup: creates .env if needed, installs dependencies and builds the dashboard.
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";

if (!existsSync(".env")) {
  copyFileSync(".env.example", ".env");
  console.log("Created .env from .env.example. Add your sandbox credentials before starting Leash.");
}

execSync("npm install", { stdio: "inherit" });
execSync("npm run build", { stdio: "inherit" });

console.log("\nSetup complete. Run: npm run dev");
