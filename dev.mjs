// Runs the API server and the Vite dev server together.
import { spawn } from "node:child_process";

const shell = process.platform === "win32";
const run = (workspace) =>
  spawn("npm", ["run", "dev", "--workspace", workspace], { stdio: "inherit", shell });

const children = [run("server"), run("client")];
const stop = () => children.forEach((child) => child.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
children.forEach((child) => child.on("exit", stop));
