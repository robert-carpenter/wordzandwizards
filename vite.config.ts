import { defineConfig, loadEnv } from "vite";
import express from "express";
import { initializeBackend } from "./src/server/server";

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), "");
  const runtimeEnv = { ...fileEnv, ...process.env };
  const activityBackendEnabled =
    runtimeEnv.ACTIVITY_TEST_MODE === "true" ||
    ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_BOT_TOKEN", "SESSION_SECRET"].every(
      (name) => runtimeEnv[name]?.trim()
    );
  return {
    plugins: [
      {
        name: "spellcast-backend",
        apply: "serve",
        configureServer(server) {
          if (!activityBackendEnabled) {
            server.config.logger.info(
              "Activity backend disabled: serving the public landing-page preview only."
            );
            return;
          }
          let attached = false;
          const attachBackend = () => {
            if (attached || !server.httpServer) return;
            const backendApp = express();
            initializeBackend(backendApp, server.httpServer, {
              serveClient: false,
              env: runtimeEnv
            });
            server.middlewares.use(backendApp);
            attached = true;
          };
          attachBackend();
        }
      }
    ],
    server: {
      host: "0.0.0.0",
      port: 8900
    },
    build: {
      outDir: "dist/client"
    }
  };
});
