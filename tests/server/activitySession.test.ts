import { describe, expect, it } from "vitest";
import {
  createActivitySession,
  readActivitySessionFromCookieHeader,
  setActivitySessionCookie,
  signActivitySession,
  verifyActivitySession
} from "../../src/server/activitySession";

const SECRET = "test-session-secret-with-at-least-thirty-two-characters";

describe("Activity sessions", () => {
  it("signs and verifies an unexpired session", () => {
    const session = createActivitySession({
      userId: "user-1",
      instanceId: "instance-1",
      username: "wizard",
      displayName: "Wizard",
      now: 1000
    });
    const token = signActivitySession(session, SECRET);
    expect(verifyActivitySession(token, SECRET, 2000)).toEqual(session);
    expect(readActivitySessionFromCookieHeader(`other=x; words_activity_session=${token}`, SECRET, 2000)).toEqual(session);
  });

  it("rejects tampered and expired sessions", () => {
    const session = createActivitySession({
      userId: "user-1",
      instanceId: "instance-1",
      username: "wizard",
      displayName: "Wizard",
      now: 1000
    });
    const token = signActivitySession(session, SECRET);
    expect(verifyActivitySession(`${token}x`, SECRET, 2000)).toBeNull();
    expect(verifyActivitySession(token, SECRET, session.expiresAt + 1)).toBeNull();
  });

  it("uses partitioned iframe cookies in production", () => {
    const headers: string[] = [];
    const response = { append: (_name: string, value: string) => headers.push(value) };
    setActivitySessionCookie(response as never, "token", {
      secure: true,
      partitioned: true,
      domain: "123.discordsays.com"
    });
    expect(headers[0]).toContain("SameSite=None");
    expect(headers[0]).toContain("Partitioned");
    expect(headers[0]).toContain("Domain=123.discordsays.com");
    expect(headers[0]).toContain("Secure");
    expect(headers[0]).toContain("HttpOnly");
  });
});
