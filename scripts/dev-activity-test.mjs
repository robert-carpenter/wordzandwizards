import { randomBytes } from "crypto";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

if (process.env.NODE_ENV === "production") {
  throw new Error("The Activity test harness cannot run in production.");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const viteBin = path.resolve(scriptDir, "../node_modules/vite/bin/vite.js");
const child = spawn(process.execPath, [viteBin, ...process.argv.slice(2)], {
  cwd: path.resolve(scriptDir, ".."),
  env: {
    ...process.env,
    NODE_ENV: "development",
    VITE_ACTIVITY_TEST_MODE: "true",
    ACTIVITY_TEST_MODE: "true",
    SESSION_SECRET: randomBytes(48).toString("base64url")
  },
  stdio: "inherit",
  windowsHide: true
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? 1;
});
