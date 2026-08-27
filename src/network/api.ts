import type { GameSnapshot } from "../shared/gameTypes";
import type { ChatMessage } from "../shared/chat";
import type { ActivityAuthExchangeResponse } from "../activity/activityContext";

export interface RoomPlayerDTO {
  id: string;
  name: string;
  username?: string;
  avatar?: string;
  isHost: boolean;
  score: number;
  gems: number;
  isSpectator: boolean;
  connected: boolean;
}

export interface RoomDTO {
  id: string;
  activityInstanceId: string;
  players: RoomPlayerDTO[];
  hostId: string;
  status: "lobby" | "in-progress";
  rounds: number;
  game?: GameSnapshot;
  chat: ChatMessage[];
}

export interface ActivityRoomJoinResponse {
  room: RoomDTO;
  player: RoomPlayerDTO;
}

export class ActivityApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "ActivityApiError";
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ActivityApiError(
      payload.error || response.statusText || "Activity request failed.",
      response.status,
      payload.code
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function exchangeActivityCode(input: {
  code: string;
  instanceId: string;
}): Promise<ActivityAuthExchangeResponse> {
  return request("/api/activity/auth/exchange", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function joinActivityRoom(): Promise<ActivityRoomJoinResponse> {
  return request("/api/activity/room/join", { method: "POST" });
}

export function getActivityRoom(): Promise<{ room: RoomDTO }> {
  return request("/api/activity/room", { method: "GET" });
}

export function startActivityRoom(): Promise<{ room: RoomDTO }> {
  return request("/api/activity/room/start", { method: "POST" });
}

export function updateActivityRoomRounds(rounds: number): Promise<{ room: RoomDTO }> {
  return request("/api/activity/room/settings", {
    method: "PATCH",
    body: JSON.stringify({ rounds })
  });
}

export function leaveActivityRoom(): Promise<void> {
  return request("/api/activity/room/leave", { method: "POST" });
}

export function kickActivityPlayer(userId: string): Promise<void> {
  return request(`/api/activity/room/players/${encodeURIComponent(userId)}`, {
    method: "DELETE"
  });
}
