import type {
  ActivityLayoutMode,
  ActivityParticipant,
  ActivityThermalState,
  ActivityUser
} from "./activityContext";

export interface ActivityPlatform {
  readonly instanceId: string;
  readonly channelId?: string;
  readonly guildId?: string;

  ready(): Promise<void>;
  authorize(state: string): Promise<string>;
  authenticate(accessToken: string): Promise<ActivityUser>;
  getParticipants(): Promise<ActivityParticipant[]>;
  subscribeParticipants(listener: (participants: ActivityParticipant[]) => void): Promise<() => Promise<void>>;
  subscribeLayout(listener: (layout: ActivityLayoutMode) => void): Promise<() => Promise<void>>;
  subscribeThermal(listener: (state: ActivityThermalState) => void): Promise<() => Promise<void>>;
  openInviteDialog(): Promise<void>;
  openExternalLink(url: string): Promise<void>;
  close(): void;
}
