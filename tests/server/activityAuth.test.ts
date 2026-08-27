import express from "express";
import { createServer } from "http";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeBackend, resetActivityStateForTests } from "../../src/server/server";

const REAL_MODE_ENV = {
  NODE_ENV: "test",
  DISCORD_CLIENT_ID: "client-1",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "activity-test-session-secret-with-at-least-32-characters"
};

describe("Activity OAuth and instance verification", () => {
  afterEach(() => resetActivityStateForTests());

  it("rejects an authenticated Discord user outside the claimed instance", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "access", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.endsWith("/users/@me")) {
        return Response.json({ id: "user-1", username: "wizard" });
      }
      return Response.json({
        application_id: "client-1",
        instance_id: "instance-1",
        users: ["different-user"]
      });
    });
    const app = express();
    const server = createServer(app);
    const { io } = initializeBackend(app, server, {
      serveClient: false,
      env: REAL_MODE_ENV,
      fetchImpl: fetchImpl as typeof fetch
    });

    const response = await request(app)
      .post("/api/activity/auth/exchange")
      .send({ code: "single-use-code", instanceId: "instance-1" });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ACTIVITY_INSTANCE_MEMBERSHIP_REQUIRED");
    expect(response.headers["set-cookie"]).toBeUndefined();
    io.close();
  });
});
