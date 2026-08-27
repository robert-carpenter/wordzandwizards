import type {
  ActivityLayoutMode,
  ActivityParticipant,
  ActivityThermalState,
  ActivityUser
} from "./activityContext";
import type { ActivityPlatform } from "./activityPlatform";

export class TestActivityPlatform implements ActivityPlatform {
  readonly instanceId: string;
  readonly channelId = "activity-test-channel";
  readonly guildId = "activity-test-guild";
  private readonly user: ActivityUser;

  constructor(search = window.location.search) {
    if (!import.meta.env.DEV || import.meta.env.VITE_ACTIVITY_TEST_MODE !== "true") {
      throw new Error("The Activity test harness is disabled.");
    }
    const params = new URLSearchParams(search);
    const id = sanitizeId(params.get("user")) || "activity-test-user-1";
    const displayName = sanitizeName(params.get("name")) || "Test Wizard";
    const avatar = sanitizeAvatar(params.get("avatar"));
    this.instanceId = sanitizeId(params.get("instance")) || "activity-test-instance-1";
    this.user = { id, username: id, displayName, avatar };
  }

  async ready(): Promise<void> {}

  async authorize(state: string): Promise<string> {
    const payload = {
      id: this.user.id,
      username: this.user.username,
      name: this.user.displayName,
      avatar: this.user.avatar,
      instanceId: this.instanceId,
      state,
      nonce: crypto.randomUUID()
    };
    return `activity-test.${toBase64Url(JSON.stringify(payload))}`;
  }

  async authenticate(accessToken: string): Promise<ActivityUser> {
    if (!accessToken.startsWith("activity-test-access.")) {
      throw new Error("The Activity test access token was rejected.");
    }
    return this.user;
  }

  async getParticipants(): Promise<ActivityParticipant[]> {
    return [this.user];
  }

  async subscribeParticipants(
    listener: (participants: ActivityParticipant[]) => void
  ): Promise<() => Promise<void>> {
    listener([this.user]);
    return async () => undefined;
  }

  async subscribeLayout(
    listener: (layout: ActivityLayoutMode) => void
  ): Promise<() => Promise<void>> {
    listener("focused");
    return async () => undefined;
  }

  async subscribeThermal(
    listener: (state: ActivityThermalState) => void
  ): Promise<() => Promise<void>> {
    listener("nominal");
    return async () => undefined;
  }

  async openInviteDialog(): Promise<void> {
    const url = new URL(window.location.href);
    url.searchParams.set("instance", this.instanceId);
    await navigator.clipboard?.writeText(url.toString()).catch(() => undefined);
    window.dispatchEvent(new CustomEvent("activity:test-invite", { detail: { url: url.toString() } }));
  }

  async openExternalLink(url: string): Promise<void> {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  close(): void {
    window.dispatchEvent(new CustomEvent("activity:test-close"));
  }
}

function sanitizeId(value: string | null): string {
  return (value ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function sanitizeName(value: string | null): string {
  return (value ?? "").trim().slice(0, 32);
}

function sanitizeAvatar(value: string | null): string | undefined {
  if (!value || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
