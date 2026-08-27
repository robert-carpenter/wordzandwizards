import express from "express";
import { createServer, type Server as HttpServer } from "http";
import request, { type SuperAgentTest } from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeBackend, resetActivityStateForTests, resolveActivityConfig } from "../../src/server/server";

const TEST_ENV = {
  NODE_ENV: "test",
  ACTIVITY_TEST_MODE: "true",
  SESSION_SECRET: "activity-test-session-secret-with-at-least-32-characters"
};

describe("Activity server", () => {
  let server: HttpServer;
  let host: SuperAgentTest;

  beforeEach(() => {
    resetActivityStateForTests();
    const app = express();
    server = createServer(app);
    initializeBackend(app, server, { serveClient: false, env: TEST_ENV });
    host = request.agent(app);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    resetActivityStateForTests();
  });

  it("requires a verified Activity session", async () => {
    const response = await request(server).post("/api/activity/room/join");
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("ACTIVITY_SESSION_REQUIRED");
  });

  it("rejects unapproved browser origins", async () => {
    const response = await request(server)
      .get("/api/health")
      .set("Origin", "https://attacker.example");
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("ORIGIN_REJECTED");
  });

  it("creates and resumes one room per instance using the verified user", async () => {
    const avatar = "https://cdn.discordapp.com/embed/avatars/0.png";
    await authenticate(host, "user-1", "Host Wizard", "instance-1", avatar);
    const first = await host.post("/api/activity/room/join").send({ name: "Spoofed" });
    expect(first.status).toBe(201);
    expect(first.body.room.id).toBe("instance-1");
    expect(first.body.player).toMatchObject({
      id: "user-1",
      name: "Host Wizard",
      avatar,
      isHost: true
    });

    const second = await host.post("/api/activity/room/join");
    expect(second.status).toBe(200);
    expect(second.body.room.players).toHaveLength(1);
  });

  it("isolates instances and ignores client-supplied actor IDs", async () => {
    const guest = request.agent(server);
    const outsider = request.agent(server);
    await authenticate(host, "host", "Host", "shared-instance");
    await host.post("/api/activity/room/join");
    await authenticate(guest, "guest", "Guest", "shared-instance");
    await guest.post("/api/activity/room/join");
    await authenticate(outsider, "outsider", "Outsider", "other-instance");
    await outsider.post("/api/activity/room/join");

    const forbidden = await guest
      .patch("/api/activity/room/settings")
      .send({ rounds: 3, playerId: "host" });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe("PERMISSION_DENIED");

    const updated = await host.patch("/api/activity/room/settings").send({ rounds: 3 });
    expect(updated.status).toBe(200);
    expect(updated.body.room.rounds).toBe(3);

    const otherRoom = await outsider.get("/api/activity/room");
    expect(otherRoom.body.room.players.map((player: { id: string }) => player.id)).toEqual(["outsider"]);
  });

  it("transfers host and supports host-only removal", async () => {
    const guest = request.agent(server);
    await authenticate(host, "host", "Host", "instance-1");
    await host.post("/api/activity/room/join");
    await authenticate(guest, "guest", "Guest", "instance-1");
    await guest.post("/api/activity/room/join");

    const selfKick = await host.delete("/api/activity/room/players/host");
    expect(selfKick.status).toBe(400);
    const leave = await host.post("/api/activity/room/leave");
    expect(leave.status).toBe(204);
    const room = await guest.get("/api/activity/room");
    expect(room.body.room.hostId).toBe("guest");
    expect(room.body.room.players[0].isHost).toBe(true);
  });

  it("rejects replayed test authorization codes", async () => {
    const code = testCode("user-1", "Wizard", "instance-1", "fixed-nonce");
    const first = await host.post("/api/activity/auth/exchange").send({ code, instanceId: "instance-1" });
    const replay = await request(server)
      .post("/api/activity/auth/exchange")
      .send({ code, instanceId: "instance-1" });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe("AUTH_CODE_REPLAYED");
  });
});

describe("Activity configuration", () => {
  it("refuses test mode in production", () => {
    expect(() =>
      resolveActivityConfig({ ...TEST_ENV, NODE_ENV: "production" })
    ).toThrow(/must never be enabled/i);
  });

  it("requires all production secrets", () => {
    expect(() => resolveActivityConfig({ NODE_ENV: "production" })).toThrow(/Missing Activity configuration/);
  });
});

async function authenticate(
  agent: SuperAgentTest,
  userId: string,
  name: string,
  instanceId: string,
  avatar?: string
) {
  const response = await agent
    .post("/api/activity/auth/exchange")
    .send({
      code: testCode(userId, name, instanceId, `${userId}-${Date.now()}-${Math.random()}`, avatar),
      instanceId
    });
  expect(response.status).toBe(200);
}

function testCode(userId: string, name: string, instanceId: string, nonce: string, avatar?: string): string {
  const payload = {
    id: userId,
    username: userId,
    name,
    avatar,
    instanceId,
    state: "test-state",
    nonce
  };
  return `activity-test.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}
