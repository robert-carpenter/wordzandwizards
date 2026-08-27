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
    const legalPage = getLegalPage(window.location.pathname);
    if (legalPage) {
      document.body.classList.add("web-legal-mode");
      renderLegalPage(app, legalPage);
    } else {
      renderWebLanding(app);
    }
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
  setPageMetadata(
    "Words & Wizards — Play on Discord",
    "Install Words & Wizards and play the social word-spelling game directly inside Discord."
  );
  const landing = createElement("main", "web-landing");
  const brand = createWebBrand();

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

  landing.append(brand, hero, createSiteFooter("home"));
  app.replaceChildren(landing);
}

type LegalPage = "terms" | "privacy";

interface LegalSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  contact?: boolean;
}

const LEGAL_CONTACT_EMAIL = "support@wordsandwizards.app";
const LEGAL_UPDATED = "August 27, 2026";

function getLegalPage(pathname: string): LegalPage | undefined {
  const normalized = pathname.toLowerCase().replace(/\/+$/, "") || "/";
  if (normalized === "/terms" || normalized === "/terms-of-service") return "terms";
  if (normalized === "/privacy" || normalized === "/privacy-policy") return "privacy";
  return undefined;
}

function renderLegalPage(app: HTMLDivElement, page: LegalPage) {
  const isTerms = page === "terms";
  const title = isTerms ? "Terms of Service" : "Privacy Policy";
  const description = isTerms
    ? "Terms governing use of the Words & Wizards Discord Activity."
    : "How the Words & Wizards Discord Activity collects, uses, shares, and retains information.";
  setPageMetadata(`${title} — Words & Wizards`, description);

  const shell = createElement("main", "web-legal");
  const article = createElement("article", "web-legal__document");
  const header = createElement("header", "web-legal__document-header");
  header.append(
    createElement("div", "web-legal__eyebrow", "Words & Wizards"),
    createElement("h1", "web-legal__title", title),
    createElement("p", "web-legal__updated", `Last updated ${LEGAL_UPDATED}`),
    createElement(
      "p",
      "web-legal__summary",
      isTerms
        ? "These terms explain the rules for using the Words & Wizards Discord Activity."
        : "We collect only the Discord identity, session, and gameplay information needed to run the Activity. We do not sell personal information or use it for advertising."
    )
  );
  article.append(header);

  const sections = isTerms ? getTermsSections() : getPrivacySections();
  sections.forEach((section, index) => {
    const sectionElement = createElement("section", "web-legal__section");
    sectionElement.id = `${index + 1}-${slugify(section.heading)}`;
    sectionElement.append(createElement("h2", "web-legal__section-title", section.heading));
    section.paragraphs.forEach((paragraph) => {
      sectionElement.append(createElement("p", "web-legal__paragraph", paragraph));
    });
    if (section.bullets?.length) {
      const list = createElement("ul", "web-legal__list");
      section.bullets.forEach((item) => list.append(createElement("li", "web-legal__list-item", item)));
      sectionElement.append(list);
    }
    if (section.contact) sectionElement.append(createLegalContact());
    article.append(sectionElement);
  });

  shell.append(createWebBrand(), article, createSiteFooter(page));
  app.replaceChildren(shell);
}

function getTermsSections(): LegalSection[] {
  return [
    {
      heading: "Acceptance of these terms",
      paragraphs: [
        "These Terms of Service (\"Terms\") govern your access to and use of Words & Wizards, including its Discord Activity, website, and related services (collectively, the \"Service\"). By installing, launching, or using the Service, you agree to these Terms. If you do not agree, do not use the Service.",
        "If you use the Service for an organization, you represent that you have authority to accept these Terms for that organization."
      ]
    },
    {
      heading: "Eligibility and Discord",
      paragraphs: [
        "You must meet the minimum age required to use Discord in your country and be permitted to use Discord under its terms. If local law requires consent from a parent or guardian, you must have that consent.",
        "Words & Wizards is an independent application and is not endorsed by or affiliated with Discord Inc. Your use of Discord remains subject to Discord's Terms of Service, Community Guidelines, and other applicable policies. These Terms do not replace or modify your agreement with Discord."
      ]
    },
    {
      heading: "The Service",
      paragraphs: [
        "Words & Wizards is a multiplayer word-spelling game that runs inside Discord. Players join an Activity instance, form words from a shared board, use game abilities, and may exchange in-game chat messages.",
        "The Service may be changed, interrupted, limited, or discontinued at any time. Features, rules, availability, and supported Discord clients may change as the game and Discord platform evolve."
      ]
    },
    {
      heading: "Acceptable use",
      paragraphs: ["You agree to use the Service lawfully and in a way that does not harm other players, the Service, or Discord."],
      bullets: [
        "Do not harass, threaten, impersonate, or abuse another person.",
        "Do not submit unlawful, hateful, sexually explicit, infringing, or otherwise harmful content through chat or other inputs.",
        "Do not exploit bugs, automate gameplay, manipulate scores, or interfere with fair play.",
        "Do not probe, overload, disrupt, reverse engineer, or attempt unauthorized access to the Service or another user's session.",
        "Do not use the Service to violate Discord's rules or any applicable law."
      ]
    },
    {
      heading: "Your content and conduct",
      paragraphs: [
        "You remain responsible for words, chat messages, and other content you submit. You retain any rights you already have in that content and grant us a limited, non-exclusive permission to process and display it only as needed to operate the current game session, protect the Service, and comply with law.",
        "We may remove content, end sessions, or restrict access when reasonably necessary to enforce these Terms, protect users, or keep the Service secure."
      ]
    },
    {
      heading: "Intellectual property",
      paragraphs: [
        "The Service, including its software, game design, artwork, branding, and other materials, is owned by the Words & Wizards operator or its licensors and is protected by applicable intellectual-property laws. These Terms give you a limited, revocable, non-transferable right to use the Service for personal, non-commercial play; they do not transfer ownership."
      ]
    },
    {
      heading: "Privacy",
      paragraphs: [
        "Our Privacy Policy explains what information the Service processes and how it is used, shared, retained, and deleted. By using the Service, you acknowledge those practices."
      ]
    },
    {
      heading: "Disclaimers",
      paragraphs: [
        "To the fullest extent permitted by law, the Service is provided \"as is\" and \"as available.\" We do not promise that it will always be available, uninterrupted, secure, or error-free, or that every result, score, or word ruling will be accurate.",
        "Nothing in these Terms excludes warranties or rights that cannot legally be excluded."
      ]
    },
    {
      heading: "Limitation of liability",
      paragraphs: [
        "To the fullest extent permitted by law, the Words & Wizards operator will not be liable for indirect, incidental, special, consequential, exemplary, or punitive damages, or for loss of data, goodwill, profits, or opportunities arising from the Service. Any liability that cannot be excluded will be limited to the minimum amount permitted by applicable law."
      ]
    },
    {
      heading: "Suspension and termination",
      paragraphs: [
        "You may stop using or uninstall the Service at any time. We may suspend or terminate access when you violate these Terms, create security or legal risk, harm other users, or when continued operation is no longer practical. Provisions that by their nature should survive termination will continue to apply."
      ]
    },
    {
      heading: "Changes and general terms",
      paragraphs: [
        "We may update these Terms as the Service or legal requirements change. The date above shows the latest revision. Continued use after an update means you accept the revised Terms; if you do not agree, stop using the Service.",
        "If part of these Terms is unenforceable, the remaining provisions remain effective. A failure to enforce a provision is not a waiver. These Terms and the Privacy Policy form the agreement between you and the Words & Wizards operator regarding the Service, subject to rights that cannot be waived under applicable law."
      ]
    },
    {
      heading: "Contact",
      paragraphs: ["Questions about these Terms can be sent to:"],
      contact: true
    }
  ];
}

function getPrivacySections(): LegalSection[] {
  return [
    {
      heading: "Scope",
      paragraphs: [
        "This Privacy Policy explains how Words & Wizards (\"we,\" \"us,\" or \"our\") processes information when you use the Words & Wizards Discord Activity, website, and related services. It does not govern Discord's own processing; Discord's Privacy Policy applies to Discord's services."
      ]
    },
    {
      heading: "Information we process",
      paragraphs: ["We process the following limited categories of information to provide the Service:"],
      bullets: [
        "Discord identity data: your Discord user ID, username, display name, and avatar URL.",
        "Activity session data: the Discord Activity instance ID, a random session ID, join and connection status, host status, and session timestamps.",
        "Authentication data: the Discord authorization code and access token are processed transiently to verify the launch and authenticate the Discord SDK. They are not stored in room records or a persistent database.",
        "Gameplay data: scores, gems, turns, selected tiles, submitted words, game settings, and other state needed to synchronize a match.",
        "Content you submit: in-game chat messages and other text entered into the Activity.",
        "Technical data: IP address, browser or client information, request timestamps, request identifiers, cookie data, and diagnostic or security events that may be processed by our server and hosting provider."
      ]
    },
    {
      heading: "How we use information",
      paragraphs: ["We use the information above only for the following purposes:"],
      bullets: [
        "Authenticate your Discord Activity launch and associate you with the correct Activity instance.",
        "Create and synchronize multiplayer rooms, gameplay, chat, scores, and host controls.",
        "Maintain session security, prevent replay or unauthorized access, enforce rate limits, and investigate abuse or failures.",
        "Operate, troubleshoot, protect, and improve the reliability of the Service.",
        "Comply with legal obligations and enforce our Terms of Service."
      ]
    },
    {
      heading: "How we share information",
      paragraphs: [
        "We do not sell personal information, serve behavioral advertising, or share personal information with data brokers.",
        "Information may be processed by Discord to operate the Activity and by infrastructure providers that host and deliver the Service, currently including Railway. Those providers process information under their own terms and privacy policies. We may also disclose information when required by law, to protect users or the Service, or in connection with a reorganization or transfer of the Service subject to appropriate safeguards."
      ]
    },
    {
      heading: "Storage and retention",
      paragraphs: [
        "Words & Wizards does not currently use a persistent user or gameplay database. Room, gameplay, player, and chat state is held in server memory while an Activity room exists. A disconnected player is normally removed after approximately five minutes, and the room and its content are deleted when the last player leaves or is removed. In-memory state is also erased when the server restarts.",
        "The signed Activity session cookie contains your session and Discord identity details and expires after six hours. Leaving the Activity clears that cookie through the Service. Discord, your browser, and infrastructure providers may retain their own records for different periods under their policies and operational settings.",
        "If persistent storage or analytics are added later, this policy will be updated before those practices are introduced."
      ]
    },
    {
      heading: "Cookies",
      paragraphs: [
        "The Service uses one strictly necessary, signed session cookie to keep your authenticated Activity session connected to the correct Discord user and Activity instance. It is secure in production and is not used for advertising or cross-site tracking. The Service does not currently use analytics or marketing cookies."
      ]
    },
    {
      heading: "Your choices and deletion requests",
      paragraphs: [
        "You can stop current gameplay processing by leaving the Activity. When all players leave or disconnect, the in-memory room and chat data are removed as described above.",
        "You may request access to or deletion of personal information under applicable law by contacting us. Include your Discord user ID and enough detail to identify the request, but do not send your Discord password, bot token, OAuth token, or other credentials. Because the Service is primarily ephemeral, we may have no persistent gameplay record to locate. We may need to verify that a request relates to you before responding."
      ],
      contact: true
    },
    {
      heading: "Security",
      paragraphs: [
        "We use safeguards designed for the limited data we process, including signed, time-limited sessions, secure production cookies, authorization-code replay protection, origin checks, input limits, and rate limiting. No system is perfectly secure, so we cannot guarantee absolute security. If you believe the Service or your data may have been compromised, contact us promptly."
      ]
    },
    {
      heading: "Children's privacy",
      paragraphs: [
        "The Service is intended only for people who are old enough to use Discord under Discord's rules and applicable law. We do not knowingly collect information from anyone below that minimum age. If you believe a child has provided information in violation of those requirements, contact us so we can investigate and delete any information we control."
      ]
    },
    {
      heading: "International processing",
      paragraphs: [
        "Discord and our hosting infrastructure may process information in countries other than the one where you live. Those countries may have different data-protection laws. Where required, service providers are responsible for using appropriate safeguards for their processing."
      ]
    },
    {
      heading: "Changes to this policy",
      paragraphs: [
        "We may update this Privacy Policy when the Service, our data practices, or legal requirements change. We will post the revised policy here and update the date above. Material changes will be communicated through the Service or another reasonable channel when required."
      ]
    },
    {
      heading: "Contact",
      paragraphs: ["For privacy questions, rights requests, or security reports, contact:"],
      contact: true
    }
  ];
}

function createWebBrand(): HTMLElement {
  const brand = createElement("header", "web-landing__brand");
  const home = createElement("a", "web-landing__brand-link") as HTMLAnchorElement;
  home.href = "/";
  home.setAttribute("aria-label", "Words & Wizards home");
  const logo = document.createElement("img");
  logo.src = logoUrl;
  logo.alt = "Words & Wizards";
  logo.className = "web-landing__logo";
  home.append(logo);
  brand.append(home);
  return brand;
}

function createSiteFooter(current: "home" | LegalPage): HTMLElement {
  const footer = createElement("footer", "web-site-footer");
  const copyright = createElement("span", "web-site-footer__copyright", "© 2026 Words & Wizards");
  const nav = createElement("nav", "web-site-footer__links");
  nav.setAttribute("aria-label", "Legal and support links");
  nav.append(
    createFooterLink("/", "Home", current === "home"),
    createFooterLink("/terms", "Terms of Service", current === "terms"),
    createFooterLink("/privacy", "Privacy Policy", current === "privacy"),
    createFooterLink(`mailto:${LEGAL_CONTACT_EMAIL}`, "Support")
  );
  footer.append(copyright, nav);
  return footer;
}

function createFooterLink(href: string, label: string, current = false): HTMLAnchorElement {
  const link = createElement("a", "web-site-footer__link", label) as HTMLAnchorElement;
  link.href = href;
  if (current) link.setAttribute("aria-current", "page");
  return link;
}

function createLegalContact(): HTMLElement {
  const contact = createElement("p", "web-legal__contact");
  const link = createElement("a", "web-legal__contact-link", LEGAL_CONTACT_EMAIL) as HTMLAnchorElement;
  link.href = `mailto:${LEGAL_CONTACT_EMAIL}`;
  contact.append(link);
  return contact;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function setPageMetadata(title: string, description: string) {
  document.title = title;
  document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", description);
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
