const DISCORD_API = "https://discord.com/api/v10";
const REQUEST_TIMEOUT_MS = 8_000;

export interface DiscordTokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
}

export interface DiscordUserResponse {
  id: string;
  username: string;
  globalName?: string;
  avatar?: string;
}

export interface DiscordActivityInstance {
  applicationId: string;
  instanceId: string;
  users: string[];
}

export class DiscordApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

export interface DiscordApiOptions {
  clientId: string;
  clientSecret: string;
  botToken: string;
  fetchImpl?: typeof fetch;
}

export class DiscordApi {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DiscordApiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async exchangeCode(code: string): Promise<DiscordTokenResponse> {
    const response = await this.request(`${DISCORD_API}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
        grant_type: "authorization_code",
        code
      })
    });
    const payload = (await response.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    if (!payload.access_token || !payload.token_type || !Number.isFinite(payload.expires_in)) {
      throw new DiscordApiError("Discord returned an invalid OAuth response.", 502, "DISCORD_OAUTH_INVALID");
    }
    return {
      accessToken: payload.access_token,
      tokenType: payload.token_type,
      expiresIn: Number(payload.expires_in)
    };
  }

  async getCurrentUser(token: DiscordTokenResponse): Promise<DiscordUserResponse> {
    const response = await this.request(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `${token.tokenType} ${token.accessToken}` }
    });
    const payload = (await response.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
    };
    if (!payload.id || !payload.username) {
      throw new DiscordApiError("Discord returned an invalid user.", 502, "DISCORD_USER_INVALID");
    }
    return {
      id: payload.id,
      username: payload.username,
      globalName: payload.global_name ?? undefined,
      avatar: payload.avatar ?? undefined
    };
  }

  async getActivityInstance(instanceId: string): Promise<DiscordActivityInstance> {
    const response = await this.request(
      `${DISCORD_API}/applications/${encodeURIComponent(this.options.clientId)}/activity-instances/${encodeURIComponent(instanceId)}`,
      { headers: { Authorization: `Bot ${this.options.botToken}` } }
    );
    const payload = (await response.json()) as {
      application_id?: string;
      instance_id?: string;
      users?: unknown;
    };
    if (
      payload.application_id !== this.options.clientId ||
      payload.instance_id !== instanceId ||
      !Array.isArray(payload.users) ||
      !payload.users.every((user) => typeof user === "string")
    ) {
      throw new DiscordApiError("Discord returned an invalid Activity instance.", 502, "DISCORD_INSTANCE_INVALID");
    }
    return {
      applicationId: payload.application_id,
      instanceId: payload.instance_id,
      users: payload.users
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        const status = response.status;
        const code = status === 429 ? "DISCORD_RATE_LIMITED" : "DISCORD_API_REJECTED";
        throw new DiscordApiError("Discord rejected the request.", status, code);
      }
      return response;
    } catch (error) {
      if (error instanceof DiscordApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new DiscordApiError("Discord request timed out.", 504, "DISCORD_TIMEOUT");
      }
      throw new DiscordApiError("Discord is temporarily unavailable.", 502, "DISCORD_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
    }
  }
}
