import type {
  ActivityAuthExchangeResponse,
  ActivityBootstrapResult,
  ActivityLayoutMode,
  ActivityParticipant,
  ActivityThermalState
} from "./activityContext";
import type { ActivityPlatform } from "./activityPlatform";

export interface ActivityBootstrapOptions {
  platform: ActivityPlatform;
  exchange(input: { code: string; instanceId: string }): Promise<ActivityAuthExchangeResponse>;
  onParticipants?(participants: ActivityParticipant[]): void;
  onLayout?(layout: ActivityLayoutMode): void;
  onThermal?(state: ActivityThermalState): void;
}

export class ActivityBootstrapError extends Error {
  constructor(
    message: string,
    readonly code: "SDK_READY" | "AUTHORIZE" | "EXCHANGE" | "AUTHENTICATE" | "USER_MISMATCH"
  ) {
    super(message);
    this.name = "ActivityBootstrapError";
  }
}

export async function bootstrapActivity(
  options: ActivityBootstrapOptions
): Promise<ActivityBootstrapResult> {
  const { platform } = options;
  if (!platform.instanceId) {
    throw new ActivityBootstrapError("Discord did not provide an Activity instance.", "SDK_READY");
  }

  try {
    await platform.ready();
  } catch (error) {
    throw wrapError(error, "Unable to connect to Discord.", "SDK_READY");
  }

  let code: string;
  try {
    code = await platform.authorize(crypto.randomUUID());
  } catch (error) {
    throw wrapError(error, "Discord authorization failed.", "AUTHORIZE");
  }

  let exchange: ActivityAuthExchangeResponse;
  try {
    exchange = await options.exchange({ code, instanceId: platform.instanceId });
  } catch (error) {
    throw wrapError(error, "The Activity session could not be verified.", "EXCHANGE");
  }

  let sdkUser;
  try {
    sdkUser = await platform.authenticate(exchange.accessToken);
  } catch (error) {
    throw wrapError(error, "Discord authentication failed.", "AUTHENTICATE");
  }

  if (sdkUser.id !== exchange.user.id) {
    throw new ActivityBootstrapError(
      "Discord and server identities did not match. Please relaunch the Activity.",
      "USER_MISMATCH"
    );
  }

  const participants = await platform.getParticipants().catch(() => []);
  options.onParticipants?.(participants);
  const unsubscribers: Array<() => Promise<void>> = [];
  const subscriptions = await Promise.all([
    platform.subscribeParticipants((next) => options.onParticipants?.(next)),
    platform.subscribeLayout((layout) => options.onLayout?.(layout)),
    platform.subscribeThermal((state) => options.onThermal?.(state))
  ]);
  unsubscribers.push(...subscriptions);

  return {
    context: {
      instanceId: platform.instanceId,
      channelId: platform.channelId,
      guildId: platform.guildId,
      user: exchange.user,
      participants
    },
    async dispose() {
      await Promise.allSettled(unsubscribers.map((unsubscribe) => unsubscribe()));
    }
  };
}

function wrapError(
  error: unknown,
  fallback: string,
  code: ActivityBootstrapError["code"]
): ActivityBootstrapError {
  const message = error instanceof Error && error.message ? error.message : fallback;
  return new ActivityBootstrapError(message, code);
}
