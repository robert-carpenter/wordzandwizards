import { createHash } from "crypto";
import type { Request, Response } from "express";
import type express from "express";
import {
  createActivitySession,
  resolveActivityCookieOptions,
  setActivitySessionCookie,
  signActivitySession
} from "./activitySession.js";
import { DiscordApi, DiscordApiError } from "./discordApi.js";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_LENGTH = 4096;
const MAX_INSTANCE_LENGTH = 512;

export interface ActivityAuthConfig {
  clientId: string;
  clientSecret: string;
  botToken: string;
  sessionSecret: string;
  production: boolean;
  testMode: boolean;
  fetchImpl?: typeof fetch;
}

interface VerifiedActivityIdentity {
  id: string;
  username: string;
  displayName: string;
  avatar?: string;
  accessToken: string;
}

export function registerActivityAuthRoute(
  app: ReturnType<typeof express>,
  config: ActivityAuthConfig
) {
  const usedCodes = new Map<string, number>();
  const discordApi = config.testMode
    ? null
    : new DiscordApi({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        botToken: config.botToken,
        fetchImpl: config.fetchImpl
      });

  app.post("/api/activity/auth/exchange", async (req: Request, res: Response) => {
    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    const instanceId = typeof req.body?.instanceId === "string" ? req.body.instanceId.trim() : "";
    if (!code || code.length > MAX_CODE_LENGTH || !instanceId || instanceId.length > MAX_INSTANCE_LENGTH) {
      return res.status(400).json({ error: "Invalid Activity authorization request.", code: "AUTH_INPUT_INVALID" });
    }

    pruneUsedCodes(usedCodes);
    const codeHash = createHash("sha256").update(code).digest("hex");
    if (usedCodes.has(codeHash)) {
      return res.status(409).json({ error: "Authorization code was already used.", code: "AUTH_CODE_REPLAYED" });
    }

    try {
      const identity = config.testMode
        ? parseTestAuthorization(code, instanceId)
        : await verifyDiscordAuthorization(discordApi!, code, instanceId);
      usedCodes.set(codeHash, Date.now() + AUTH_CODE_TTL_MS);

      const session = createActivitySession({
        userId: identity.id,
        instanceId,
        username: identity.username,
        displayName: identity.displayName,
        avatar: identity.avatar
      });
      const token = signActivitySession(session, config.sessionSecret);
      setActivitySessionCookie(res, token, {
        ...resolveActivityCookieOptions(req, config.clientId, config.production),
        maxAgeMs: session.expiresAt - Date.now()
      });
      return res.json({
        accessToken: identity.accessToken,
        expiresAt: session.expiresAt,
        user: {
          id: identity.id,
          username: identity.username,
          displayName: identity.displayName,
          avatar: identity.avatar
        }
      });
    } catch (error) {
      if (error instanceof ActivityAuthError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      if (error instanceof DiscordApiError) {
        const status = error.status === 429 ? 503 : error.status >= 500 ? error.status : 401;
        return res.status(status).json({ error: error.message, code: error.code });
      }
      console.warn("[activity-auth] verification failed", safeErrorName(error));
      return res.status(500).json({ error: "Activity authentication failed.", code: "AUTH_FAILED" });
    }
  });
}

async function verifyDiscordAuthorization(
  discordApi: DiscordApi,
  code: string,
  instanceId: string
): Promise<VerifiedActivityIdentity> {
  const oauth = await discordApi.exchangeCode(code);
  const [user, instance] = await Promise.all([
    discordApi.getCurrentUser(oauth),
    discordApi.getActivityInstance(instanceId)
  ]);
  if (!instance.users.includes(user.id)) {
    throw new ActivityAuthError(
      "Discord user is not present in this Activity instance.",
      403,
      "ACTIVITY_INSTANCE_MEMBERSHIP_REQUIRED"
    );
  }
  return {
    id: user.id,
    username: user.username,
    displayName: user.globalName?.trim() || user.username,
    avatar: user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128`
      : undefined,
    accessToken: oauth.accessToken
  };
}

function parseTestAuthorization(code: string, expectedInstanceId: string): VerifiedActivityIdentity {
  if (!code.startsWith("activity-test.")) {
    throw new ActivityAuthError("Invalid Activity test authorization.", 401, "TEST_AUTH_INVALID");
  }
  try {
    const encoded = code.slice("activity-test.".length);
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      id?: unknown;
      username?: unknown;
      name?: unknown;
      avatar?: unknown;
      instanceId?: unknown;
      nonce?: unknown;
    };
    if (
      typeof payload.id !== "string" ||
      typeof payload.username !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.nonce !== "string" ||
      payload.instanceId !== expectedInstanceId
    ) {
      throw new Error("invalid payload");
    }
    const id = sanitizeIdentifier(payload.id);
    const username = sanitizeIdentifier(payload.username);
    const displayName = sanitizeDisplayName(payload.name);
    const avatar = sanitizeTestAvatar(payload.avatar);
    if (!id || !username || !displayName) throw new Error("invalid identity");
    return {
      id,
      username,
      displayName,
      avatar,
      accessToken: `activity-test-access.${id}.${payload.nonce}`
    };
  } catch {
    throw new ActivityAuthError("Invalid Activity test authorization.", 401, "TEST_AUTH_INVALID");
  }
}

function sanitizeIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
}

function sanitizeDisplayName(value: string): string {
  return value.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 32);
}

function sanitizeTestAvatar(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function pruneUsedCodes(codes: Map<string, number>) {
  const now = Date.now();
  codes.forEach((expiresAt, code) => {
    if (expiresAt <= now) codes.delete(code);
  });
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

class ActivityAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "ActivityAuthError";
  }
}
