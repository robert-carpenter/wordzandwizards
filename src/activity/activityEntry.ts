import { SpellcastGame, type InitialRoomState, type MultiplayerController } from "../game/SpellcastGame";
import dictionaryRaw from "../game/dictionary.txt?raw";
import logoUrl from "../assets/logo.png";
import { soundManager } from "../audio/SoundManager";
import {
  exchangeActivityCode,
  joinActivityRoom,
  kickActivityPlayer,
  leaveActivityRoom,
  startActivityRoom,
  updateActivityRoomRounds,
  type RoomDTO
} from "../network/api";
import { connectActivitySocket, type RoomSocket } from "../network/socket";
import { bootstrapActivity } from "./bootstrapActivity";
import type { ActivityBootstrapResult, ActivityParticipant } from "./activityContext";
import type { ActivityPlatform } from "./activityPlatform";
import { TestActivityPlatform } from "./testActivityPlatform";

const BASE_APP_WIDTH = 1100;
const BASE_APP_HEIGHT = 620;
const DEFAULT_ROUNDS = 5;

const dictionary = new Set(
  dictionaryRaw
    .split(/\r?\n/)
    .map((word) => word.trim().toUpperCase())
    .filter(Boolean)
);

export async function startActivityApp() {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) throw new Error("Missing #app root.");

  const testMode = import.meta.env.DEV && import.meta.env.VITE_ACTIVITY_TEST_MODE === "true";
  if (!testMode && isTopLevelWindow()) {
    document.body.classList.add("app-ready", "web-landing-mode");
    renderWebLanding(app);
    return;
  }

  document.body.classList.add("app-ready", "activity-runtime");
  soundManager.enableAutoUnlock();
  let platform: ActivityPlatform;
  try {
    platform = await createPlatform();
  } catch (error) {
    renderStartupFailure(app, error);
    return;
  }
  const runtime = new ActivityRuntime(app, platform);
  window.addEventListener("resize", updateAppScale);
  updateAppScale();
  await runtime.start();
}

export async function createPlatform(): Promise<ActivityPlatform> {
  if (import.meta.env.DEV && import.meta.env.VITE_ACTIVITY_TEST_MODE === "true") {
    document.documentElement.dataset.activityTestMode = "true";
    return new TestActivityPlatform();
  }
  const { DiscordActivityPlatform } = await import("./discordActivityPlatform");
  return new DiscordActivityPlatform(import.meta.env.VITE_DISCORD_CLIENT_ID ?? "");
}

class ActivityRuntime {
  private bootstrap?: ActivityBootstrapResult;
  private room?: RoomDTO;
  private socket?: RoomSocket;
  private game?: SpellcastGame;
  private playerId = "";
  private participants: ActivityParticipant[] = [];
  private lobbyMessage = "";
  private busy = false;
  private disposed = false;
  private knownPlayerIds = new Set<string>();

  constructor(
    private readonly app: HTMLDivElement,
    private readonly platform: ActivityPlatform
  ) {}

  async start() {
    this.renderLaunch("Connecting to Discord…");
    try {
      this.bootstrap = await bootstrapActivity({
        platform: this.platform,
        exchange: exchangeActivityCode,
        onParticipants: (participants) => {
          this.participants = participants;
          this.updatePipSummary();
        },
        onLayout: (layout) => {
          document.documentElement.dataset.discordLayout = layout;
          updateAppScale();
        },
        onThermal: (thermal) => {
          document.documentElement.dataset.discordThermal = thermal;
        }
      });
      this.playerId = this.bootstrap.context.user.id;
      this.renderLaunch("Joining this Activity instance…");
      const joined = await joinActivityRoom();
      this.room = joined.room;
      this.playerId = joined.player.id;
      this.knownPlayerIds = new Set(joined.room.players.map((player) => player.id));
      this.connectRealtime();
      this.handleRoomUpdate(joined.room);
    } catch (error) {
      this.renderFatal(error);
    }
  }

  private connectRealtime() {
    this.disconnectRealtime();
    this.socket = connectActivitySocket({
      onRoomUpdate: (room) => this.handleRoomUpdate(room),
      onDisconnect: (reason) => {
        if (reason !== "io client disconnect") {
          this.setConnectionState("Reconnecting to the Activity…", true);
        }
      },
      onError: (message, code) => {
        if (code === "ACTIVITY_SESSION_REQUIRED") {
          this.renderFatal(new Error("Your Activity session expired. Relaunch from Discord."), false);
          return;
        }
        this.setConnectionState(message, true);
      },
      onGameError: (message) => {
        this.setConnectionState(message, true);
        window.setTimeout(() => this.setConnectionState("", false), 2600);
      },
      onSelection: (playerId, tileIds) => this.game?.applyRemoteSelection(playerId, tileIds),
      onKicked: () => {
        if (!this.disposed) this.renderFatal(new Error("You were removed from this Activity lobby."), false);
      },
      onConnect: () => this.setConnectionState("", false),
      onReconnect: () => this.setConnectionState("", false)
    });
  }

  private disconnectRealtime() {
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = undefined;
  }

  private handleRoomUpdate(room: RoomDTO) {
    if (this.disposed) return;
    if (!room.players.some((player) => player.id === this.playerId)) {
      this.renderFatal(new Error("You are no longer part of this Activity room."), false);
      return;
    }

    const freshPlayers = room.players.filter((player) => !this.knownPlayerIds.has(player.id));
    if (this.knownPlayerIds.size && freshPlayers.length) soundManager.play("player-join");
    this.knownPlayerIds = new Set(room.players.map((player) => player.id));
    const previousStatus = this.room?.status;
    this.room = room;

    if (room.status === "in-progress") {
      if (!this.game) {
        if (previousStatus === "lobby") soundManager.play("game-start");
        this.enterGame(room);
      } else {
        this.syncGame(room);
      }
      return;
    }

    if (this.game) {
      this.game.dispose();
      this.game = undefined;
      this.lobbyMessage = "Game complete. The host can start the next match.";
    }
    this.renderLobby(room);
  }

  private renderLaunch(message: string) {
    this.disposeGameOnly();
    this.app.replaceChildren(createLaunchCard(message));
    document.body.classList.remove("in-game");
  }

  private renderFatal(error: unknown, retryable = true) {
    void this.bootstrap?.dispose();
    this.disposeGameOnly();
    this.disconnectRealtime();
    const message = error instanceof Error ? error.message : "The Activity could not start.";
    const card = createElement("section", "activity-launch activity-launch--error");
    const icon = createElement("div", "activity-launch__sigil");
    icon.innerHTML = '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>';
    const eyebrow = createElement("div", "activity-launch__eyebrow", "Activity unavailable");
    const heading = createElement("h1", "activity-launch__title", "The portal fizzled");
    const copy = createElement("p", "activity-launch__copy", message);
    card.append(icon, eyebrow, heading, copy);
    if (retryable) {
      const retry = createElement("button", "activity-button activity-button--primary", "Try again") as HTMLButtonElement;
      retry.type = "button";
      retry.addEventListener("click", () => {
        window.location.reload();
      });
      card.append(retry);
    }
    this.app.replaceChildren(card);
    document.body.classList.remove("in-game");
  }

  private renderLobby(room: RoomDTO) {
    document.body.classList.remove("in-game");
    const self = room.players.find((player) => player.id === this.playerId);
    const isHost = room.hostId === this.playerId;
    const shell = createElement("section", "activity-lobby");

    const header = createElement("header", "activity-lobby__header");
    const brand = createElement("div", "activity-lobby__brand");
    const logo = document.createElement("img");
    logo.src = logoUrl;
    logo.alt = "Words & Wizards";
    logo.className = "activity-lobby__logo";
    const titles = createElement("div", "activity-lobby__titles");
    titles.append(
      createElement("div", "activity-lobby__eyebrow", "Discord Activity"),
      createElement("h1", "activity-lobby__title", "Gather your spellcasters")
    );
    brand.append(logo, titles);
    const identity = createElement("div", "activity-identity");
    identity.append(createAvatar(self?.avatar, self?.name ?? "Wizard"));
    const identityCopy = createElement("div", "activity-identity__copy");
    identityCopy.append(
      createElement("strong", "activity-identity__name", self?.name ?? "Wizard"),
      createElement("span", "activity-identity__role", isHost ? "Lobby host" : "Player")
    );
    identity.append(identityCopy);
    header.append(brand, identity);

    const content = createElement("div", "activity-lobby__content");
    const rosterPanel = createElement("div", "activity-lobby__panel activity-roster");
    const rosterHeading = createElement("div", "activity-panel-heading");
    rosterHeading.append(
      createElement("div", "activity-panel-heading__copy", "Players"),
      createElement("span", "activity-count", `${room.players.length}/6`)
    );
    const roster = createElement("div", "activity-roster__list");
    room.players.forEach((player) => {
      const row = createElement("div", `activity-roster__player${player.id === room.hostId ? " activity-roster__player--host" : ""}`);
      const presence = createElement("span", `activity-roster__presence${player.connected ? " activity-roster__presence--online" : ""}`);
      row.append(createAvatar(player.avatar, player.name), presence);
      const playerCopy = createElement("div", "activity-roster__copy");
      playerCopy.append(
        createElement("strong", "activity-roster__name", player.name),
        createElement(
          "span",
          "activity-roster__status",
          player.isSpectator ? "Spectating" : player.id === room.hostId ? "Host" : player.connected ? "Ready" : "Reconnecting"
        )
      );
      row.append(playerCopy);
      if (isHost && player.id !== this.playerId) {
        const kick = createElement("button", "activity-icon-button", "") as HTMLButtonElement;
        kick.type = "button";
        kick.title = `Remove ${player.name}`;
        kick.setAttribute("aria-label", `Remove ${player.name}`);
        kick.innerHTML = '<i class="fa-solid fa-user-minus" aria-hidden="true"></i>';
        kick.addEventListener("click", () => void this.kickPlayer(player.id, player.name));
        row.append(kick);
      }
      roster.append(row);
    });
    rosterPanel.append(rosterHeading, roster);

    const controlsPanel = createElement("div", "activity-lobby__panel activity-lobby__controls");
    controlsPanel.append(createElement("div", "activity-panel-heading__copy", "Match setup"));
    const roundField = createElement("label", "activity-round-field");
    roundField.append(createElement("span", "activity-round-field__label", "Rounds"));
    const roundSelect = document.createElement("select");
    roundSelect.className = "activity-round-field__select";
    [3, 5].forEach((rounds) => {
      const option = document.createElement("option");
      option.value = String(rounds);
      option.textContent = `${rounds} rounds`;
      option.selected = (room.rounds ?? DEFAULT_ROUNDS) === rounds;
      roundSelect.append(option);
    });
    roundSelect.disabled = !isHost || this.busy;
    roundSelect.addEventListener("change", () => void this.changeRounds(Number(roundSelect.value)));
    roundField.append(roundSelect);
    controlsPanel.append(roundField);

    const guidance = createElement(
      "p",
      "activity-lobby__guidance",
      isHost
        ? "Invite friends, choose the match length, then cast the opening spell."
        : "The host will start the match when everyone is ready."
    );
    controlsPanel.append(guidance);

    const invite = createElement("button", "activity-button activity-button--secondary", "Invite friends") as HTMLButtonElement;
    invite.type = "button";
    invite.innerHTML = '<i class="fa-solid fa-user-plus" aria-hidden="true"></i><span>Invite friends</span>';
    invite.addEventListener("click", () => void this.inviteFriends());
    controlsPanel.append(invite);

    if (isHost) {
      const start = createElement("button", "activity-button activity-button--primary", "Start match") as HTMLButtonElement;
      start.type = "button";
      start.disabled = this.busy || !room.players.some((player) => !player.isSpectator);
      start.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>Start match</span>';
      start.addEventListener("click", () => void this.startMatch());
      controlsPanel.append(start);
    }

    const leave = createElement("button", "activity-button activity-button--quiet", "Leave Activity") as HTMLButtonElement;
    leave.type = "button";
    leave.innerHTML = '<i class="fa-solid fa-right-from-bracket" aria-hidden="true"></i><span>Leave Activity</span>';
    leave.addEventListener("click", () => void this.leave());
    controlsPanel.append(leave);
    content.append(rosterPanel, controlsPanel);

    const footer = createElement("footer", "activity-lobby__footer");
    footer.append(
      createElement("span", "activity-lobby__status-dot"),
      createElement(
        "span",
        "activity-lobby__message",
        this.lobbyMessage || `${this.participants.length || room.players.length} connected through Discord`
      )
    );
    shell.append(header, content, footer);
    this.app.replaceChildren(shell, createPipSummary(room));
  }

  private async startMatch() {
    if (this.busy) return;
    this.busy = true;
    this.lobbyMessage = "Starting match…";
    if (this.room) this.renderLobby(this.room);
    try {
      const { room } = await startActivityRoom();
      this.handleRoomUpdate(room);
    } catch (error) {
      this.lobbyMessage = error instanceof Error ? error.message : "Unable to start the match.";
      if (this.room) this.renderLobby(this.room);
    } finally {
      this.busy = false;
    }
  }

  private async changeRounds(rounds: number) {
    if (this.busy || ![3, 5].includes(rounds)) return;
    this.busy = true;
    try {
      const response = await updateActivityRoomRounds(rounds);
      this.handleRoomUpdate(response.room);
    } catch (error) {
      this.lobbyMessage = error instanceof Error ? error.message : "Unable to change rounds.";
      if (this.room) this.renderLobby(this.room);
    } finally {
      this.busy = false;
    }
  }

  private async kickPlayer(playerId: string, name: string) {
    if (!window.confirm(`Remove ${name} from this Activity?`)) return;
    try {
      await kickActivityPlayer(playerId);
    } catch (error) {
      this.lobbyMessage = error instanceof Error ? error.message : "Unable to remove player.";
      if (this.room) this.renderLobby(this.room);
    }
  }

  private async inviteFriends() {
    try {
      await this.platform.openInviteDialog();
      if (document.documentElement.dataset.activityTestMode === "true") {
        this.lobbyMessage = "Test invite URL copied. Open it in another browser profile with a different user query.";
        if (this.room) this.renderLobby(this.room);
      }
    } catch (error) {
      this.lobbyMessage = error instanceof Error ? error.message : "Unable to open Discord invites.";
      if (this.room) this.renderLobby(this.room);
    }
  }

  private enterGame(room: RoomDTO) {
    this.disposeGameOnly();
    document.body.classList.add("in-game");
    const controller = this.createMultiplayerController();
    this.game = new SpellcastGame(this.app, dictionary, roomToInitialState(room, this.playerId), {
      multiplayer: controller
    });
    window.addEventListener("spellcast:exit", this.handleGameExit);
    if (room.game) this.game.applyGameSnapshot(room.game);
    this.game.updateChat(room.chat ?? []);
    this.app.append(createPipSummary(room));
  }

  private syncGame(room: RoomDTO) {
    if (!this.game) return;
    this.game.syncRoomPlayers(
      room.players.map((player) => ({
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        isHost: player.id === room.hostId,
        score: player.score,
        gems: player.gems,
        connected: player.id === this.playerId ? true : player.connected,
        isSpectator: player.isSpectator
      }))
    );
    if (room.game) this.game.applyGameSnapshot(room.game);
    this.game.updateChat(room.chat ?? []);
    this.updatePipSummary();
  }

  private createMultiplayerController(): MultiplayerController {
    return {
      submitWord: (tileIds) => { this.socket?.emit("game:submitWord", { tileIds }); },
      shuffle: () => { this.socket?.emit("game:shuffle"); },
      requestSwapMode: () => { this.socket?.emit("game:swap:start"); },
      applySwap: (tileId, letter) => { this.socket?.emit("game:swap:apply", { tileId, letter }); },
      cancelSwap: () => { this.socket?.emit("game:swap:cancel"); },
      updateSelection: (tileIds) => { this.socket?.emit("game:selection", { tileIds }); },
      kickPlayer: async (playerId) => kickActivityPlayer(playerId),
      skipTurn: (playerId) => { this.socket?.emit("game:skip", { playerId }); },
      sendChatMessage: (text) => { this.socket?.emit("chat:send", { text }); }
    };
  }

  private handleGameExit = () => {
    void this.leave();
  };

  private async leave() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await leaveActivityRoom();
    } catch {
      // Closing the Activity must still be possible if the network is gone.
    }
    this.disconnectRealtime();
    this.disposeGameOnly();
    await this.bootstrap?.dispose();
    this.platform.close();
    if (document.documentElement.dataset.activityTestMode === "true") {
      this.app.replaceChildren(createLaunchCard("Activity test session closed. Refresh to reconnect."));
    }
  }

  private disposeGameOnly() {
    window.removeEventListener("spellcast:exit", this.handleGameExit);
    this.game?.dispose();
    this.game = undefined;
    this.app.replaceChildren();
  }

  private setConnectionState(message: string, visible: boolean) {
    let notice = document.querySelector<HTMLDivElement>(".activity-connection-notice");
    if (!notice) {
      notice = createElement("div", "activity-connection-notice") as HTMLDivElement;
      document.body.append(notice);
    }
    notice.textContent = message;
    notice.classList.toggle("activity-connection-notice--visible", visible);
  }

  private updatePipSummary() {
    if (!this.room) return;
    const current = document.querySelector(".activity-pip-summary");
    current?.replaceWith(createPipSummary(this.room));
  }
}

function roomToInitialState(room: RoomDTO, playerId: string): InitialRoomState {
  return {
    roomId: room.id,
    playerId,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      score: player.score,
      gems: player.gems,
      isHost: player.id === room.hostId,
      connected: player.id === playerId ? true : player.connected,
      isSpectator: player.isSpectator
    })),
    game: room.game,
    rounds: room.rounds,
    chat: room.chat ?? []
  };
}

function createLaunchCard(message: string): HTMLElement {
  const card = createElement("section", "activity-launch");
  const logo = document.createElement("img");
  logo.src = logoUrl;
  logo.alt = "Words & Wizards";
  logo.className = "activity-launch__logo";
  card.append(
    logo,
    createElement("div", "activity-launch__eyebrow", "Discord Activity"),
    createElement("h1", "activity-launch__title", "Opening the spellbook"),
    createElement("p", "activity-launch__copy", message),
    createElement("div", "activity-launch__loader")
  );
  return card;
}

function renderStartupFailure(app: HTMLDivElement, error: unknown) {
  const message = error instanceof Error ? error.message : "Launch this Activity from Discord.";
  const card = createElement("section", "activity-launch activity-launch--error");
  const icon = createElement("div", "activity-launch__sigil");
  icon.innerHTML = '<i class="fa-brands fa-discord" aria-hidden="true"></i>';
  card.append(
    icon,
    createElement("div", "activity-launch__eyebrow", "Discord Activity"),
    createElement("h1", "activity-launch__title", "Launch from Discord"),
    createElement("p", "activity-launch__copy", message)
  );
  app.replaceChildren(card);
}

function renderWebLanding(app: HTMLDivElement) {
  document.title = "Words & Wizards — Play on Discord";
  const landing = createElement("main", "web-landing");

  const brand = createElement("header", "web-landing__brand");
  const logo = document.createElement("img");
  logo.src = logoUrl;
  logo.alt = "Words & Wizards";
  logo.className = "web-landing__logo";
  brand.append(logo);

  const hero = createElement("section", "web-landing__hero");
  const heroCopy = createElement("div", "web-landing__hero-copy");
  const badge = createElement("div", "web-landing__badge");
  badge.innerHTML = '<i class="fa-brands fa-discord" aria-hidden="true"></i><span>Unlisted Discord Activity</span>';
  const title = createElement("h1", "web-landing__title", "The spellbook has moved into Discord.");
  const description = createElement(
    "p",
    "web-landing__description",
    "Words & Wizards now plays directly inside Discord. Anyone can install the unlisted Activity from this page; approved testers can launch it from their Discord Apps menu."
  );
  const actions = createElement("div", "web-landing__actions");
  const installUrl = getDiscordInstallUrl();
  if (installUrl) {
    actions.append(
      createLandingLink(
        installUrl,
        "Install on Discord",
        "web-landing__button web-landing__button--discord",
        "fa-brands fa-discord"
      )
    );
  }
  actions.append(
    createLandingLink(
      "https://discord.com/app",
      installUrl ? "Open Discord" : "Open Discord to play",
      installUrl
        ? "web-landing__button web-landing__button--secondary"
        : "web-landing__button web-landing__button--discord",
      "fa-solid fa-arrow-up-right-from-square"
    )
  );
  heroCopy.append(badge, title, description, actions);

  const instructions = createElement("aside", "web-landing__instructions");
  instructions.id = "how-to-launch";
  instructions.append(
    createElement("div", "web-landing__instructions-eyebrow", "Direct access"),
    createElement("h2", "web-landing__instructions-title", "Install in three steps")
  );
  const steps = createElement("ol", "web-landing__steps");
  const installSteps = installUrl
    ? [
        ["Install the Activity", "Use the button on this page, then add it to your account or a server you manage."],
        ["Open the Apps menu", "In a text channel, DM, group DM, or voice channel, select the Apps icon."],
        ["Launch when approved", "Approved App Testers can open Words & Wizards from Installed Apps, choose Launch, then invite friends."]
      ]
    : [
        ["Install link coming soon", "The direct Discord installation link is still being configured."],
        ["Open the Apps menu", "In a text channel, DM, group DM, or voice channel, select the Apps icon."],
        ["Launch when approved", "Approved App Testers can open Words & Wizards from Installed Apps, choose Launch, then invite friends."]
      ];
  installSteps.forEach(([heading, copy], index) => {
    const step = createElement("li", "web-landing__step");
    const stepCopy = createElement("div", "web-landing__step-copy");
    stepCopy.append(
      createElement("strong", "web-landing__step-title", heading),
      createElement("span", "web-landing__step-description", copy)
    );
    step.append(createElement("span", "web-landing__step-number", String(index + 1)), stepCopy);
    steps.append(step);
  });
  const discoveryNote = createElement("p", "web-landing__discovery-note");
  discoveryNote.innerHTML = installUrl
    ? '<i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>This Activity is unlisted. Anyone with this link can install it, but Discord limits unverified launches to approved App Testers and the development team.</span>'
    : '<i class="fa-solid fa-circle-info" aria-hidden="true"></i><span>This Activity is unlisted. Its direct installation link is still being configured.</span>';
  instructions.append(steps, discoveryNote);
  hero.append(heroCopy, instructions);

  landing.append(brand, hero);
  app.replaceChildren(landing);
}

function createLandingLink(
  href: string,
  label: string,
  className: string,
  iconClass?: string
): HTMLAnchorElement {
  const link = createElement("a", className) as HTMLAnchorElement;
  link.href = href;
  if (!href.startsWith("#")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  if (iconClass) link.innerHTML = `<i class="${iconClass}" aria-hidden="true"></i><span>${label}</span>`;
  else link.textContent = label;
  return link;
}

function getDiscordInstallUrl(): string | undefined {
  const configured = import.meta.env.VITE_DISCORD_INSTALL_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:" && /(^|\.)discord\.com$/i.test(url.hostname)) {
        return url.toString();
      }
    } catch {
      // Fall back to Discord's standard installation URL below.
    }
  }

  const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID?.trim();
  if (!clientId || !/^\d{16,22}$/.test(clientId)) return undefined;
  return `https://discord.com/oauth2/authorize?client_id=${clientId}`;
}

function isTopLevelWindow(): boolean {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

function createPipSummary(room: RoomDTO): HTMLElement {
  const summary = createElement("aside", "activity-pip-summary");
  const current = room.game ? room.players[room.game.currentPlayerIndex] : undefined;
  summary.append(
    createElement("div", "activity-pip-summary__eyebrow", room.status === "lobby" ? "In lobby" : `Round ${room.game?.round ?? 1} of ${room.rounds}`),
    createElement("strong", "activity-pip-summary__title", room.status === "lobby" ? `${room.players.length} spellcasters` : `${current?.name ?? "Wizard"}'s turn`),
    createElement("span", "activity-pip-summary__copy", "Return to focus mode to play")
  );
  return summary;
}

function createAvatar(url: string | undefined, name: string): HTMLElement {
  if (url) {
    const image = document.createElement("img");
    image.className = "activity-avatar";
    image.src = url;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    return image;
  }
  return createElement("span", "activity-avatar activity-avatar--fallback", name.charAt(0).toUpperCase());
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function updateAppScale() {
  const layout = document.documentElement.dataset.discordLayout;
  const shell = document.querySelector<HTMLElement>(".app-viewport");
  if (!shell) return;
  if (layout === "pip") {
    document.documentElement.style.setProperty("--app-scale", "1");
    return;
  }
  const horizontalInset = 24;
  const verticalInset = 24;
  const scale = Math.min(
    (window.innerWidth - horizontalInset) / BASE_APP_WIDTH,
    (window.innerHeight - verticalInset) / BASE_APP_HEIGHT,
    1
  );
  document.documentElement.style.setProperty("--app-scale", Math.max(scale, 0.35).toString());
}
