import {
  DiscordSDK,
  Events,
  RPCCloseCodes,
  type EventPayloadData
} from "@discord/embedded-app-sdk";
import type {
  ActivityLayoutMode,
  ActivityParticipant,
  ActivityThermalState,
  ActivityUser
} from "./activityContext";
import type { ActivityPlatform } from "./activityPlatform";

type ParticipantPayload = EventPayloadData<Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE>;
type LayoutPayload = EventPayloadData<Events.ACTIVITY_LAYOUT_MODE_UPDATE>;
type ThermalPayload = EventPayloadData<Events.THERMAL_STATE_UPDATE>;

export class DiscordActivityPlatform implements ActivityPlatform {
  private readonly sdk: DiscordSDK;

  constructor(private readonly clientId: string) {
    if (!clientId) {
      throw new Error("VITE_DISCORD_CLIENT_ID is required for Discord Activity mode.");
    }
    this.sdk = new DiscordSDK(clientId);
  }

  get instanceId(): string {
    return this.sdk.instanceId;
  }

  get channelId(): string | undefined {
    return this.sdk.channelId ?? undefined;
  }

  get guildId(): string | undefined {
    return this.sdk.guildId ?? undefined;
  }

  ready(): Promise<void> {
    return this.sdk.ready();
  }

  async authorize(state: string): Promise<string> {
    const response = await this.sdk.commands.authorize({
      client_id: this.clientId,
      response_type: "code",
      prompt: "none",
      scope: ["identify"],
      state
    });
    return response.code;
  }

  async authenticate(accessToken: string): Promise<ActivityUser> {
    const response = await this.sdk.commands.authenticate({ access_token: accessToken });
    if (!response?.user) {
      throw new Error("Discord did not return an authenticated user.");
    }
    return normalizeUser(response.user);
  }

  async getParticipants(): Promise<ActivityParticipant[]> {
    const response = await this.sdk.commands.getInstanceConnectedParticipants();
    return response.participants.map(normalizeParticipant);
  }

  async subscribeParticipants(
    listener: (participants: ActivityParticipant[]) => void
  ): Promise<() => Promise<void>> {
    const sdkListener = (payload: ParticipantPayload) => {
      listener(payload.participants.map(normalizeParticipant));
    };
    await this.sdk.subscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, sdkListener);
    return async () => {
      await this.sdk.unsubscribe(Events.ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE, sdkListener);
    };
  }

  async subscribeLayout(
    listener: (layout: ActivityLayoutMode) => void
  ): Promise<() => Promise<void>> {
    const sdkListener = (payload: LayoutPayload) => listener(normalizeLayout(payload.layout_mode));
    const compatListener = (payload: { layout_mode: number }) => listener(normalizeLayout(payload.layout_mode));
    try {
      const compatSdk = this.sdk as unknown as {
        subscribeToLayoutModeUpdatesCompat?: (callback: (payload: { layout_mode: number }) => void) => Promise<unknown>;
        unsubscribeFromLayoutModeUpdatesCompat?: (callback: (payload: { layout_mode: number }) => void) => Promise<unknown>;
      };
      if (compatSdk.subscribeToLayoutModeUpdatesCompat) {
        await compatSdk.subscribeToLayoutModeUpdatesCompat(compatListener);
        return async () => {
          await compatSdk.unsubscribeFromLayoutModeUpdatesCompat?.(compatListener);
        };
      }
      await this.sdk.subscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, sdkListener);
      return async () => {
        await this.sdk.unsubscribe(Events.ACTIVITY_LAYOUT_MODE_UPDATE, sdkListener);
      };
    } catch (error) {
      if (isUnsupportedCommand(error)) {
        listener("focused");
        return async () => undefined;
      }
      throw error;
    }
  }

  async subscribeThermal(
    listener: (state: ActivityThermalState) => void
  ): Promise<() => Promise<void>> {
    const sdkListener = (payload: ThermalPayload) => listener(normalizeThermal(payload.thermal_state));
    try {
      await this.sdk.subscribe(Events.THERMAL_STATE_UPDATE, sdkListener);
      return async () => {
        await this.sdk.unsubscribe(Events.THERMAL_STATE_UPDATE, sdkListener);
      };
    } catch (error) {
      if (isUnsupportedCommand(error)) {
        return async () => undefined;
      }
      throw error;
    }
  }

  async openInviteDialog(): Promise<void> {
    await this.sdk.commands.openInviteDialog();
  }

  async openExternalLink(url: string): Promise<void> {
    const response = await this.sdk.commands.openExternalLink({ url });
    if (response.opened === false) {
      throw new Error("Discord declined to open the link.");
    }
  }

  close(): void {
    this.sdk.close(RPCCloseCodes.CLOSE_NORMAL, "Activity closed by user");
  }
}

function normalizeUser(user: {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
}): ActivityUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.global_name?.trim() || user.username,
    avatar: discordAvatarUrl(user.id, user.avatar)
  };
}

function normalizeParticipant(participant: ParticipantPayload["participants"][number]): ActivityParticipant {
  const user = normalizeUser(participant);
  return {
    ...user,
    nickname: participant.nickname
  };
}

function discordAvatarUrl(userId: string, avatar?: string | null): string | undefined {
  return avatar ? `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=128` : undefined;
}

function normalizeLayout(mode: number): ActivityLayoutMode {
  if (mode === 0) return "focused";
  if (mode === 1) return "pip";
  if (mode === 2) return "grid";
  return "unknown";
}

function normalizeThermal(state: number): ActivityThermalState {
  if (state === 0) return "nominal";
  if (state === 1) return "fair";
  if (state === 2) return "serious";
  if (state === 3) return "critical";
  return "unknown";
}

function isUnsupportedCommand(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      Number((error as { code?: unknown }).code) === 4002
  );
}
