import { describe, expect, it, vi } from "vitest";
import { DiscordApi, DiscordApiError } from "../../src/server/discordApi";

describe("DiscordApi", () => {
  it("exchanges a code and verifies user plus Activity instance", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "access", token_type: "Bearer", expires_in: 3600 });
      }
      if (url.endsWith("/users/@me")) {
        return Response.json({ id: "user-1", username: "wizard", global_name: "Wizard" });
      }
      return Response.json({ application_id: "client-1", instance_id: "instance-1", users: ["user-1"] });
    });
    const api = new DiscordApi({
      clientId: "client-1",
      clientSecret: "secret",
      botToken: "bot",
      fetchImpl: fetchImpl as typeof fetch
    });
    const token = await api.exchangeCode("code");
    expect((await api.getCurrentUser(token)).id).toBe("user-1");
    expect((await api.getActivityInstance("instance-1")).users).toContain("user-1");
  });

  it("redacts Discord rejection details", async () => {
    const api = new DiscordApi({
      clientId: "client-1",
      clientSecret: "secret",
      botToken: "bot",
      fetchImpl: vi.fn(async () => new Response("sensitive upstream body", { status: 401 })) as typeof fetch
    });
    await expect(api.exchangeCode("secret-code")).rejects.toMatchObject<DiscordApiError>({
      code: "DISCORD_API_REJECTED",
      message: "Discord rejected the request."
    });
  });
});
