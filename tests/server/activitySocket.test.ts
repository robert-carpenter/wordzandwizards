import express from "express";
import { createServer } from "http";
import { io as createClient, type Socket } from "socket.io-client";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { initializeBackend, resetActivityStateForTests } from "../../src/server/server";

const TEST_ENV = {
  NODE_ENV: "test",
  ACTIVITY_TEST_MODE: "true",
  SESSION_SECRET: "activity-test-session-secret-with-at-least-32-characters"
};

describe("Activity Socket.IO authentication", () => {
  let client: Socket | undefined;
  let httpServer: ReturnType<typeof createServer> | undefined;
  let ioServer: ReturnType<typeof initializeBackend>["io"] | undefined;

  afterEach(async () => {
    client?.disconnect();
    ioServer?.close();
    if (httpServer?.listening) {
      await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
    }
    resetActivityStateForTests();
  });

  it("rejects unauthenticated sockets and derives room/user from the session cookie", async () => {
    resetActivityStateForTests();
    const app = express();
    httpServer = createServer(app);
    const initialized = initializeBackend(app, httpServer, { serveClient: false, env: TEST_ENV });
    ioServer = initialized.io;
    await new Promise<void>((resolve) => httpServer?.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address.");
    const url = `http://127.0.0.1:${address.port}`;

    const unauthenticated = createClient(url, { transports: ["websocket"], forceNew: true });
    const authError = await new Promise<Error>((resolve) => {
      unauthenticated.once("connect_error", resolve);
    });
    expect(authError.message).toBe("ACTIVITY_SESSION_REQUIRED");
    unauthenticated.disconnect();

    const auth = await request(httpServer)
      .post("/api/activity/auth/exchange")
      .send({
        code: testCode("socket-user", "Socket Wizard", "socket-instance"),
        instanceId: "socket-instance"
      });
    expect(auth.status).toBe(200);
    const cookie = String(auth.headers["set-cookie"]?.[0] ?? "").split(";")[0];
    expect(cookie).toContain("words_activity_session=");
    const join = await request(httpServer)
      .post("/api/activity/room/join")
      .set("Cookie", cookie);
    expect(join.status).toBe(201);

    client = createClient(url, {
      transports: ["websocket"],
      forceNew: true,
      extraHeaders: { Cookie: cookie }
    });
    const room = await new Promise<{ id: string; players: Array<{ id: string }> }>((resolve, reject) => {
      client?.once("room:update", resolve);
      client?.once("connect_error", reject);
    });
    expect(room.id).toBe("socket-instance");
    expect(room.players.map((player) => player.id)).toEqual(["socket-user"]);
  });
});

function testCode(userId: string, name: string, instanceId: string): string {
  return `activity-test.${Buffer.from(
    JSON.stringify({
      id: userId,
      username: userId,
      name,
      instanceId,
      state: "socket-state",
      nonce: `${Date.now()}-${Math.random()}`
    })
  ).toString("base64url")}`;
}
