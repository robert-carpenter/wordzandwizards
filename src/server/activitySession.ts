import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import type { NextFunction, Request, Response } from "express";

export const ACTIVITY_SESSION_COOKIE = "words_activity_session";
export const ACTIVITY_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export interface ActivitySession {
  sessionId: string;
  userId: string;
  instanceId: string;
  username: string;
  displayName: string;
  avatar?: string;
  issuedAt: number;
  expiresAt: number;
}

export interface ActivityRequest extends Request {
  activitySession?: ActivitySession;
}

export interface ActivityCookieOptions {
  secure: boolean;
  partitioned: boolean;
  domain?: string;
  maxAgeMs?: number;
}

export function createActivitySession(input: {
  userId: string;
  instanceId: string;
  username: string;
  displayName: string;
  avatar?: string;
  now?: number;
}): ActivitySession {
  const issuedAt = input.now ?? Date.now();
  return {
    sessionId: randomUUID(),
    userId: input.userId,
    instanceId: input.instanceId,
    username: input.username,
    displayName: input.displayName,
    avatar: input.avatar,
    issuedAt,
    expiresAt: issuedAt + ACTIVITY_SESSION_TTL_MS
  };
}

export function signActivitySession(session: ActivitySession, secret: string): string {
  requireSecret(secret);
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyActivitySession(
  token: string | undefined,
  secret: string,
  now = Date.now()
): ActivitySession | null {
  if (!token || !secret) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ActivitySession;
    if (!isValidSession(session, now)) return null;
    return session;
  } catch {
    return null;
  }
}

export function readActivitySessionFromCookieHeader(
  cookieHeader: string | undefined,
  secret: string,
  now = Date.now()
): ActivitySession | null {
  const token = parseCookieHeader(cookieHeader)[ACTIVITY_SESSION_COOKIE];
  return verifyActivitySession(token, secret, now);
}

export function requireActivitySession(secret: string) {
  return (req: ActivityRequest, res: Response, next: NextFunction) => {
    const session = readActivitySessionFromCookieHeader(req.headers.cookie, secret);
    if (!session) {
      return res.status(401).json({
        error: "Activity session is missing or expired.",
        code: "ACTIVITY_SESSION_REQUIRED"
      });
    }
    req.activitySession = session;
    next();
  };
}

export function setActivitySessionCookie(
  res: Response,
  token: string,
  options: ActivityCookieOptions
) {
  const parts = [
    `${ACTIVITY_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    options.secure ? "Secure" : "",
    options.partitioned ? "SameSite=None" : "SameSite=Lax",
    options.partitioned ? "Partitioned" : "",
    options.domain ? `Domain=${options.domain}` : "",
    `Max-Age=${Math.floor((options.maxAgeMs ?? ACTIVITY_SESSION_TTL_MS) / 1000)}`
  ].filter(Boolean);
  res.append("Set-Cookie", parts.join("; "));
}

export function clearActivitySessionCookie(
  res: Response,
  options: ActivityCookieOptions
) {
  const parts = [
    `${ACTIVITY_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    options.secure ? "Secure" : "",
    options.partitioned ? "SameSite=None" : "SameSite=Lax",
    options.partitioned ? "Partitioned" : "",
    options.domain ? `Domain=${options.domain}` : "",
    "Max-Age=0"
  ].filter(Boolean);
  res.append("Set-Cookie", parts.join("; "));
}

export function resolveActivityCookieOptions(
  req: Request,
  clientId: string,
  production: boolean
): ActivityCookieOptions {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const proxyOrigin = clientId ? `https://${clientId}.discordsays.com` : "";
  const throughDiscordProxy = Boolean(proxyOrigin && origin === proxyOrigin);
  const secure = production || throughDiscordProxy || req.secure || forwardedProto === "https";
  return {
    secure,
    partitioned: secure,
    domain: clientId && (throughDiscordProxy || production) ? `${clientId}.discordsays.com` : undefined
  };
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce<Record<string, string>>((cookies, part) => {
    const [rawName, ...rest] = part.split("=");
    const name = rawName?.trim();
    if (!name) return cookies;
    try {
      cookies[name] = decodeURIComponent(rest.join("=").trim());
    } catch {
      cookies[name] = rest.join("=").trim();
    }
    return cookies;
  }, {});
}

function isValidSession(value: ActivitySession, now: number): boolean {
  return Boolean(
    value &&
      typeof value.sessionId === "string" &&
      typeof value.userId === "string" &&
      typeof value.instanceId === "string" &&
      typeof value.username === "string" &&
      typeof value.displayName === "string" &&
      typeof value.issuedAt === "number" &&
      typeof value.expiresAt === "number" &&
      value.issuedAt <= now + 60_000 &&
      value.expiresAt > now
  );
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireSecret(secret: string) {
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
}
