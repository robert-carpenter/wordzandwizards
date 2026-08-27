import { describe, expect, it, vi } from "vitest";
import { bootstrapActivity, ActivityBootstrapError } from "../../src/activity/bootstrapActivity";
import type { ActivityPlatform } from "../../src/activity/activityPlatform";
import type {
  ActivityLayoutMode,
  ActivityParticipant,
  ActivityThermalState,
  ActivityUser
} from "../../src/activity/activityContext";

class FakePlatform implements ActivityPlatform {
  readonly instanceId = "instance-1";
  readonly channelId = "channel-1";
  readonly guildId = "guild-1";
  readonly calls: string[] = [];
  user: ActivityUser = { id: "user-1", username: "wizard", displayName: "Wizard" };
  participantListener?: (participants: ActivityParticipant[]) => void;
  layoutListener?: (layout: ActivityLayoutMode) => void;
  thermalListener?: (state: ActivityThermalState) => void;
  disposed = 0;

  async ready() { this.calls.push("ready"); }
  async authorize() { this.calls.push("authorize"); return "code-1"; }
  async authenticate() { this.calls.push("authenticate"); return this.user; }
  async getParticipants() { this.calls.push("participants"); return [this.user]; }
  async subscribeParticipants(listener: (participants: ActivityParticipant[]) => void) {
    this.calls.push("subscribe:participants");
    this.participantListener = listener;
    return async () => { this.disposed += 1; };
  }
  async subscribeLayout(listener: (layout: ActivityLayoutMode) => void) {
    this.calls.push("subscribe:layout");
    this.layoutListener = listener;
    return async () => { this.disposed += 1; };
  }
  async subscribeThermal(listener: (state: ActivityThermalState) => void) {
    this.calls.push("subscribe:thermal");
    this.thermalListener = listener;
    return async () => { this.disposed += 1; };
  }
  async openInviteDialog() {}
  async openExternalLink() {}
  close() {}
}

describe("bootstrapActivity", () => {
  it("authorizes, verifies, authenticates, subscribes, and cleans up", async () => {
    const platform = new FakePlatform();
    const onParticipants = vi.fn();
    const onLayout = vi.fn();
    const result = await bootstrapActivity({
      platform,
      exchange: async ({ code, instanceId }) => {
        expect(code).toBe("code-1");
        expect(instanceId).toBe("instance-1");
        return {
          accessToken: "access-1",
          expiresAt: Date.now() + 1000,
          user: platform.user
        };
      },
      onParticipants,
      onLayout
    });

    expect(result.context.user.id).toBe("user-1");
    expect(platform.calls.slice(0, 4)).toEqual(["ready", "authorize", "authenticate", "participants"]);
    expect(onParticipants).toHaveBeenCalledWith([platform.user]);
    platform.layoutListener?.("grid");
    expect(onLayout).toHaveBeenCalledWith("grid");

    await result.dispose();
    expect(platform.disposed).toBe(3);
  });

  it("rejects a Discord/server identity mismatch", async () => {
    const platform = new FakePlatform();
    await expect(
      bootstrapActivity({
        platform,
        exchange: async () => ({
          accessToken: "access-1",
          expiresAt: Date.now() + 1000,
          user: { id: "attacker", username: "attacker", displayName: "Attacker" }
        })
      })
    ).rejects.toMatchObject<ActivityBootstrapError>({ code: "USER_MISMATCH" });
  });

  it("classifies an SDK ready failure", async () => {
    const platform = new FakePlatform();
    platform.ready = async () => { throw new Error("no RPC"); };
    await expect(
      bootstrapActivity({ platform, exchange: vi.fn() })
    ).rejects.toMatchObject<ActivityBootstrapError>({ code: "SDK_READY" });
  });
});
