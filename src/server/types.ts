import { GameSnapshot } from "../shared/gameTypes.js";
import type { ChatMessage } from "../shared/chat.js";

export interface Player {
  id: string;
  name: string;
  username?: string;
  avatar?: string;
  isHost: boolean;
  score: number;
  gems: number;
  joinedAt: number;
  connected: boolean;
  isSpectator: boolean;
  lastActiveAt?: number;
}

export interface GameState extends GameSnapshot {
  swapModePlayerId?: string;
  log: string[];
}

export interface Room {
  id: string;
  activityInstanceId: string;
  createdAt: number;
  hostId: string;
  players: Player[];
  status: "lobby" | "in-progress";
  rounds: number;
  game?: GameState;
  chat: ChatMessage[];
}
