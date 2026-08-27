import "dotenv/config";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import { createServer } from "http";
import type { Server as HttpServer } from "http";
import { Server as SocketIOServer, type Socket } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import {
  addLogEntry,
  advanceRound,
  advanceTurn,
  applySwap,
  cancelSwap,
  requestSwapMode,
  shuffleBoard,
  startNewGame,
  submitWord
} from "../shared/rules.js";
import type { ChatMessage } from "../shared/chat.js";
import type { Player, Room } from "./types.js";
import { registerActivityAuthRoute } from "./activityAuth.js";
import {
  clearActivitySessionCookie,
  readActivitySessionFromCookieHeader,
  requireActivitySession,
  resolveActivityCookieOptions,
  type ActivityRequest,
  type ActivitySession
} from "./activitySession.js";

interface BackendOptions {
  serveClient?: boolean;
  clientDistPath?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

interface ActivityServerConfig {
  clientId: string;
  clientSecret: string;
  botToken: string;
  sessionSecret: string;
  production: boolean;
  testMode: boolean;
  allowedOrigins: Set<string>;
}

interface Presence {
  instanceId: string;
  userId: string;
  sockets: Set<string>;
  timeout?: NodeJS.Timeout;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ROUND_COUNT = 5;
const ROUND_OPTIONS = [3, 5];
const MAX_PLAYERS = 6;
const DISCONNECT_GRACE_MS = 5 * 60 * 1000;
const NEW_GAME_DELAY_MS = 5_000;
const MAX_CHAT_HISTORY = 200;
const MAX_CHAT_LENGTH = 500;
const MAX_TILE_SELECTION = 25;
const DICTIONARY = loadDictionary();

const rooms = new Map<string, Room>();
const playerPresence = new Map<string, Presence>();
const socketLookup = new Map<string, { instanceId: string; userId: string }>();
const gameResetTimers = new Map<string, NodeJS.Timeout>();
let activeIo: SocketIOServer | null = null;

type ExpressApp = ReturnType<typeof express>;

export function initializeBackend(
  app: ExpressApp,
  httpServer: HttpServer,
  options: BackendOptions = {}
) {
  const config = resolveActivityConfig(options.env ?? process.env);
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.setHeader("X-Request-ID", randomUUID());
    next();
  });
  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        if (!origin || config.allowedOrigins.has(origin)) return callback(null, true);
        return callback(new Error("Origin is not allowed."));
      },
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
    })
  );
  app.use(express.json({ limit: "16kb" }));

  const io = new SocketIOServer(httpServer, {
    path: "/socket.io",
    cors: {
      credentials: true,
      origin: Array.from(config.allowedOrigins),
      methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 32 * 1024
  });
  activeIo = io;

  registerHttpRoutes(app, config, options);
  registerSocketHandlers(io, config);
  return { io, config };
}

function registerHttpRoutes(app: ExpressApp, config: ActivityServerConfig, options: BackendOptions) {
  const serveClient = options.serveClient ?? true;
  const candidateDirs = [
    options.clientDistPath,
    path.resolve(__dirname, "../client"),
    path.resolve(process.cwd(), "dist/client")
  ].filter((directory): directory is string => Boolean(directory));
  const staticDir = candidateDirs.find((directory) => fs.existsSync(directory));
  const canServeStatic = serveClient && Boolean(staticDir);

  if (canServeStatic && staticDir) {
    app.use(
      express.static(staticDir, {
        setHeaders(res, filePath) {
          if (filePath.endsWith(".html")) {
            res.setHeader("Cache-Control", "no-store");
          }
        }
      })
    );
  }

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", mode: "discord-activity", state: "single-replica-ephemeral" });
  });

  app.use("/api/activity/auth/exchange", createRateLimit(12, 60_000));
  registerActivityAuthRoute(app, {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    botToken: config.botToken,
    sessionSecret: config.sessionSecret,
    production: config.production,
    testMode: config.testMode,
    fetchImpl: options.fetchImpl
  });

  const activitySession = requireActivitySession(config.sessionSecret);
  app.use("/api/activity/room", createRateLimit(120, 60_000));

  app.post("/api/activity/room/join", activitySession, (req: ActivityRequest, res: Response) => {
    const session = req.activitySession!;
    let room = rooms.get(session.instanceId);
    let player = room?.players.find((entry) => entry.id === session.userId);
    if (room && player) {
      player.name = session.displayName;
      player.username = session.username;
      player.avatar = session.avatar;
      player.lastActiveAt = Date.now();
      return res.json({ room, player });
    }

    if (room && room.players.length >= MAX_PLAYERS) {
      return res.status(409).json({ error: "This Activity instance is full.", code: "ROOM_FULL" });
    }

    const joiningMidGame = room?.status === "in-progress";
    const eligibleToJoinActive = Boolean(
      joiningMidGame && room?.game && room.game.round === 1 && !room.game.completed
    );
    player = createPlayer(session, !room, Boolean(joiningMidGame && !eligibleToJoinActive));
    if (!room) {
      room = {
        id: session.instanceId,
        activityInstanceId: session.instanceId,
        createdAt: Date.now(),
        hostId: player.id,
        players: [player],
        status: "lobby",
        rounds: DEFAULT_ROUND_COUNT,
        chat: []
      };
      rooms.set(session.instanceId, room);
    } else {
      room.players.push(player);
    }
    broadcastRoom(session.instanceId);
    return res.status(201).json({ room, player });
  });

  app.get("/api/activity/room", activitySession, (req: ActivityRequest, res: Response) => {
    const room = getSessionRoom(req.activitySession!);
    if (!room) return roomNotFound(res);
    return res.json({ room });
  });

  app.post("/api/activity/room/start", activitySession, (req: ActivityRequest, res: Response) => {
    const session = req.activitySession!;
    const room = getSessionRoom(session);
    if (!room) return roomNotFound(res);
    if (room.hostId !== session.userId) return permissionDenied(res, "Only the host can start the match.");
    if (room.status === "in-progress") {
      return res.status(409).json({ error: "A match is already running.", code: "GAME_ALREADY_STARTED" });
    }
    if (!room.players.some((player) => !player.isSpectator)) {
      return res.status(409).json({ error: "At least one active player is required.", code: "NO_ACTIVE_PLAYERS" });
    }
    shuffleActivePlayers(room);
    room.status = "in-progress";
    clearGameReset(room.id);
    startNewGame(room, room.rounds);
    broadcastRoom(room.id);
    return res.json({ room });
  });

  app.patch("/api/activity/room/settings", activitySession, (req: ActivityRequest, res: Response) => {
    const session = req.activitySession!;
    const room = getSessionRoom(session);
    if (!room) return roomNotFound(res);
    if (room.hostId !== session.userId) return permissionDenied(res, "Only the host can change settings.");
    if (room.status !== "lobby") {
      return res.status(409).json({ error: "Settings are locked during a match.", code: "GAME_IN_PROGRESS" });
    }
    const rounds = Number(req.body?.rounds);
    if (!ROUND_OPTIONS.includes(rounds)) {
      return res.status(400).json({ error: "Rounds must be 3 or 5.", code: "ROUNDS_INVALID" });
    }
    room.rounds = rounds;
    broadcastRoom(room.id);
    return res.json({ room });
  });

  app.post("/api/activity/room/leave", activitySession, (req: ActivityRequest, res: Response) => {
    const session = req.activitySession!;
    forceRemovePlayer(session.instanceId, session.userId, false);
    clearActivitySessionCookie(
      res,
      resolveActivityCookieOptions(req, config.clientId, config.production)
    );
    return res.status(204).send();
  });

  app.delete(
    "/api/activity/room/players/:userId",
    activitySession,
    (req: ActivityRequest, res: Response) => {
      const session = req.activitySession!;
      const room = getSessionRoom(session);
      if (!room) return roomNotFound(res);
      if (room.hostId !== session.userId) return permissionDenied(res, "Only the host can remove players.");
      if (req.params.userId === session.userId) {
        return res.status(400).json({ error: "Use Leave Activity to leave.", code: "SELF_KICK_INVALID" });
      }
      if (!forceRemovePlayer(session.instanceId, req.params.userId)) {
        return res.status(404).json({ error: "Player not found.", code: "PLAYER_NOT_FOUND" });
      }
      return res.status(204).send();
    }
  );

  if (canServeStatic && staticDir) {
    app.get("*", (_req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (error.message === "Origin is not allowed.") {
      return res.status(403).json({ error: error.message, code: "ORIGIN_REJECTED" });
    }
    console.error("[server] request failed", error.name);
    return res.status(500).json({ error: "Internal server error.", code: "INTERNAL_ERROR" });
  });
}

function registerSocketHandlers(io: SocketIOServer, config: ActivityServerConfig) {
  io.use((socket, next) => {
    const session = readActivitySessionFromCookieHeader(
      socket.handshake.headers.cookie,
      config.sessionSecret
    );
    if (!session) return next(new Error("ACTIVITY_SESSION_REQUIRED"));
    socket.data.activitySession = session;
    next();
  });

  io.on("connection", (socket) => {
    const session = socket.data.activitySession as ActivitySession;
    const instanceId = session.instanceId;
    const playerId = session.userId;
    const room = rooms.get(instanceId);
    const player = room?.players.find((entry) => entry.id === playerId);
    if (!room || !player) {
      socket.emit("room:error", { message: "Join the Activity lobby before connecting.", code: "ROOM_JOIN_REQUIRED" });
      return socket.disconnect(true);
    }

    socket.join(instanceId);
    registerPresence(instanceId, playerId, socket);
    socket.emit("room:update", room);

    socket.on("game:submitWord", (payload: { tileIds?: unknown }) => {
      const currentRoom = rooms.get(instanceId);
      if (!currentRoom) return;
      const tileIds = sanitizeTileIds(payload?.tileIds);
      const result = submitWord(currentRoom, playerId, tileIds, DICTIONARY);
      if (!result.success) return gameError(socket, result.error);
      broadcastRoom(instanceId);
      if (currentRoom.game?.completed) scheduleGameReset(instanceId);
      else clearGameReset(instanceId);
    });

    socket.on("game:shuffle", () => {
      const currentRoom = rooms.get(instanceId);
      if (!currentRoom) return;
      if (!ensurePlayerTurn(currentRoom, playerId)) return gameError(socket, "It is not your turn.");
      const result = shuffleBoard(currentRoom, playerId);
      if (!result.success) return gameError(socket, result.error);
      const actor = currentRoom.players.find((entry) => entry.id === playerId);
      if (currentRoom.game && actor) {
        addLogEntry(currentRoom.game, `Round ${currentRoom.game.round}: ${actor.name} used Shuffle (-1 gem).`);
      }
      broadcastRoom(instanceId);
      clearGameReset(instanceId);
    });

    socket.on("game:swap:start", () => {
      const currentRoom = rooms.get(instanceId);
      if (!currentRoom) return;
      if (!ensurePlayerTurn(currentRoom, playerId)) return gameError(socket, "It is not your turn.");
      const result = requestSwapMode(currentRoom, playerId);
      if (!result.success) return gameError(socket, result.error);
      broadcastRoom(instanceId);
    });

    socket.on("game:swap:apply", (payload: { tileId?: unknown; letter?: unknown }) => {
      const currentRoom = rooms.get(instanceId);
      if (!currentRoom) return;
      const tileId = typeof payload?.tileId === "string" ? payload.tileId : "";
      const letter = typeof payload?.letter === "string" ? payload.letter.slice(0, 1) : "";
      if (!tileId || !letter) return gameError(socket, "Tile and letter are required.");
      const result = applySwap(currentRoom, playerId, tileId, letter);
      if (!result.success) return gameError(socket, result.error);
      const actor = currentRoom.players.find((entry) => entry.id === playerId);
      if (currentRoom.game && actor) {
        addLogEntry(currentRoom.game, `Round ${currentRoom.game.round}: ${actor.name} swapped a letter (-3 gems).`);
      }
      broadcastRoom(instanceId);
      clearGameReset(instanceId);
    });

    socket.on("game:swap:cancel", () => {
      const currentRoom = rooms.get(instanceId);
      if (!currentRoom) return;
      cancelSwap(currentRoom, playerId);
      broadcastRoom(instanceId);
    });

    socket.on("game:selection", (payload: { tileIds?: unknown }) => {
      const currentRoom = rooms.get(instanceId);
      const sender = currentRoom?.players.find((entry) => entry.id === playerId);
      if (!sender || sender.isSpectator) return;
      socket.to(instanceId).emit("game:selection", {
        playerId,
        tileIds: sanitizeTileIds(payload?.tileIds)
      });
    });

    socket.on("game:skip", (payload: { playerId?: unknown }) => {
      const currentRoom = rooms.get(instanceId);
      if (!currentRoom) return;
      if (currentRoom.hostId !== playerId) return gameError(socket, "Only the host can skip turns.");
      if (!currentRoom.game || currentRoom.status !== "in-progress") return gameError(socket, "No active match.");
      const targetId = typeof payload?.playerId === "string" ? payload.playerId : undefined;
      const currentPlayer = currentRoom.players[currentRoom.game.currentPlayerIndex];
      if (!currentPlayer || (targetId && targetId !== currentPlayer.id)) {
        return gameError(socket, "That player is not taking a turn.");
      }
      advanceTurn(currentRoom);
      if (currentRoom.game) {
        addLogEntry(currentRoom.game, `Round ${currentRoom.game.round}: ${currentPlayer.name}'s turn was skipped by the host.`);
      }
      broadcastRoom(instanceId);
    });

    socket.on("chat:send", (payload: { text?: unknown }) => {
      const currentRoom = rooms.get(instanceId);
      const sender = currentRoom?.players.find((entry) => entry.id === playerId);
      const text = typeof payload?.text === "string" ? payload.text.trim().slice(0, MAX_CHAT_LENGTH) : "";
      if (!currentRoom || !sender || !text) return;
      const message: ChatMessage = {
        id: randomUUID(),
        playerId,
        playerName: sender.name,
        text,
        createdAt: Date.now()
      };
      currentRoom.chat.push(message);
      if (currentRoom.chat.length > MAX_CHAT_HISTORY) {
        currentRoom.chat.splice(0, currentRoom.chat.length - MAX_CHAT_HISTORY);
      }
      broadcastRoom(instanceId);
    });

    socket.on("disconnect", () => handleSocketDisconnect(socket.id));
  });
}

export function resolveActivityConfig(env: NodeJS.ProcessEnv): ActivityServerConfig {
  const production = env.NODE_ENV === "production";
  const testMode = env.ACTIVITY_TEST_MODE === "true";
  if (production && testMode) {
    throw new Error("ACTIVITY_TEST_MODE must never be enabled in production.");
  }

  const clientId = env.DISCORD_CLIENT_ID?.trim() || (testMode ? "activity-test-client" : "");
  const clientSecret = env.DISCORD_CLIENT_SECRET?.trim() || (testMode ? "activity-test-secret" : "");
  const botToken = env.DISCORD_BOT_TOKEN?.trim() || (testMode ? "activity-test-bot" : "");
  const sessionSecret = env.SESSION_SECRET?.trim() || "";
  const missing = [
    !clientId && "DISCORD_CLIENT_ID",
    !clientSecret && "DISCORD_CLIENT_SECRET",
    !botToken && "DISCORD_BOT_TOKEN",
    sessionSecret.length < 32 && "SESSION_SECRET (at least 32 characters)"
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Missing Activity configuration: ${missing.join(", ")}`);
  }

  const allowedOrigins = new Set<string>();
  if (clientId) allowedOrigins.add(`https://${clientId}.discordsays.com`);
  if (!production) {
    allowedOrigins.add("http://localhost:8900");
    allowedOrigins.add("http://127.0.0.1:8900");
    allowedOrigins.add("https://localhost:8900");
  }
  env.ACTIVITY_ALLOWED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .forEach((origin) => allowedOrigins.add(origin));

  return { clientId, clientSecret, botToken, sessionSecret, production, testMode, allowedOrigins };
}

export function resetActivityStateForTests() {
  playerPresence.forEach((presence) => presence.timeout && clearTimeout(presence.timeout));
  gameResetTimers.forEach((timer) => clearTimeout(timer));
  playerPresence.clear();
  socketLookup.clear();
  gameResetTimers.clear();
  rooms.clear();
  activeIo = null;
}

function createPlayer(session: ActivitySession, isHost: boolean, isSpectator: boolean): Player {
  return {
    id: session.userId,
    name: sanitizeName(session.displayName),
    username: session.username,
    avatar: session.avatar,
    isHost,
    score: 0,
    gems: 3,
    joinedAt: Date.now(),
    lastActiveAt: Date.now(),
    connected: false,
    isSpectator
  };
}

function getSessionRoom(session: ActivitySession): Room | undefined {
  const room = rooms.get(session.instanceId);
  return room?.players.some((player) => player.id === session.userId) ? room : undefined;
}

function broadcastRoom(instanceId: string) {
  const room = rooms.get(instanceId);
  if (room && activeIo) activeIo.to(instanceId).emit("room:update", room);
}

function registerPresence(instanceId: string, userId: string, socket: Socket) {
  const key = presenceKey(instanceId, userId);
  const existing = playerPresence.get(key);
  if (existing) {
    if (existing.timeout) clearTimeout(existing.timeout);
    existing.timeout = undefined;
    existing.sockets.add(socket.id);
  } else {
    playerPresence.set(key, { instanceId, userId, sockets: new Set([socket.id]) });
  }
  socketLookup.set(socket.id, { instanceId, userId });
  const player = rooms.get(instanceId)?.players.find((entry) => entry.id === userId);
  if (player) {
    player.connected = true;
    player.lastActiveAt = Date.now();
    broadcastRoom(instanceId);
  }
}

function handleSocketDisconnect(socketId: string) {
  const context = socketLookup.get(socketId);
  if (!context) return;
  socketLookup.delete(socketId);
  const key = presenceKey(context.instanceId, context.userId);
  const presence = playerPresence.get(key);
  if (!presence) return;
  presence.sockets.delete(socketId);
  if (presence.sockets.size) return;

  const player = rooms.get(context.instanceId)?.players.find((entry) => entry.id === context.userId);
  if (player) {
    player.connected = false;
    player.lastActiveAt = Date.now();
    broadcastRoom(context.instanceId);
  }
  presence.timeout = setTimeout(() => {
    playerPresence.delete(key);
    removePlayerFromRoom(context.instanceId, context.userId);
  }, DISCONNECT_GRACE_MS);
}

function forceRemovePlayer(instanceId: string, userId: string, notify = true): boolean {
  const key = presenceKey(instanceId, userId);
  const presence = playerPresence.get(key);
  if (presence) {
    if (presence.timeout) clearTimeout(presence.timeout);
    presence.sockets.forEach((socketId) => {
      const socket = activeIo?.sockets.sockets.get(socketId);
      if (notify) socket?.emit("room:kicked", { instanceId });
      socketLookup.delete(socketId);
      socket?.disconnect(true);
    });
    playerPresence.delete(key);
  }
  return removePlayerFromRoom(instanceId, userId);
}

function removePlayerFromRoom(instanceId: string, userId: string): boolean {
  const room = rooms.get(instanceId);
  if (!room) return false;
  clearGameReset(instanceId);
  const index = room.players.findIndex((player) => player.id === userId);
  if (index === -1) return false;

  const playersBeforeRemoval = [...room.players];
  const game = room.game;
  const activeGame = Boolean(room.status === "in-progress" && game && !game.completed);
  const wasCurrentPlayer = Boolean(activeGame && game && game.currentPlayerIndex === index);
  const nextTurn = wasCurrentPlayer && game ? getNextTurnAfterRemoval(playersBeforeRemoval, index) : null;
  let preservedIndex = game?.currentPlayerIndex ?? 0;
  if (game && !wasCurrentPlayer && game.currentPlayerIndex > index) preservedIndex -= 1;

  room.players.splice(index, 1);
  if (!room.players.length) {
    rooms.delete(instanceId);
    activeIo?.to(instanceId).emit("room:update", { ...room, players: [] });
    return true;
  }

  if (room.hostId === userId) {
    const nextHost = room.players.find((player) => !player.isSpectator) ?? room.players[0];
    room.hostId = nextHost.id;
    room.players.forEach((player) => {
      player.isHost = player.id === nextHost.id;
    });
  }

  if (game) {
    if (game.swapModePlayerId === userId) game.swapModePlayerId = undefined;
    if (wasCurrentPlayer) {
      if (nextTurn) {
        game.currentPlayerIndex = Math.min(nextTurn.index, room.players.length - 1);
        if (nextTurn.wrapped) advanceRound(room);
      } else {
        game.currentPlayerIndex = 0;
        normalizeCurrentPlayer(room);
      }
    } else {
      game.currentPlayerIndex = Math.min(preservedIndex, room.players.length - 1);
      normalizeCurrentPlayer(room);
    }
  }
  broadcastRoom(instanceId);
  return true;
}

function scheduleGameReset(instanceId: string) {
  if (gameResetTimers.has(instanceId)) return;
  gameResetTimers.set(
    instanceId,
    setTimeout(() => {
      gameResetTimers.delete(instanceId);
      const room = rooms.get(instanceId);
      if (!room) return;
      room.status = "lobby";
      room.game = undefined;
      room.players.forEach((player) => {
        player.isSpectator = false;
      });
      broadcastRoom(instanceId);
    }, NEW_GAME_DELAY_MS)
  );
}

function clearGameReset(instanceId: string) {
  const timer = gameResetTimers.get(instanceId);
  if (!timer) return;
  clearTimeout(timer);
  gameResetTimers.delete(instanceId);
}

function ensurePlayerTurn(room: Room, playerId: string): boolean {
  const game = room.game;
  if (!game || !room.players.some((player) => !player.isSpectator)) return false;
  normalizeCurrentPlayer(room);
  return room.players[game.currentPlayerIndex]?.id === playerId;
}

function normalizeCurrentPlayer(room: Room) {
  if (!room.game || !room.players.length) return;
  if (
    room.game.currentPlayerIndex >= room.players.length ||
    room.players[room.game.currentPlayerIndex]?.isSpectator
  ) {
    const firstActive = room.players.findIndex((player) => !player.isSpectator);
    room.game.currentPlayerIndex = firstActive === -1 ? 0 : firstActive;
  }
}

function getNextTurnAfterRemoval(
  players: Player[],
  removedIndex: number
): { index: number; wrapped: boolean } | null {
  for (let index = removedIndex + 1; index < players.length; index += 1) {
    if (!players[index].isSpectator) return { index: index - 1, wrapped: false };
  }
  for (let index = 0; index < removedIndex; index += 1) {
    if (!players[index].isSpectator) return { index, wrapped: true };
  }
  return null;
}

function shuffleActivePlayers(room: Room) {
  const active = room.players.filter((player) => !player.isSpectator);
  for (let index = active.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [active[index], active[target]] = [active[target], active[index]];
  }
  room.players = [...active, ...room.players.filter((player) => player.isSpectator)];
}

function sanitizeTileIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, MAX_TILE_SELECTION)
    .map((entry) => entry.slice(0, 32));
}

function sanitizeName(value: string): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 32) || "Wizard";
}

function presenceKey(instanceId: string, userId: string): string {
  return `${instanceId}\u0000${userId}`;
}

function gameError(socket: Socket, message = "Unable to perform that action.") {
  socket.emit("game:error", { message });
}

function roomNotFound(res: Response) {
  return res.status(404).json({ error: "Activity room not found.", code: "ROOM_NOT_FOUND" });
}

function permissionDenied(res: Response, error: string) {
  return res.status(403).json({ error, code: "PERMISSION_DENIED" });
}

function createRateLimit(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Too many Activity requests.", code: "RATE_LIMITED" });
    }
    next();
  };
}

function loadDictionary(): Set<string> {
  const candidates = [
    path.resolve(__dirname, "../../src/game/dictionary.txt"),
    path.resolve(process.cwd(), "src/game/dictionary.txt"),
    path.resolve(__dirname, "../client/dictionary.txt"),
    path.resolve(process.cwd(), "dist/client/dictionary.txt"),
    path.resolve(__dirname, "dictionary.txt")
  ];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) return new Set();
  const raw = fs.readFileSync(filePath, "utf8");
  return new Set(raw.split(/\r?\n/).map((word) => word.trim().toUpperCase()).filter(Boolean));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(entry).href === import.meta.url);
}

if (isMainModule()) {
  const app = express();
  const httpServer = createServer(app);
  initializeBackend(app, httpServer, {
    serveClient: true,
    clientDistPath: path.resolve(process.cwd(), "dist/client")
  });
  const port = Number(process.env.PORT ?? 3000);
  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`Words & Wizards Activity server listening on port ${port}`);
  });
}
