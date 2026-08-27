export type ActivityLayoutMode = "focused" | "pip" | "grid" | "unknown";
export type ActivityThermalState = "nominal" | "fair" | "serious" | "critical" | "unknown";

export interface ActivityUser {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
}

export interface ActivityParticipant extends ActivityUser {
  nickname?: string;
}

export interface ActivityLaunchContext {
  instanceId: string;
  channelId?: string;
  guildId?: string;
  user: ActivityUser;
  participants: ActivityParticipant[];
}

export interface ActivityAuthExchangeResponse {
  accessToken: string;
  expiresAt: number;
  user: ActivityUser;
}

export interface ActivityBootstrapResult {
  context: ActivityLaunchContext;
  dispose(): Promise<void>;
}
