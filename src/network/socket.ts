import { io, type Socket } from "socket.io-client";
import type { RoomDTO } from "./api";

export interface RoomSocketHandlers {
  onRoomUpdate(room: RoomDTO): void;
  onDisconnect(reason: string): void;
  onError?(message: string, code?: string): void;
  onGameError?(message: string): void;
  onSelection?(playerId: string, tileIds: string[]): void;
  onKicked?(): void;
  onConnect?(): void;
  onReconnect?(): void;
}

interface ServerToClientEvents {
  "room:update": (room: RoomDTO) => void;
  "room:error": (payload: { message: string; code?: string }) => void;
  "game:selection": (payload: { playerId: string; tileIds: string[] }) => void;
  "game:error": (payload: { message: string }) => void;
  "room:kicked": (payload: { instanceId: string }) => void;
}

interface ClientToServerEvents {
  "game:submitWord": (payload: { tileIds: string[] }) => void;
  "game:shuffle": () => void;
  "game:swap:start": () => void;
  "game:swap:apply": (payload: { tileId: string; letter: string }) => void;
  "game:swap:cancel": () => void;
  "game:selection": (payload: { tileIds: string[] }) => void;
  "game:skip": (payload: { playerId: string }) => void;
  "chat:send": (payload: { text: string }) => void;
}

export type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function connectActivitySocket(handlers: RoomSocketHandlers): RoomSocket {
  const socket = io(window.location.origin, {
    path: "/socket.io",
    transports: ["websocket"],
    withCredentials: true,
    forceNew: true,
    reconnection: true,
    reconnectionDelayMax: 5_000
  }) as RoomSocket;

  socket.on("room:update", handlers.onRoomUpdate);
  socket.on("room:error", (payload) => {
    handlers.onError?.(payload.message, payload.code);
    socket.disconnect();
  });
  socket.on("game:error", (payload) => handlers.onGameError?.(payload.message));
  socket.on("game:selection", (payload) => handlers.onSelection?.(payload.playerId, payload.tileIds ?? []));
  socket.on("room:kicked", () => handlers.onKicked?.());
  socket.on("connect_error", (error) => handlers.onError?.(error.message, "SOCKET_CONNECT_FAILED"));
  socket.on("disconnect", handlers.onDisconnect);
  socket.on("connect", () => handlers.onConnect?.());
  socket.io.on("reconnect", () => handlers.onReconnect?.());

  return socket;
}
