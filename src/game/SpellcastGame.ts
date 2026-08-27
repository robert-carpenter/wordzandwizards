import { OrthographicCamera, Raycaster, Scene, Vector2, WebGLRenderer } from "three";
import { gsap } from "gsap";
import { MotionPathPlugin } from "gsap/MotionPathPlugin";
import type { GameSnapshot } from "../shared/gameTypes";
import type { ChatMessage } from "../shared/chat";
import { OfflineAdapter } from "./offlineAdapter";
import { LETTER_VALUES } from "../shared/constants";
import { WordBoard, Tile } from "./WordBoard";
import { soundManager } from "../audio/SoundManager";

const MAX_PLAYER_NAME_LENGTH = "Storm Caller".length;

export interface Player {
  id: string;
  name: string;
  avatar?: string;
  score: number;
  gems: number;
  isHost: boolean;
  connected: boolean;
  isSpectator: boolean;
  lastWord?: string;
  lastWordPoints?: number;
  bestWord?: string;
  bestWordPoints?: number;
}

export interface InitialRoomState {
  roomId: string;
  playerId: string;
  players: Player[];
  game?: GameSnapshot;
  rounds?: number;
  chat?: ChatMessage[];
}

export interface MultiplayerController {
  submitWord(tileIds: string[]): void | Promise<void>;
  shuffle(): void | Promise<void>;
  requestSwapMode(): void | Promise<void>;
  applySwap(tileId: string, letter: string): void | Promise<void>;
  cancelSwap(): void | Promise<void>;
  updateSelection(tileIds: string[]): void | Promise<void>;
  kickPlayer?(playerId: string): void | Promise<void>;
  skipTurn?(playerId: string): void | Promise<void>;
  sendChatMessage?(text: string): void | Promise<void>;
}

export class SpellcastGame {
  private frustumSize = 16;
  private totalRounds = 5;
  private container: HTMLElement;
  private boardArea: HTMLDivElement;
  private boardViewport: HTMLDivElement;
  private sidebar: HTMLDivElement;
  private scene = new Scene();
  private camera: OrthographicCamera;
  private renderer: WebGLRenderer;
  private board: WordBoard;
  private pointer = new Vector2();
  private raycaster = new Raycaster();
  private animationId = 0;
  private wordBox: HTMLElement;
  private playersListEl: HTMLElement;
  private submitButton: HTMLButtonElement;
  private resetButton: HTMLButtonElement;
  private shuffleButton: HTMLButtonElement;
  private rerollButton: HTMLButtonElement;
  private controlsWrap: HTMLElement;
  private powerPanel: HTMLDivElement;
  private dictionary: Set<string>;
  private round = 1;
  private roundLabel!: HTMLElement;
  private isModalOpen = false;
  private swapMode = false;
  private gameLog: string[] = [];
  private lastLogLength = 0;
  private players: Player[];
  private roomId?: string;
  private playerId?: string;
  private isMultiplayer = false;
  private isSpectator = false;
  private multiplayer: MultiplayerController | null = null;
  private currentPlayerIndex = 0;
  private serverCompletionHandled = false;
  private pendingSnapshot?: GameSnapshot;
  private lastSubmissionToken?: string;
  private inputTarget: HTMLElement;
  private wasMyTurn = false;
  private compactLayoutQuery = window.matchMedia("(max-width: 300px), (max-height: 320px)");
  private wordBoxConfettiTimer?: number;
  private turnStartTime = performance.now();
  private turnTimerId: number | null = null;
  private turnTimerEl?: HTMLElement;
  private dictionaryWords: string[];
  private submitAnimContainer?: HTMLElement;
  private motionRegistered = false;
  private lastSparkleTime = 0;
  private offlineAdapter?: OfflineAdapter;
  private chatMessages: ChatMessage[] = [];
  private chatUI?: { overlay: HTMLElement; list: HTMLElement; input: HTMLInputElement };
  private chatButton?: HTMLButtonElement;
  private chatBadge?: HTMLElement;
  private chatUnread = 0;
  private lastChatReadAt = 0;
  private qualityObserver?: MutationObserver;

  private syncOfflineSnapshot() {
    const snap = this.offlineAdapter?.snapshot();
    if (!snap || !this.offlineAdapter) return;
    if (!this.playersListEl) {
      this.pendingSnapshot = snap;
      return;
    }
    const adapterPlayers = this.offlineAdapter.getPlayers();
    if (adapterPlayers.length) {
      this.players = adapterPlayers.map((p) => ({
        ...p,
        lastWord: this.players.find((pp) => pp.id === p.id)?.lastWord,
        lastWordPoints: this.players.find((pp) => pp.id === p.id)?.lastWordPoints,
        bestWord: this.players.find((pp) => pp.id === p.id)?.bestWord,
        bestWordPoints: this.players.find((pp) => pp.id === p.id)?.bestWordPoints
      }));
    }
    this.applyGameSnapshot(snap);
    this.updateRoundLabel();
    this.renderPlayers();
  }

  constructor(
    target: HTMLElement,
    dictionary: Set<string>,
    roomState?: InitialRoomState,
    options?: { multiplayer?: MultiplayerController }
  ) {
    this.container = target;
    this.dictionary = dictionary;
    this.dictionaryWords = Array.from(dictionary).sort();
    if (!this.motionRegistered) {
      gsap.registerPlugin(MotionPathPlugin);
      this.motionRegistered = true;
    }
    this.multiplayer = options?.multiplayer ?? null;
    this.isMultiplayer = Boolean(roomState ?? options?.multiplayer);
    if (roomState && roomState.players.length) {
      this.players = roomState.players.map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        score: p.score ?? 0,
        gems: p.gems ?? 3,
        isHost: p.isHost ?? false,
        connected: p.connected ?? true,
        isSpectator: p.isSpectator ?? false,
        lastWord: undefined,
        lastWordPoints: undefined,
        bestWord: undefined,
        bestWordPoints: undefined
      }));
      this.roomId = roomState.roomId;
      this.playerId = roomState.playerId;
      if (roomState.game?.totalRounds) {
        this.totalRounds = roomState.game.totalRounds;
      } else if (roomState.rounds) {
        this.totalRounds = roomState.rounds;
      }
      this.chatMessages = roomState.chat ?? [];
      if (this.chatMessages.length) {
        const latest = Math.max(...this.chatMessages.map((m) => m.createdAt));
        this.lastChatReadAt = latest;
      }
    } else {
      this.players = [
        {
        id: "local-1",
        name: "Player 1",
        score: 0,
        gems: 3,
        isHost: true,
        connected: true,
        isSpectator: false,
        lastWord: undefined,
        lastWordPoints: undefined,
        bestWord: undefined,
        bestWordPoints: undefined
      },
      {
        id: "local-2",
        name: "Player 2",
        score: 0,
        gems: 3,
        isHost: false,
        connected: true,
        isSpectator: false,
        lastWord: undefined,
        lastWordPoints: undefined,
        bestWord: undefined,
        bestWordPoints: undefined
      }
    ];
  }
    const myId = roomState?.playerId;
    if (myId) {
      const me = this.players.find((player) => player.id === myId);
      this.isSpectator = Boolean(me?.isSpectator);
    }
    this.container.innerHTML = "";
    this.container.classList.add("game-shell");

    this.boardArea = document.createElement("div");
    this.boardArea.className = "board-area";
    this.boardViewport = document.createElement("div");
    this.boardViewport.className = "board-viewport";
    this.sidebar = document.createElement("div");
    this.sidebar.className = "sidebar";
    this.container.append(this.boardArea, this.sidebar);

    this.wordBox = this.createWordBox();
    this.boardArea.append(this.boardViewport);

    this.renderer = new WebGLRenderer({
      antialias: true
    });
    this.renderer.setClearColor(0x000000, 0);
    this.applyRendererQuality();
    this.qualityObserver = new MutationObserver(() => {
      this.applyRendererQuality();
      this.onResize();
    });
    this.qualityObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-discord-layout", "data-discord-thermal"]
    });
    this.boardViewport.appendChild(this.renderer.domElement);
    this.inputTarget = this.renderer.domElement;

    const aspect = this.boardViewport.clientWidth / this.boardViewport.clientHeight;
    this.camera = new OrthographicCamera(
      (-this.frustumSize * aspect) / 2,
      (this.frustumSize * aspect) / 2,
      this.frustumSize / 2,
      -this.frustumSize / 2,
      0.1,
      50
    );
    this.camera.position.set(0, 0, 15);
    this.camera.lookAt(0, 0, 0);

    this.board = new WordBoard(5, 5);
    this.board.scale.setScalar(1.75 * 1.1); // 10% bump on top of previous 1.75 scale
    this.scene.add(this.board);
    this.updateBoardPlacement();
    if (roomState?.game) {
      this.pendingSnapshot = roomState.game;
    } else if (!this.isMultiplayer) {
      this.offlineAdapter = new OfflineAdapter({ totalRounds: this.totalRounds });
      this.offlineAdapter.seedPlayers(
        this.players.map((p) => ({ id: p.id, name: p.name, isHost: p.isHost }))
      );
      this.pendingSnapshot = this.offlineAdapter.snapshot();
    }

    const powerUi = this.createPowerPanel();
    this.powerPanel = powerUi.panel;
    this.shuffleButton = powerUi.shuffleBtn;
    this.rerollButton = powerUi.rerollBtn;
    const hud = this.createHud();
    this.controlsWrap = hud.controls;
    this.submitButton = hud.submitBtn;
    this.resetButton = hud.resetBtn;

    this.playersListEl = this.createSidebar();
    this.renderPlayers();
    this.restartTurnTimer();
    this.updateTurnTimerDisplay();
    if (this.pendingSnapshot) {
      this.applyGameSnapshot(this.pendingSnapshot);
      this.pendingSnapshot = undefined;
    }

    this.onResize();

    this.inputTarget.addEventListener("pointermove", this.onPointerMove);
    this.inputTarget.addEventListener("pointerdown", this.onPointerDown);
    this.inputTarget.addEventListener("click", this.onClick);
    window.addEventListener("resize", this.onResize);
    this.submitButton.addEventListener("click", this.onSubmitWord);
    this.resetButton.addEventListener("click", this.onResetWord);
    this.shuffleButton.addEventListener("click", this.onShuffle);
    this.rerollButton.addEventListener("click", this.onRerollLetter);

    this.tick = this.tick.bind(this);
    this.updateTurnUi();
    this.tick();
  }

  public dispose() {
    cancelAnimationFrame(this.animationId);
    if (this.turnTimerId !== null) {
      window.clearInterval(this.turnTimerId);
      this.turnTimerId = null;
    }
    this.inputTarget.removeEventListener("pointermove", this.onPointerMove);
    this.inputTarget.removeEventListener("pointerdown", this.onPointerDown);
    this.inputTarget.removeEventListener("click", this.onClick);
    window.removeEventListener("resize", this.onResize);
    this.submitButton.removeEventListener("click", this.onSubmitWord);
    this.resetButton.removeEventListener("click", this.onResetWord);
    this.shuffleButton.removeEventListener("click", this.onShuffle);
    this.rerollButton.removeEventListener("click", this.onRerollLetter);
    this.qualityObserver?.disconnect();
    this.qualityObserver = undefined;
    this.renderer.dispose();
  }

  private createHud() {
    const controls = document.createElement("div");
    controls.className = "hud__controls";

    const submitBtn = document.createElement("button");
    submitBtn.className = "hud__btn primary";
    submitBtn.type = "button";
    submitBtn.title = "Cast the selected word";
    const submitIcon = document.createElement("i");
    submitIcon.className = "fa-solid fa-wand-magic-sparkles hud__btn-icon";
    const submitLabel = document.createElement("span");
    submitLabel.textContent = "Cast Word";
    submitBtn.append(submitIcon, submitLabel);

    const resetBtn = document.createElement("button");
    resetBtn.className = "hud__btn";
    resetBtn.type = "button";
    resetBtn.title = "Clear the selected tiles";
    const resetIcon = document.createElement("i");
    resetIcon.className = "fa-solid fa-arrow-rotate-left hud__btn-icon";
    const resetLabel = document.createElement("span");
    resetLabel.textContent = "Clear";
    resetBtn.append(resetIcon, resetLabel);

    controls.append(submitBtn, resetBtn);
    this.boardViewport.appendChild(controls);
    this.submitAnimContainer = document.createElement("div");
    this.submitAnimContainer.className = "submit-anim-layer";
    this.container.appendChild(this.submitAnimContainer);

    return { controls, submitBtn, resetBtn };
  }

  private createPowerPanel() {
    const panel = document.createElement("div");
    panel.className = "power-panel";

    const title = document.createElement("div");
    title.className = "power-panel__title";
    const titleIcon = document.createElement("i");
    titleIcon.className = "fa-solid fa-bolt";
    const titleLabel = document.createElement("span");
    titleLabel.textContent = "Power Ups";
    title.append(titleIcon, titleLabel);

    const controls = document.createElement("div");
    controls.className = "power-panel__controls";

    const shuffleBtn = document.createElement("button");
    shuffleBtn.className = "power-panel__btn";
    shuffleBtn.type = "button";
    shuffleBtn.title = "Shuffle the board for 1 gem";
    const shuffleIcon = document.createElement("i");
    shuffleIcon.className = "fa-solid fa-shuffle power-panel__btn-icon";
    const shuffleLabel = document.createElement("span");
    shuffleLabel.textContent = "Shuffle";
    const shuffleGem = document.createElement("span");
    shuffleGem.className = "pill pill--gem power-panel__pill";
    shuffleGem.innerHTML = `<i class="fa-solid fa-gem pill__icon" aria-hidden="true"></i><span>1</span>`;
    shuffleGem.setAttribute("aria-label", "Costs 1 gem");
    shuffleBtn.append(shuffleIcon, shuffleLabel, shuffleGem);

    const rerollBtn = document.createElement("button");
    rerollBtn.className = "power-panel__btn";
    rerollBtn.type = "button";
    rerollBtn.title = "Swap one letter for 3 gems";
    const rerollIcon = document.createElement("i");
    rerollIcon.className = "fa-solid fa-arrow-right-arrow-left power-panel__btn-icon";
    const rerollLabel = document.createElement("span");
    rerollLabel.textContent = "Swap Letter";
    const rerollGem = document.createElement("span");
    rerollGem.className = "pill pill--gem power-panel__pill";
    rerollGem.innerHTML = `<i class="fa-solid fa-gem pill__icon" aria-hidden="true"></i><span>3</span>`;
    rerollGem.setAttribute("aria-label", "Costs 3 gems");
    rerollBtn.append(rerollIcon, rerollLabel, rerollGem);

    controls.append(shuffleBtn, rerollBtn);
    panel.append(title, controls);
    this.boardViewport.appendChild(panel);

    return { panel, shuffleBtn, rerollBtn };
  }
  private createWordBox() {
    const box = document.createElement("div");
    box.className = "word-box";
    box.textContent = "—";
    this.boardViewport.appendChild(box);
    return box;
  }

  private createSidebar() {
    const wrap = document.createElement("div");
    wrap.className = "sidebar__content";

    const heading = document.createElement("div");
    heading.className = "sidebar__heading";
    const headingCopy = document.createElement("div");
    headingCopy.className = "sidebar__heading-copy";
    const headingEyebrow = document.createElement("span");
    headingEyebrow.className = "sidebar__eyebrow";
    headingEyebrow.textContent = "Match roster";
    const headingTitle = document.createElement("span");
    headingTitle.className = "sidebar__title";
    headingTitle.textContent = "Players";
    headingCopy.append(headingEyebrow, headingTitle);
    this.roundLabel = document.createElement("span");
    this.roundLabel.className = "round-indicator";
    this.roundLabel.textContent = `Round ${this.round} of ${this.totalRounds}`;
    heading.append(headingCopy, this.roundLabel);

    const list = document.createElement("div");
    list.className = "players";

    const controls = document.createElement("div");
    controls.className = "player-controls";

    const addBtn = document.createElement("button");
    addBtn.className = "player-controls__btn";
    addBtn.type = "button";
    addBtn.title = "Add a local player";
    const addIcon = document.createElement("i");
    addIcon.className = "fa-solid fa-user-plus";
    const addLabel = document.createElement("span");
    addLabel.textContent = "Add player";
    addBtn.append(addIcon, addLabel);
    addBtn.addEventListener("click", this.onAddPlayer);

    const removeBtn = document.createElement("button");
    removeBtn.className = "player-controls__btn";
    removeBtn.type = "button";
    removeBtn.title = "Remove the last local player";
    const removeIcon = document.createElement("i");
    removeIcon.className = "fa-solid fa-user-minus";
    const removeLabel = document.createElement("span");
    removeLabel.textContent = "Remove";
    removeBtn.append(removeIcon, removeLabel);
    removeBtn.addEventListener("click", this.onRemovePlayer);

    controls.append(removeBtn, addBtn);
    const actionTray = document.createElement("div");
    actionTray.className = "player-action-tray";

    const dictionaryButton = document.createElement("button");
    dictionaryButton.className = "player-action-btn";
    dictionaryButton.type = "button";
    dictionaryButton.setAttribute("aria-label", "Open dictionary search");
    dictionaryButton.title = "Dictionary";
    const dictionaryIcon = document.createElement("i");
    dictionaryIcon.className = "fa-solid fa-book-open";
    const dictionaryLabel = document.createElement("span");
    dictionaryLabel.textContent = "Words";
    dictionaryButton.append(dictionaryIcon, dictionaryLabel);
    dictionaryButton.addEventListener("click", () => this.showDictionarySearch());

    const chatButton = document.createElement("button");
    chatButton.className = "player-action-btn chat-btn";
    chatButton.type = "button";
    chatButton.setAttribute("aria-label", "Open chat");
    chatButton.title = "Chat";
    const chatIcon = document.createElement("i");
    chatIcon.className = "fa-solid fa-message";
    const chatLabel = document.createElement("span");
    chatLabel.textContent = "Chat";
    chatButton.append(chatIcon, chatLabel);
    chatButton.addEventListener("click", () => this.showChatModal());
    this.chatButton = chatButton;
    this.updateChatBadge();

    const logButton = document.createElement("button");
    logButton.className = "player-action-btn";
    logButton.type = "button";
    logButton.setAttribute("aria-label", "View activity log");
    logButton.title = "Game log";
    const logIcon = document.createElement("i");
    logIcon.className = "fa-solid fa-scroll";
    const logLabel = document.createElement("span");
    logLabel.textContent = "Log";
    logButton.append(logIcon, logLabel);
    logButton.addEventListener("click", () => this.showActivityLog());

    const exitButton = document.createElement("button");
    exitButton.className = "player-action-btn player-action-btn--exit";
    exitButton.type = "button";
    exitButton.setAttribute("aria-label", "Exit game");
    exitButton.title = "Exit game";
    const exitIcon = document.createElement("i");
    exitIcon.className = "fa-solid fa-right-from-bracket";
    const exitLabel = document.createElement("span");
    exitLabel.textContent = "Exit";
    exitButton.append(exitIcon, exitLabel);
    exitButton.addEventListener("click", async () => {
      const confirmed = await this.showConfirmation("Exit the game and return to the menu?");
      if (!confirmed) return;
      this.dispose();
      window.dispatchEvent(new CustomEvent("spellcast:exit"));
    });

    if (this.isMultiplayer) {
      actionTray.append(dictionaryButton, chatButton, logButton, exitButton);
    } else {
      actionTray.append(dictionaryButton, logButton, exitButton);
    }

    if (this.isMultiplayer) {
      controls.style.display = "none";
      wrap.append(heading, list, actionTray);
    } else {
      wrap.append(heading, list, controls, actionTray);
    }
    this.sidebar.appendChild(wrap);
    return list;
  }

  private renderPlayers() {
    this.playersListEl.innerHTML = "";
    this.turnTimerEl = undefined;
    const iAmHost =
      this.isMultiplayer && this.playerId
        ? Boolean(this.players.find((p) => p.id === this.playerId)?.isHost)
        : false;
    this.players.forEach((player, index) => {
      const item = document.createElement("div");
      item.className = "player";
      item.dataset.playerId = player.id;
      if (index === this.currentPlayerIndex) item.classList.add("player--active");

      const avatarWrap = document.createElement("div");
      avatarWrap.className = "player__avatar-wrap";
      avatarWrap.append(this.createPlayerAvatar(player));

      if (player.isHost) {
        const hostBadge = document.createElement("span");
        hostBadge.className = "player__host-badge";
        hostBadge.title = "Host";
        hostBadge.setAttribute("aria-label", "Host");
        hostBadge.innerHTML = '<i class="fa-solid fa-crown" aria-hidden="true"></i>';
        avatarWrap.append(hostBadge);
      }

      const presence = document.createElement("span");
      presence.className = `player__presence${player.connected ? " player__presence--online" : ""}`;
      presence.title = player.connected ? "Connected" : "Reconnecting…";
      presence.setAttribute("aria-label", presence.title);
      avatarWrap.append(presence);

      const header = document.createElement("div");
      header.className = "player__nameRow";

      const name = document.createElement("div");
      name.className = "player__name";
      name.textContent = truncatePlayerName(player.name);
      if (name.textContent !== player.name) name.title = player.name;

      const identity = document.createElement("div");
      identity.className = "player__identity";
      identity.append(name);
      if (player.isSpectator || !player.connected) {
        const role = document.createElement("span");
        role.className = "player__role";
        role.textContent = player.isSpectator ? "Spectating" : "Reconnecting";
        identity.append(role);
      }
      header.append(identity);

      if (player.lastWord) {
        const lastWord = document.createElement("div");
        lastWord.className = "player__lastWord";
        const pointsText =
          typeof player.lastWordPoints === "number" ? ` (${player.lastWordPoints})` : "";
        lastWord.textContent = `${player.lastWord}${pointsText}`;
        lastWord.title = `Last word: ${player.lastWord}${pointsText}`;
        if (player.bestWord && player.bestWordPoints && player.bestWordPoints > (player.lastWordPoints ?? 0)) {
          lastWord.title += ` · Best: ${player.bestWord} (${player.bestWordPoints})`;
        }
        header.append(lastWord);
      }

      let actions: HTMLDivElement | undefined;
      if (this.isMultiplayer && iAmHost && player.id !== this.playerId && !player.isSpectator && (this.multiplayer?.kickPlayer || this.multiplayer?.skipTurn)) {
        actions = document.createElement("div");
        actions.className = "player__actions";

        if (this.multiplayer?.kickPlayer) {
          const kickBtn = document.createElement("button");
          kickBtn.className = "player__kick-btn";
          kickBtn.title = `Kick ${player.name}`;
          kickBtn.setAttribute("aria-label", `Kick ${player.name}`);
          kickBtn.innerHTML = `<i class="fa-solid fa-ban"></i>`;
          kickBtn.addEventListener("click", async (event) => {
            event.stopPropagation();
            const confirmed = await this.showConfirmation(`Remove ${player.name} from the game?`);
            if (!confirmed) return;
            this.multiplayer?.kickPlayer?.(player.id);
          });
          actions.append(kickBtn);
        }

        if (index === this.currentPlayerIndex && this.multiplayer?.skipTurn) {
          const skipBtn = document.createElement("button");
          skipBtn.className = "player__skip-btn";
          skipBtn.title = `Skip ${player.name}'s turn`;
          skipBtn.setAttribute("aria-label", `Skip ${player.name}'s turn`);
          skipBtn.innerHTML = `<i class="fa-solid fa-forward"></i>`;
          skipBtn.addEventListener("click", async (event) => {
            event.stopPropagation();
            const confirmed = await this.showConfirmation(`Skip ${player.name}'s turn?`);
            if (!confirmed) return;
            this.multiplayer?.skipTurn?.(player.id);
          });
          actions.append(skipBtn);
        }
      }

      const meta = document.createElement("div");
      meta.className = "player__meta";
      const metaRow = document.createElement("div");
      metaRow.className = "player__metaRow";
      metaRow.innerHTML = `<span class="pill pill--score"><i class="fa-solid fa-star pill__icon" aria-hidden="true"></i>${player.score}</span><span class="pill pill--gem"><i class="fa-solid fa-gem pill__icon" aria-hidden="true"></i>${player.gems}</span>`;
      meta.append(metaRow);

      const utility = document.createElement("div");
      utility.className = "player__utility";

      if (index === this.currentPlayerIndex) {
        const turnTimer = document.createElement("div");
        turnTimer.className = "pill pill--turn player__turnTimer";
        turnTimer.innerHTML = `<i class="fa-solid fa-hourglass-start pill__icon" aria-hidden="true"></i><span class="player__turnTimerText">00:00</span>`;
        utility.append(turnTimer);
        this.turnTimerEl = turnTimer;
      }
      if (actions) utility.append(actions);

      if (utility.childElementCount) meta.append(utility);
      item.append(avatarWrap, header, meta);
      this.playersListEl.appendChild(item);
    });

    this.updateTurnTimerDisplay();
  }

  private createPlayerAvatar(player: Player): HTMLElement {
    const fallback = () => {
      const initial = document.createElement("span");
      initial.className = "player__avatar player__avatar--fallback";
      initial.textContent = player.name.charAt(0).toUpperCase() || "?";
      initial.setAttribute("aria-hidden", "true");
      return initial;
    };

    if (!player.avatar) return fallback();

    const image = document.createElement("img");
    image.className = "player__avatar";
    image.src = player.avatar;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.replaceWith(fallback()), { once: true });
    return image;
  }

  private onAddPlayer = () => {
    if (this.isMultiplayer) return;
    if (this.players.length >= 6) return;
    const id = `p${this.players.length + 1}`;
    this.players.push({
      id,
      name: `Player ${this.players.length + 1}`,
      score: 0,
      gems: 3,
      isHost: false,
      connected: true,
      isSpectator: false,
      lastWord: undefined
    });
    this.renderPlayers();
  };

  private onRemovePlayer = () => {
    if (this.isMultiplayer) return;
    if (this.players.length <= 2) return;
    this.players.pop();
    if (this.currentPlayerIndex >= this.players.length) {
      this.currentPlayerIndex = 0;
    }
    this.renderPlayers();
  };

  private updatePointerFromEvent(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.isModalOpen) return;
    if (this.isSpectator) return;
    if (this.isMultiplayer && !this.isMyTurn()) {
      this.board.setHovered(undefined);
      return;
    }
    this.updatePointerFromEvent(event);

    const tile = this.intersectTile();
    this.board.setHovered(tile ?? undefined);
  };

  private onPointerDown = (event: PointerEvent) => {
    if (this.isSpectator) return;
    this.updatePointerFromEvent(event);
  };

  private onClick = () => {
    if (this.isModalOpen) return;
    if (this.isSpectator) return;
    if (this.isMultiplayer && !this.isMyTurn()) return;
    const tile = this.intersectTile();
    if (!tile) return;

    if (this.swapMode) {
      this.handleSwapSelection(tile);
      return;
    }

    const result = this.board.selectTile(tile);
    if (!result.success) {
      console.warn(result.reason ?? "Invalid selection.");
      return;
    }

    this.updateWord(result.selection);
    this.broadcastSelection(result.selection);
    if (result.action === "added") {
      soundManager.play("tile-select");
    } else if (result.action === "removed") {
      soundManager.play("tile-deselect");
    }
  };

  private onSubmitWord = () => {
    if (this.isSpectator) return;
    const selection = this.board.getSelection();
    if (!selection.length) {
      console.warn("Select tiles to form a word.");
      return;
    }
    if (this.isMultiplayer && !this.isMyTurn()) {
      console.warn("Wait for your turn before submitting.");
      return;
    }

    const word = selection.map((t) => t.letter).join("");
    const normalizedWord = word.toUpperCase();
    const points = this.calculateWordScore(selection, word.length >= 6);
    if (!this.dictionary.has(normalizedWord)) {
      console.warn(`"${word}" is not a valid word.`);
      this.setWordBoxValidity(false);
      return;
    }

    if (this.isMultiplayer && this.multiplayer) {
      const player = this.players[this.currentPlayerIndex];
      const tileIds = selection.map((tile) => this.board.getTileId(tile));
      const submissionKey = `${this.round}:${player?.id ?? "unknown"}:${normalizedWord}`;
      this.lastSubmissionToken = submissionKey;
      if (player) {
        player.lastWord = normalizedWord;
        player.lastWordPoints = points;
        if (!player.bestWordPoints || points > player.bestWordPoints) {
          player.bestWordPoints = points;
          player.bestWord = normalizedWord;
        }
      }
      soundManager.play("word-submit");
      this.playSubmissionAnimation(selection);
      this.multiplayer.submitWord(tileIds);
      this.board.clearSelection();
      this.updateWord([]);
      this.broadcastSelection([]);
      return;
    }

    const player = this.players[this.currentPlayerIndex];
    const tileIds = selection.map((tile) => this.board.getTileId(tile));
    const result = this.offlineAdapter?.submitWord(player.id, tileIds, this.dictionary);
    if (!result?.success) {
      console.warn(result?.error ?? "Submit failed");
      return;
    }
    const submissionKey = `${this.round}:${player.id}:${normalizedWord}`;
    this.lastSubmissionToken = submissionKey;
    player.lastWord = normalizedWord;
    player.lastWordPoints = points;
    if (!player.bestWordPoints || points > player.bestWordPoints) {
      player.bestWordPoints = points;
      player.bestWord = normalizedWord;
    }
    soundManager.play("word-submit");
    this.playSubmissionAnimation(selection);
    this.board.clearSelection();
    this.updateWord([]);
    this.broadcastSelection([]);
    this.syncOfflineSnapshot();
  };

  private onShuffle = async () => {
    if (this.isSpectator) return;
    if (this.isMultiplayer && !this.isMyTurn()) {
      console.warn("Wait for your turn to use Shuffle.");
      return;
    }
    if (this.swapMode) {
      if (this.isMultiplayer && this.multiplayer) {
        this.multiplayer.cancelSwap();
      } else {
        this.exitSwapMode();
      }
    }
    const player = this.players[this.currentPlayerIndex];
    if (player.gems < 1) {
      console.warn("Need 1 gem to shuffle.");
      return;
    }
    const confirmed = await this.showConfirmation("Shuffle the board for 1 gem?");
    if (!confirmed) return;

    if (this.isMultiplayer && this.multiplayer) {
      this.multiplayer.shuffle();
      this.board.clearSelection();
      this.updateWord([]);
      this.broadcastSelection([]);
      return;
    }

    const result = this.offlineAdapter?.shuffle(player.id);
    if (!result?.success) {
      console.warn(result?.error ?? "Shuffle failed");
      return;
    }
    this.logEvent(`Round ${this.round}: ${player.name} used Shuffle (-1 gem).`);
    this.board.clearSelection();
    this.updateWord([]);
    this.broadcastSelection([]);
    this.syncOfflineSnapshot();
  };

  private onResetWord = () => {
    if (this.isSpectator) return;
    this.board.clearSelection();
    this.updateWord([]);
    this.broadcastSelection([]);
  };

  private onRerollLetter = () => {
    if (this.isSpectator) return;
    if (this.swapMode) {
      if (this.isMultiplayer && this.multiplayer) {
        this.multiplayer.cancelSwap();
      } else {
        this.offlineAdapter?.cancelSwap(this.players[this.currentPlayerIndex]?.id ?? "");
        this.exitSwapMode();
      }
      return;
    }
    if (this.isMultiplayer && !this.isMyTurn()) {
      console.warn("Wait for your turn to use Swap.");
      return;
    }
    if (this.isMultiplayer && this.multiplayer) {
      this.multiplayer.requestSwapMode();
      this.board.clearSelection();
      this.board.setHovered(undefined);
      this.updateWord([]);
      this.broadcastSelection([]);
      return;
    }
    const player = this.players[this.currentPlayerIndex];
    if (player.gems < 3) {
      console.warn("Need 3 gems to swap a letter.");
      return;
    }
    const swapResult = this.offlineAdapter?.requestSwapMode(player.id);
    if (!swapResult?.success) {
      console.warn(swapResult?.error ?? "Swap not available");
      return;
    }
    this.swapMode = true;
    this.board.setSwapMode(true);
    this.board.clearSelection();
    this.board.setHovered(undefined);
    this.updateWord([]);
  };

  private exitSwapMode() {
    if (!this.swapMode) return;
    this.swapMode = false;
    this.board.setSwapMode(false);
    this.board.setHovered(undefined);
    if (!this.isMultiplayer) {
      const me = this.players[this.currentPlayerIndex];
      if (me) {
        this.offlineAdapter?.cancelSwap(me.id);
      }
    }
  }

  private calculateWordScore(selection: Tile[], hasLongWordBonus: boolean): number {
    const baseScore = selection.reduce((total, tile) => {
      const base = LETTER_VALUES[tile.letter.toLowerCase()] ?? 0;
      const letterMultiplier =
        tile.multiplier === "tripleLetter" ? 3 : tile.multiplier === "doubleLetter" ? 2 : 1;
      return total + base * letterMultiplier;
    }, 0);
    const hasDoubleWord = selection.some((tile) => tile.wordMultiplier === "doubleWord");
    const total = hasDoubleWord ? baseScore * 2 : baseScore;
    return total + (hasLongWordBonus ? 10 : 0);
  }

  private updateWord(selection: Tile[]) {
    const word = selection.map((t) => t.letter).join("").toUpperCase();
    if (!word) {
      this.wordBox.textContent = "-";
      this.setWordBoxValidity(null);
      return;
    }
    const potentialScore = this.calculateWordScore(selection, word.length >= 6);
    const isValid = this.dictionary.has(word);
    this.wordBox.textContent = `${word} (${potentialScore})`;
    this.setWordBoxValidity(isValid);
  }

  private setWordBoxValidity(state: boolean | null) {
    this.wordBox.classList.remove("word-box--valid", "word-box--invalid");
    if (state === true) {
      this.wordBox.classList.add("word-box--valid");
      this.startWordBoxConfetti();
    } else if (state === false) {
      this.wordBox.classList.add("word-box--invalid");
      this.stopWordBoxConfetti();
    } else {
      this.stopWordBoxConfetti();
    }
  }

  private startWordBoxConfetti() {
    if (this.wordBoxConfettiTimer != null) return;
    this.emitWordBoxParticles();
    this.wordBoxConfettiTimer = window.setInterval(() => this.emitWordBoxParticles(), 650);
  }

  private stopWordBoxConfetti() {
    if (this.wordBoxConfettiTimer != null) {
      window.clearInterval(this.wordBoxConfettiTimer);
      this.wordBoxConfettiTimer = undefined;
    }
  }

  private emitWordBoxParticles() {
    const particleCount = 18;
    const colors = ["#ffffff", "#e7f2ff", "#ffd780"];
    for (let i = 0; i < particleCount; i += 1) {
      const particle = document.createElement("span");
      particle.className = "word-box__particle";

      const edge = Math.floor(Math.random() * 4);
      const pos = Math.random();
      let x = 50;
      let y = 50;
      let dx = 0;
      let dy = 0;

      if (edge === 0) {
        // top
        x = pos * 100;
        y = 0;
        dx = (Math.random() - 0.5) * 0.6;
        dy = -1;
      } else if (edge === 1) {
        // right
        x = 100;
        y = pos * 100;
        dx = 1;
        dy = (Math.random() - 0.5) * 0.6;
      } else if (edge === 2) {
        // bottom
        x = pos * 100;
        y = 100;
        dx = (Math.random() - 0.5) * 0.6;
        dy = 1;
      } else {
        // left
        x = 0;
        y = pos * 100;
        dx = -1;
        dy = (Math.random() - 0.5) * 0.6;
      }

      particle.style.left = `${x}%`;
      particle.style.top = `${y}%`;
      particle.style.setProperty("--dx", dx.toString());
      particle.style.setProperty("--dy", dy.toString());
      particle.style.setProperty("--particle-color", colors[Math.floor(Math.random() * colors.length)]);
      particle.style.animationDelay = `${Math.random() * 0.2}s`;

      this.wordBox.appendChild(particle);
      window.setTimeout(() => particle.remove(), 1000);
    }
  }

  private onResize = () => {
    const width = this.boardViewport.clientWidth;
    const height = this.boardViewport.clientHeight;
    if (!width || !height) return;
    const aspect = width / height;

    this.camera.left = (-this.frustumSize * aspect) / 2;
    this.camera.right = (this.frustumSize * aspect) / 2;
    this.camera.top = this.frustumSize / 2;
    this.camera.bottom = -this.frustumSize / 2;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(width, height);
    this.updateBoardPlacement();
    this.updateWordBoxLayout();
  };

  private intersectTile(): Tile | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(this.board.children, false);
    if (!intersects.length) return null;
    const picked = intersects[0].object;
    const tile = picked.userData.tile as Tile | undefined;
    return tile ?? null;
  }

  private updateBoardPlacement() {
    const aspect =
      this.boardViewport.clientWidth && this.boardViewport.clientHeight
        ? this.boardViewport.clientWidth / this.boardViewport.clientHeight
        : 1;
    const leftBound = (-this.frustumSize * aspect) / 2;
    const boardWorldWidth = this.board.width() * this.board.scale.x;
    const margin = 1.1;
    const centerX = leftBound + margin + boardWorldWidth / 2;
    this.board.position.set(centerX, 0, 0);
    this.updateWordBoxLayout();
  }

  private isCompactLayout(): boolean {
    return this.compactLayoutQuery.matches;
  }

  private updateWordBoxLayout() {
    if (this.isCompactLayout()) {
      this.wordBox.style.width = "";
      this.wordBox.style.left = "";
      this.wordBox.style.top = "";
      if (this.controlsWrap) {
        this.controlsWrap.style.width = "";
        this.controlsWrap.style.marginLeft = "";
      }
      return;
    }

    const widthPx = this.boardViewport.clientWidth;
    const heightPx = this.boardViewport.clientHeight;
    if (!widthPx || !heightPx) return;

    const aspect = widthPx / heightPx;
    const boardWorldWidth = this.board.width() * this.board.scale.x;
    const leftBound = (-this.frustumSize * aspect) / 2;
    const pxPerWorldX = widthPx / (this.frustumSize * aspect);

    const boardLeftWorld = this.board.position.x - boardWorldWidth / 2;
    const boardWidthPx = boardWorldWidth * pxPerWorldX;
    const boardLeftPx = (boardLeftWorld - leftBound) * pxPerWorldX;
    const topPx = 20;

    this.wordBox.style.width = `${boardWidthPx}px`;
    this.wordBox.style.left = `${boardLeftPx + 10}px`;
    this.wordBox.style.top = `${topPx}px`;
    if (this.controlsWrap) {
      this.controlsWrap.style.width = `200px`;
      this.controlsWrap.style.marginLeft = `8px`;
    }
  }

  private tick() {
    this.animationId = requestAnimationFrame(this.tick);
    if (!document.hidden) {
      this.renderer.render(this.scene, this.camera);
    }
  }

  private applyRendererQuality() {
    const thermal = document.documentElement.dataset.discordThermal;
    const layout = document.documentElement.dataset.discordLayout;
    const maximumRatio =
      thermal === "critical" || layout === "pip" ? 1 : thermal === "serious" ? 1.25 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maximumRatio));
  }

  private updateRoundLabel() {
    if (this.roundLabel) {
      this.roundLabel.textContent = `Round ${this.round} of ${this.totalRounds}`;
    }
  }

  private restartTurnTimer() {
    if (this.turnTimerId !== null) {
      window.clearInterval(this.turnTimerId);
    }
    this.turnTimerId = window.setInterval(() => this.updateTurnTimerDisplay(), 1000);
  }

  private updateTurnTimerDisplay() {
    if (!this.turnTimerEl) return;
    const elapsed = Math.max(0, Math.floor((performance.now() - this.turnStartTime) / 1000));
    const minutes = Math.floor(elapsed / 60)
      .toString()
      .padStart(2, "0");
    const seconds = (elapsed % 60).toString().padStart(2, "0");
    const text = this.turnTimerEl.querySelector(".player__turnTimerText");
    if (text) {
      text.textContent = `${minutes}:${seconds}`;
    } else {
      this.turnTimerEl.innerHTML = `<i class="fa-solid fa-hourglass-start pill__icon" aria-hidden="true"></i><span class="player__turnTimerText">${minutes}:${seconds}</span>`;
    }
  }

  private showConfirmation(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.isModalOpen = true;
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay modal--entering";
      const modal = document.createElement("div");
      modal.className = "modal modal--theme";

      const text = document.createElement("p");
      text.textContent = message;

      const actions = document.createElement("div");
      actions.className = "modal__actions";

      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "Confirm";
      confirmBtn.className = "modal__btn primary";

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.className = "modal__btn";

      const cleanup = (result: boolean) => {
        this.isModalOpen = false;
        overlay.classList.add("modal--leaving");
        window.setTimeout(() => overlay.remove(), 220);
        resolve(result);
      };

      confirmBtn.addEventListener("click", () => cleanup(true));
      cancelBtn.addEventListener("click", () => cleanup(false));

      actions.append(confirmBtn, cancelBtn);
      modal.append(text, actions);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => {
        overlay.classList.remove("modal--entering");
      });
    });
  }

  private handleSwapSelection = async (tile: Tile) => {
    if (this.isSpectator) return;
    const player = this.players[this.currentPlayerIndex];
    if (this.isMultiplayer) {
      if (!this.multiplayer) return;
      const letter = await this.showLetterPicker();
      if (!letter) {
        this.broadcastSelection([]);
        return;
      }
      const tileId = this.board.getTileId(tile);
      this.multiplayer.applySwap(tileId, letter);
      this.board.clearSelection();
      this.board.setHovered(undefined);
      this.updateWord([]);
      this.broadcastSelection([]);
      return;
    }
    if (player.gems < 3) {
      console.warn("Need 3 gems to swap a letter.");
      this.exitSwapMode();
      return;
    }

    const letter = await this.showLetterPicker();
    if (!letter) {
      this.exitSwapMode();
      return;
    }

    const tileId = this.board.getTileId(tile);
    const result = this.offlineAdapter?.applySwap(player.id, tileId, letter);
    if (!result?.success) {
      console.warn(result?.error ?? "Swap failed");
      this.exitSwapMode();
      return;
    }

    this.board.clearSelection();
    this.board.setHovered(undefined);
    this.updateWord([]);
    this.exitSwapMode();
    this.logEvent(`Round ${this.round}: ${player.name} swapped a letter to "${letter}".`);
    this.syncOfflineSnapshot();
  };

  private showLetterPicker(): Promise<string | null> {
    return new Promise((resolve) => {
      this.isModalOpen = true;
      const overlay = document.createElement("div");
      overlay.className = "modal-overlay modal--entering";
      const modal = document.createElement("div");
      modal.className = "modal modal--theme";

      const text = document.createElement("p");
      text.textContent = "Select a new letter";

      const grid = document.createElement("div");
      grid.className = "letter-picker";
      for (let code = 65; code <= 90; code += 1) {
        const letter = String.fromCharCode(code);
        const btn = document.createElement("button");
        btn.className = "letter-picker__btn";
        btn.textContent = letter;
        btn.addEventListener("click", () => cleanup(letter));
        grid.appendChild(btn);
      }

      const actions = document.createElement("div");
      actions.className = "modal__actions";

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "modal__btn";
      cancelBtn.textContent = "Cancel";
      cancelBtn.addEventListener("click", () => cleanup(null));

      actions.append(cancelBtn);
      modal.append(text, grid, actions);
      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const cleanup = (value: string | null) => {
        this.isModalOpen = false;
        overlay.classList.add("modal--leaving");
        window.setTimeout(() => overlay.remove(), 220);
        resolve(value);
      };

      requestAnimationFrame(() => {
        overlay.classList.remove("modal--entering");
      });
    });
  }

  private showActivityLog() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay modal--entering";
    const modal = document.createElement("div");
    modal.className = "modal modal--theme";
    modal.style.maxHeight = "70vh";
    modal.style.overflowY = "auto";

    const title = document.createElement("h3");
    title.textContent = "Game Activity Log";

    const list = document.createElement("ul");
    list.className = "activity-log";
    if (this.gameLog.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No activity yet.";
      modal.append(title, empty);
    } else {
      this.gameLog.slice().forEach((entry) => {
        const item = document.createElement("li");
        item.textContent = entry;
        list.appendChild(item);
      });
      modal.append(title, list);
    }

    const actions = document.createElement("div");
    actions.className = "modal__actions";
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal__btn primary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      overlay.classList.add("modal--leaving");
      window.setTimeout(() => overlay.remove(), 220);
    });
    actions.append(closeBtn);

    modal.append(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.remove("modal--entering"));
  }

  private showDictionarySearch() {
    if (this.isModalOpen) return;
    this.isModalOpen = true;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay modal--entering";
    const modal = document.createElement("div");
    modal.className = "modal modal--theme";
    modal.style.width = "90vw";
    modal.style.maxWidth = "900px";
    modal.style.height = "80vh";
    modal.style.display = "flex";
    modal.style.flexDirection = "column";
    modal.style.gap = "12px";

    const title = document.createElement("h3");
    title.textContent = "Dictionary Search";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type to search words...";
    input.className = "dictionary-modal__input";

    const list = document.createElement("div");
    list.className = "dictionary-modal__list";

    const renderList = (query: string) => {
      list.innerHTML = "";
      const term = query.trim().toUpperCase();
      if (term.length < 2) {
        return;
      }
      const matches = this.dictionaryWords.filter((word) => word.includes(term));
      matches.forEach((word) => {
        const row = document.createElement("div");
        row.className = "dictionary-modal__item";
        row.textContent = word;
        list.appendChild(row);
      });
    };

    input.addEventListener("input", () => renderList(input.value));
    renderList("");

    const actions = document.createElement("div");
    actions.className = "modal__actions";
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal__btn primary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      overlay.classList.add("modal--leaving");
      window.setTimeout(() => overlay.remove(), 200);
      this.isModalOpen = false;
    });
    actions.append(closeBtn);

    modal.append(title, input, list, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.remove("modal--entering");
      input.focus();
    });
  }

  public updateChat(messages: ChatMessage[]) {
    this.chatMessages = messages.slice().sort((a, b) => a.createdAt - b.createdAt);
    if (this.chatUI) {
      this.renderChatMessages(this.chatUI.list);
      if (this.chatMessages.length) {
        this.lastChatReadAt = Math.max(...this.chatMessages.map((m) => m.createdAt));
        this.chatUnread = 0;
        this.updateChatBadge();
      }
    } else {
      const latestRead = this.lastChatReadAt;
      const unread = this.chatMessages.filter((m) => m.createdAt > latestRead).length;
      this.chatUnread = unread;
      this.updateChatBadge();
    }
  }

  private renderChatMessages(list: HTMLElement) {
    list.innerHTML = "";
    this.chatMessages.forEach((msg) => {
      const row = document.createElement("div");
      row.className = "chat-modal__message";

      const meta = document.createElement("div");
      meta.className = "chat-modal__meta";
      const time = new Date(msg.createdAt);
      meta.textContent = `${msg.playerName} • ${time.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })}`;

      const body = document.createElement("div");
      body.className = "chat-modal__text";
      body.textContent = msg.text;

      row.append(meta, body);
      list.appendChild(row);
    });
    list.scrollTop = list.scrollHeight;
  }

  private showChatModal() {
    if (this.isModalOpen || !this.isMultiplayer) return;
    this.isModalOpen = true;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay modal--entering chat-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal modal--theme chat-modal";

    const header = document.createElement("div");
    header.className = "chat-modal__header";
    const title = document.createElement("h3");
    title.textContent = "Game Chat";
    const closeBtn = document.createElement("button");
    closeBtn.className = "chat-modal__close";
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.innerHTML = "&times;";
    header.append(title, closeBtn);

    const messages = document.createElement("div");
    messages.className = "chat-modal__messages";

    const form = document.createElement("form");
    form.className = "chat-modal__input-row";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Type a message...";
    input.className = "chat-modal__input";
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "chat-modal__send";
    const sendIcon = document.createElement("i");
    sendIcon.className = "fa-solid fa-paper-plane";
    sendBtn.appendChild(sendIcon);
    form.append(input, sendBtn);

    const close = () => {
      overlay.classList.add("modal--leaving");
      window.setTimeout(() => {
        overlay.remove();
        this.isModalOpen = false;
        this.chatUI = undefined;
      }, 200);
    };

    closeBtn.addEventListener("click", close);
    overlay.addEventListener("click", (evt) => {
      if (evt.target === overlay) close();
    });
    form.addEventListener("submit", (evt) => {
      evt.preventDefault();
      this.sendChatMessage(input.value);
      input.value = "";
      input.focus();
    });

    modal.append(header, messages, form);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    this.chatUI = { overlay, list: messages, input };
    this.renderChatMessages(messages);
    if (this.chatMessages.length) {
      this.lastChatReadAt = Math.max(...this.chatMessages.map((m) => m.createdAt));
      this.chatUnread = 0;
      this.updateChatBadge();
    }
    requestAnimationFrame(() => {
      overlay.classList.remove("modal--entering");
      input.focus();
    });
  }

  private sendChatMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !this.multiplayer?.sendChatMessage) return;
    this.multiplayer.sendChatMessage(trimmed);
  }

  private updateChatBadge() {
    if (!this.chatButton) return;
    if (!this.chatBadge) {
      const badge = document.createElement("span");
      badge.className = "chat-badge";
      this.chatButton.appendChild(badge);
      this.chatBadge = badge;
    }
    if (this.chatUnread > 0) {
      this.chatBadge.textContent = `${this.chatUnread}`;
      this.chatBadge.style.display = "inline-flex";
    } else {
      this.chatBadge.style.display = "none";
    }
  }

  private playSubmissionAnimation(selection: Tile[]) {
    const submitContainer = this.submitAnimContainer;
    if (!submitContainer || !selection.length) return;
    const containerRect = this.container.getBoundingClientRect();
    const letterGap = 64;
    const totalWidth = (selection.length - 1) * letterGap;
    const targetBaseX = containerRect.width / 2 - totalWidth / 2;
    const targetY = containerRect.height * 0.5;
    const centerX = targetBaseX + totalWidth / 2;
    const underlineWidth = totalWidth + 20;
    const points = this.calculateWordScore(selection, selection.length >= 6);

    submitContainer.innerHTML = "";
    const overlay = document.createElement("div");
    overlay.className = "submit-anim__overlay";
    submitContainer.appendChild(overlay);
    const spawnSparkle = (el: SVGCircleElement) => {
      const now = performance.now();
      if (now - this.lastSparkleTime < 45) return;
      this.lastSparkleTime = now;
      const dotRect = el.getBoundingClientRect();
      const x = dotRect.left - containerRect.left;
      const y = dotRect.top - containerRect.top;
      requestAnimationFrame(() => {
        const sparkle = document.createElement("div");
        sparkle.className = "submit-anim__sparkle";
        sparkle.style.left = `${x}px`;
        sparkle.style.top = `${y}px`;
        submitContainer.appendChild(sparkle);
        setTimeout(() => sparkle.remove(), 420);
      });
    };
    const letters: {
      container: HTMLElement;
      text: SVGTextElement;
      guide: SVGPathElement;
      dot: SVGCircleElement;
      startX: number;
      startY: number;
    }[] = [];

    const drawDuration = 0.4;
    selection.forEach((tile, index) => {
      const targetX = targetBaseX + index * letterGap;
      const startX = targetX;
      const startY = targetY;

      const entry = this.createAnimatedLetter(tile.letter, startX, startY);
      submitContainer.appendChild(entry.container);
      letters.push({ ...entry, startX, startY });

      const delay = index * drawDuration;
      gsap.to(entry.container, {
        scale: 1,
        opacity: 1,
        duration: 0.2,
        ease: "power2.out",
        delay
      });
      gsap.to(entry.text, {
        strokeDashoffset: 0,
        duration: drawDuration,
        ease: "power1.inOut",
        delay: delay + 0.05,
        onComplete: () => entry.container.classList.add("submit-anim__letter--filled")
      });
      gsap.to(entry.text, {
        fillOpacity: 1,
        duration: 0.3,
        delay: delay + drawDuration - 0.05
      });
      gsap.to(entry.dot, {
        opacity: 1,
        duration: 0.05,
        delay
      });
      gsap.to(entry.dot, {
        motionPath: {
          path: entry.guide,
          align: entry.guide,
          autoRotate: false,
          alignOrigin: [0.5, 0.5]
        },
        duration: drawDuration,
        ease: "power1.inOut",
        delay: delay + 0.05,
        onUpdate: () => spawnSparkle(entry.dot),
        onComplete: () => {
          entry.dot.style.opacity = "0";
        }
      });
    });

    const scoreChars = `+${points}`;
    const scoreGap = 46;
    const scoreTotalWidth = (scoreChars.length - 1) * scoreGap;
    const scoreBaseX = centerX - scoreTotalWidth / 2;
    const scoreLetters: ReturnType<SpellcastGame["createAnimatedLetter"]>[] = [];
    scoreChars.split("").forEach((ch, idx) => {
      const sx = scoreBaseX + idx * scoreGap;
      const entry = this.createAnimatedLetter(ch, sx, targetY);
      entry.container.style.opacity = "0";
      submitContainer.appendChild(entry.container);
      scoreLetters.push(entry);
    });

    const underlineSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    underlineSvg.setAttribute("width", `${underlineWidth}`);
    underlineSvg.setAttribute("height", "22");
    underlineSvg.style.position = "absolute";
    underlineSvg.style.left = `${targetBaseX - 10}px`;
    underlineSvg.style.top = `${targetY + 52}px`;
    underlineSvg.style.overflow = "visible";
    underlineSvg.style.opacity = "0";

    const underline = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const underlineLen = underlineWidth - 20;
    underline.setAttribute("x1", "10");
    underline.setAttribute("x2", `${underlineWidth - 10}`);
    underline.setAttribute("y1", "12");
    underline.setAttribute("y2", "12");
    underline.setAttribute("stroke", "#f7cd42");
    underline.setAttribute("stroke-width", "6");
    underline.setAttribute("stroke-linecap", "round");
    underline.setAttribute("stroke-dasharray", `${underlineLen}`);
    underline.setAttribute("stroke-dashoffset", `${underlineLen}`);
    underlineSvg.appendChild(underline);
    submitContainer.appendChild(underlineSvg);

    const underlineDelay = selection.length * drawDuration + 0.15;
    gsap.to(underlineSvg, {
      opacity: 1,
      duration: 0.05,
      delay: underlineDelay
    });
    gsap.to(underline, {
      strokeDashoffset: 0,
      duration: 0.45,
      ease: "power1.inOut",
      delay: underlineDelay
    });
    const underlineFade = () => {
      gsap.to(underlineSvg, {
        opacity: 0,
        duration: 0.35,
        ease: "power1.in"
      });
    };

    const totalDrawSeconds = selection.length * drawDuration + 0.25;
    const collapseDuration = 0.4;
    const holdScore = 1.5;
    const tl = gsap.timeline();

    tl.addLabel("collapse", totalDrawSeconds);
    letters.forEach((entry) => {
      tl.to(
        entry.container,
        {
          x: centerX - entry.startX,
          y: targetY - entry.startY,
          scale: 0.85,
          opacity: 0.4,
          duration: collapseDuration,
          ease: "power2.inOut",
          onComplete: () => {
            entry.startX = centerX;
            entry.startY = targetY;
          }
        },
        "collapse"
      );
    });
    letters.forEach((entry) => {
      tl.to(
        entry.container,
        { opacity: 0.0, duration: 0.2, ease: "power1.out" },
        `collapse+=${collapseDuration}`
      );
    });

    const scoreDrawDuration = 0.3;
    scoreLetters.forEach((entry, idx) => {
      const delay = idx * scoreDrawDuration;
      tl.to(
        entry.container,
        { scale: 1, opacity: 1, duration: 0.2, ease: "power2.out" },
        `collapse+=${collapseDuration + delay}`
      );
      tl.to(
        entry.text,
        {
          strokeDashoffset: 0,
          duration: scoreDrawDuration,
          ease: "power1.inOut",
          delay: 0.05
        },
        `collapse+=${collapseDuration + delay}`
      );
      tl.to(
        entry.text,
        { fillOpacity: 1, duration: 0.25, delay: scoreDrawDuration - 0.05 },
        `collapse+=${collapseDuration + delay}`
      );
      tl.to(
        entry.dot,
        { opacity: 1, duration: 0.05 },
        `collapse+=${collapseDuration + delay}`
      );
      tl.to(
        entry.dot,
        {
          motionPath: {
            path: entry.guide,
            align: entry.guide,
            autoRotate: false,
            alignOrigin: [0.5, 0.5]
          },
          duration: scoreDrawDuration,
          ease: "power1.inOut",
          delay: 0.05,
          onUpdate: () => spawnSparkle(entry.dot),
          onComplete: () => {
            entry.dot.style.opacity = "0";
          }
        },
        `collapse+=${collapseDuration + delay}`
      );
    });

    const targetCard = this.playersListEl?.querySelector<HTMLElement>(
      `[data-player-id="${this.players[this.currentPlayerIndex]?.id}"]`
    );
    const targetRect = targetCard?.getBoundingClientRect();
    const targetCenterX = targetRect
      ? targetRect.left - containerRect.left + targetRect.width / 2
      : containerRect.width + 120;
    const targetCenterY = targetRect
      ? targetRect.top - containerRect.top + targetRect.height / 2
      : -120;

    tl.addLabel("fly", `collapse+=${collapseDuration + scoreDrawDuration * scoreLetters.length + holdScore}`);
    scoreLetters.forEach((entry, idx) => {
      tl.to(
        entry.container,
        {
          x: targetCenterX - parseFloat(entry.container.style.left),
          y: targetCenterY - parseFloat(entry.container.style.top),
          scale: 0.75,
          opacity: 0,
          duration: 0.75,
          ease: "power1.in",
          delay: idx * 0.04
        },
        "fly"
      );
    });
    tl.call(underlineFade, undefined, "fly");
    tl.call(() => {
      submitContainer.innerHTML = "";
    }, undefined, "fly+=1");
  }

  private playSubmissionWord(word: string, playerId?: string, points?: number) {
    const submitContainer = this.submitAnimContainer;
    if (!submitContainer || !word) return;
    const containerRect = this.container.getBoundingClientRect();
    const letterGap = 64;
    const lettersArr = word.split("");
    const totalWidth = (lettersArr.length - 1) * letterGap;
    const targetBaseX = containerRect.width / 2 - totalWidth / 2;
    const targetY = containerRect.height * 0.5;
    const centerX = targetBaseX + totalWidth / 2;
    const underlineWidth = totalWidth + 20;

    submitContainer.innerHTML = "";
    const overlay = document.createElement("div");
    overlay.className = "submit-anim__overlay";
    submitContainer.appendChild(overlay);
    const spawnSparkle = (el: SVGCircleElement) => {
      const now = performance.now();
      if (now - this.lastSparkleTime < 45) return;
      this.lastSparkleTime = now;
      const dotRect = el.getBoundingClientRect();
      const x = dotRect.left - containerRect.left;
      const y = dotRect.top - containerRect.top;
      requestAnimationFrame(() => {
        const sparkle = document.createElement("div");
        sparkle.className = "submit-anim__sparkle";
        sparkle.style.left = `${x}px`;
        sparkle.style.top = `${y}px`;
        submitContainer.appendChild(sparkle);
        setTimeout(() => sparkle.remove(), 420);
      });
    };
    const letters: {
      container: HTMLElement;
      text: SVGTextElement;
      guide: SVGPathElement;
      dot: SVGCircleElement;
      startX: number;
      startY: number;
    }[] = [];

    const resolvedPoints = points ?? 0;

    lettersArr.forEach((char, index) => {
      const targetX = targetBaseX + index * letterGap;
      const startX = targetX;
      const startY = targetY;

      const entry = this.createAnimatedLetter(char, startX, startY);
      submitContainer.appendChild(entry.container);
      letters.push({ ...entry, startX, startY });

      const drawDuration = 0.25;
      const delay = index * drawDuration;
      gsap.to(entry.container, {
        scale: 1,
        opacity: 1,
        duration: 0.2,
        ease: "power2.out",
        delay
      });
      gsap.to(entry.text, {
        strokeDashoffset: 0,
        duration: drawDuration,
        ease: "power1.inOut",
        delay: delay + 0.05,
        onComplete: () => entry.container.classList.add("submit-anim__letter--filled")
      });
      gsap.to(entry.text, {
        fillOpacity: 1,
        duration: 0.3,
        delay: delay + drawDuration - 0.05
      });
      gsap.to(entry.dot, {
        opacity: 1,
        duration: 0.05,
        delay
      });
      gsap.to(entry.dot, {
        motionPath: {
          path: entry.guide,
          align: entry.guide,
          autoRotate: false,
          alignOrigin: [0.5, 0.5]
        },
        duration: drawDuration,
        ease: "power1.inOut",
        delay: delay + 0.05,
        onUpdate: () => spawnSparkle(entry.dot),
        onComplete: () => {
          entry.dot.style.opacity = "0";
        }
      });
    });

    const underlineSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    underlineSvg.setAttribute("width", `${underlineWidth}`);
    underlineSvg.setAttribute("height", "22");
    underlineSvg.style.position = "absolute";
    underlineSvg.style.left = `${targetBaseX - 10}px`;
    underlineSvg.style.top = `${targetY + 52}px`;
    underlineSvg.style.overflow = "visible";
    underlineSvg.style.opacity = "0";

    const underline = document.createElementNS("http://www.w3.org/2000/svg", "line");
    const underlineLen = underlineWidth - 20;
    underline.setAttribute("x1", "10");
    underline.setAttribute("x2", `${underlineWidth - 10}`);
    underline.setAttribute("y1", "12");
    underline.setAttribute("y2", "12");
    underline.setAttribute("stroke", "#f7cd42");
    underline.setAttribute("stroke-width", "6");
    underline.setAttribute("stroke-linecap", "round");
    underline.setAttribute("stroke-dasharray", `${underlineLen}`);
    underline.setAttribute("stroke-dashoffset", `${underlineLen}`);
    underlineSvg.appendChild(underline);
    submitContainer.appendChild(underlineSvg);

    const scoreChars = resolvedPoints ? `+${resolvedPoints}` : "";
    const scoreGap = 46;
    const scoreTotalWidth = scoreChars ? (scoreChars.length - 1) * scoreGap : 0;
    const scoreBaseX = centerX - scoreTotalWidth / 2;
    const scoreLetters: ReturnType<SpellcastGame["createAnimatedLetter"]>[] = [];
    if (scoreChars) {
      scoreChars.split("").forEach((ch, idx) => {
        const sx = scoreBaseX + idx * scoreGap;
        const entry = this.createAnimatedLetter(ch, sx, targetY);
        entry.container.style.opacity = "0";
        submitContainer.appendChild(entry.container);
        scoreLetters.push(entry);
      });
    }

    const underlineDelay = lettersArr.length * 0.62 + 0.15;
    gsap.to(underlineSvg, {
      opacity: 1,
      duration: 0.05,
      delay: underlineDelay
    });
    gsap.to(underline, {
      strokeDashoffset: 0,
      duration: 0.45,
      ease: "power1.inOut",
      delay: underlineDelay
    });
    const underlineFade = () => {
      gsap.to(underlineSvg, {
        opacity: 0,
        duration: 0.35,
        ease: "power1.in"
      });
    };

    const drawDuration = 0.25;
    const totalDrawSeconds = lettersArr.length * drawDuration + 0.25;
    const collapseDuration = 0.35;
    const holdScore = 1.5;
    const tl = gsap.timeline();

    tl.addLabel("collapse", totalDrawSeconds);
    letters.forEach((entry) => {
      tl.to(
        entry.container,
        {
          x: centerX - entry.startX,
          y: targetY - entry.startY,
          scale: 0.85,
          opacity: 0.4,
          duration: collapseDuration,
          ease: "power2.inOut",
          onComplete: () => {
            entry.startX = centerX;
            entry.startY = targetY;
          }
        },
        "collapse"
      );
    });
    letters.forEach((entry) => {
      tl.to(
        entry.container,
        { opacity: 0.15, duration: 0.2, ease: "power1.out" },
        `collapse+=${collapseDuration}`
      );
    });

    const scoreDrawDuration = 0.3;
    scoreLetters.forEach((entry, idx) => {
      const delay = idx * scoreDrawDuration;
      tl.to(
        entry.container,
        { scale: 1, opacity: 1, duration: 0.2, ease: "power2.out" },
        `collapse+=${collapseDuration + delay}`
      );
      tl.to(
        entry.text,
        {
          strokeDashoffset: 0,
          duration: scoreDrawDuration,
          ease: "power1.inOut",
          delay: 0.05
        },
        `collapse+=${collapseDuration + delay}`
      );
      tl.to(
        entry.text,
        { fillOpacity: 1, duration: 0.25, delay: scoreDrawDuration - 0.05 },
        `collapse+=${collapseDuration + delay}`
      );
      tl.to(
        entry.dot,
        { opacity: 1, duration: 0.05 },
        `collapse+=${collapseDuration + delay}`
      );
      tl.to(
        entry.dot,
        {
          motionPath: {
            path: entry.guide,
            align: entry.guide,
            autoRotate: false,
            alignOrigin: [0.5, 0.5]
          },
          duration: scoreDrawDuration,
          ease: "power1.inOut",
          delay: 0.05,
          onUpdate: () => spawnSparkle(entry.dot),
          onComplete: () => {
            entry.dot.style.opacity = "0";
          }
        },
        `collapse+=${collapseDuration + delay}`
      );
    });

    const targetCard = playerId
      ? this.playersListEl?.querySelector<HTMLElement>(`[data-player-id="${playerId}"]`)
      : null;
    const targetRect = targetCard?.getBoundingClientRect();
    const targetCenterX = targetRect
      ? targetRect.left - containerRect.left + targetRect.width / 2
      : containerRect.width + 120;
    const targetCenterY = targetRect
      ? targetRect.top - containerRect.top + targetRect.height / 2
      : -120;

    tl.addLabel("fly", `collapse+=${collapseDuration + scoreDrawDuration * scoreLetters.length + holdScore}`);
    letters.forEach((entry, idx) => {
      tl.to(
        entry.container,
        {
          x: targetCenterX - entry.startX,
          y: targetCenterY - entry.startY,
          scale: 0.6,
          opacity: 0,
          duration: 0.75,
          ease: "power1.in",
          delay: idx * 0.06
        },
        "fly"
      );
    });
    scoreLetters.forEach((entry, idx) => {
      tl.to(
        entry.container,
        {
          x: targetCenterX - parseFloat(entry.container.style.left),
          y: targetCenterY - parseFloat(entry.container.style.top),
          scale: 0.75,
          opacity: 0,
          duration: 0.75,
          ease: "power1.in",
          delay: idx * 0.04
        },
        "fly"
      );
    });
    tl.call(underlineFade, undefined, "fly");
    tl.call(() => {
      submitContainer.innerHTML = "";
    }, undefined, "fly+=1");
  }

  private createAnimatedLetter(char: string, startX: number, startY: number) {
    const container = document.createElement("div");
    container.className = "submit-anim__letter";
    container.style.left = `${startX}px`;
    container.style.top = `${startY}px`;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", "0 0 120 140");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");

    const defs = document.createElementNS(svgNS, "defs");
    const filter = document.createElementNS(svgNS, "filter");
    filter.setAttribute("id", "submit-dot-glow");
    const feGaussian = document.createElementNS(svgNS, "feGaussianBlur");
    feGaussian.setAttribute("stdDeviation", "3");
    feGaussian.setAttribute("result", "blur");
    filter.appendChild(feGaussian);
    defs.appendChild(filter);

    const guide = document.createElementNS(svgNS, "path");
    guide.setAttribute("d", "M10 90 C40 10 80 130 110 60");
    guide.setAttribute("fill", "none");
    guide.setAttribute("stroke", "transparent");
    guide.setAttribute("stroke-width", "2");

    const text = document.createElementNS(svgNS, "text");
    text.textContent = char;
    text.setAttribute("x", "50%");
    text.setAttribute("y", "68%");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.setAttribute("pathLength", "1");
    text.setAttribute("fill", "#f7fbff");
    text.setAttribute("fill-opacity", "0");
    text.setAttribute("stroke", "#f7cd42");
    text.setAttribute("stroke-width", "3");
    text.setAttribute("stroke-linejoin", "round");
    text.setAttribute("stroke-dasharray", "1");
    text.setAttribute("stroke-dashoffset", "1");
    text.setAttribute(
      "style",
      "font: 900 78px 'Play', 'Segoe UI', sans-serif; letter-spacing: 0.1em;"
    );

    const dot = document.createElementNS(svgNS, "circle");
    dot.setAttribute("r", "6");
    dot.setAttribute("fill", "#f7cd42");
    dot.setAttribute("cx", "10");
    dot.setAttribute("cy", "80");
    dot.setAttribute("opacity", "0");
    dot.setAttribute("filter", "url(#submit-dot-glow)");

    svg.appendChild(defs);
    svg.appendChild(guide);
    svg.appendChild(text);
    svg.appendChild(dot);
    container.appendChild(svg);
    container.style.transform = "translate(-50%, -50%) scale(0.4)";
    container.style.opacity = "0";

    return { container, text, guide, dot };
  }

  public syncRoomPlayers(
    snapshot: Array<{
      id: string;
      name: string;
      avatar?: string;
      isHost: boolean;
      score?: number;
      gems?: number;
      connected?: boolean;
      isSpectator?: boolean;
    }>
  ) {
    if (!this.roomId) return;
    const lookup = new Map(this.players.map((player) => [player.id, player]));
    const next: Player[] = [];
    snapshot.forEach((incoming) => {
      const existing = lookup.get(incoming.id);
      if (existing) {
        existing.name = incoming.name;
        existing.avatar = incoming.avatar;
        existing.isHost = incoming.isHost;
        existing.connected = incoming.connected ?? existing.connected;
        existing.isSpectator = incoming.isSpectator ?? existing.isSpectator;
        if (typeof incoming.score === "number") existing.score = incoming.score;
        if (typeof incoming.gems === "number") existing.gems = incoming.gems;
        next.push(existing);
      } else {
        next.push({
          id: incoming.id,
          name: incoming.name,
          avatar: incoming.avatar,
          score: incoming.score ?? 0,
          gems: incoming.gems ?? 3,
          isHost: incoming.isHost,
          connected: incoming.connected ?? false,
          isSpectator: incoming.isSpectator ?? false,
          lastWord: undefined,
          lastWordPoints: undefined
        });
      }
    });
    if (this.playerId) {
      const me = next.find((p) => p.id === this.playerId);
      if (me) me.connected = true;
    }
    this.players = next;
    if (this.playerId) {
      const me = this.players.find((player) => player.id === this.playerId);
      const nextSpectator = Boolean(me?.isSpectator);
      if (nextSpectator !== this.isSpectator) {
        this.isSpectator = nextSpectator;
        this.updateTurnUi();
      }
    }
    if (this.players.length === 0) {
      this.currentPlayerIndex = 0;
    } else if (this.currentPlayerIndex >= this.players.length) {
      this.currentPlayerIndex = this.currentPlayerIndex % this.players.length;
    }
    this.renderPlayers();
    this.updateTurnUi();
  }

  private logEvent(entry: string) {
    this.gameLog.push(entry);
    if (this.gameLog.length > 50) {
      this.gameLog.shift();
    }
  }

  private broadcastSelection(selection: Tile[]) {
    if (!this.isMultiplayer || !this.multiplayer) return;
    const ids = selection.map((tile) => this.board.getTileId(tile));
    this.multiplayer.updateSelection(ids);
  }

  private onTurnChanged(newPlayerId?: string, previousPlayerId?: string) {
    if (!newPlayerId || newPlayerId === previousPlayerId) return;
    soundManager.play("turn-change");
    if (!this.isMultiplayer) {
      this.turnStartTime = performance.now();
      this.restartTurnTimer();
    }
  }

  private updateTurnUi() {
    if (this.isSpectator) {
      this.submitButton.disabled = true;
      this.resetButton.disabled = true;
      this.shuffleButton.disabled = true;
      this.rerollButton.disabled = true;
      if (this.controlsWrap) {
        this.controlsWrap.style.display = "none";
      }
      if (this.powerPanel) {
        this.powerPanel.style.display = "none";
      }
      return;
    }
    if (!this.isMultiplayer) return;
    const isMyTurn = this.isMyTurn();
    if (this.wasMyTurn !== isMyTurn && isMyTurn) {
      this.board.clearSelection();
      this.board.setHovered(undefined);
      this.updateWord([]);
      this.broadcastSelection([]);
    }
    this.wasMyTurn = isMyTurn;
    this.submitButton.disabled = !isMyTurn;
    this.shuffleButton.disabled = !isMyTurn;
    this.rerollButton.disabled = !isMyTurn;
    if (this.controlsWrap) {
      this.controlsWrap.style.display = isMyTurn ? "flex" : "none";
    }
    if (this.powerPanel) {
      this.powerPanel.style.display = isMyTurn ? "flex" : "none";
    }
  }

  private isMyTurn(): boolean {
    if (this.isSpectator) return false;
    if (!this.isMultiplayer || !this.playerId) return false;
    const current = this.players[this.currentPlayerIndex];
    return current?.id === this.playerId;
  }

  private showServerWinner() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay modal--entering";
    const modal = document.createElement("div");
    modal.className = "modal modal--theme endgame-modal";

    const title = document.createElement("h3");
    title.textContent = "Top Wizards";

    const standings = [...this.players]
      .map((p) => ({
        ...p,
        finalScore: (p.score ?? 0) + (p.gems ?? 0)
      }))
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 3);

    const list = document.createElement("div");
    list.className = "endgame-list";

    standings.forEach((p, idx) => {
      const card = document.createElement("div");
      card.className = "lobby-player endgame-card";

      const header = document.createElement("div");
      header.className = "lobby-player__header endgame-card__header";
      const name = document.createElement("div");
      name.className = "lobby-player__name";
      name.textContent = `${idx + 1}. ${p.name}`;
      header.append(name);

      const meta = document.createElement("div");
      meta.className = "endgame-card__meta";
      const scorePill = document.createElement("span");
      scorePill.className = "pill pill--score endgame-card__score-pill";
      scorePill.innerHTML = `<i class="fa-solid fa-star pill__icon" aria-hidden="true"></i>${p.finalScore}`;
      meta.append(scorePill);

      const best = document.createElement("div");
      best.className = "player__lastWord";
      if (p.bestWord && p.bestWordPoints) {
        best.textContent = `Best: ${p.bestWord} (${p.bestWordPoints})`;
      } else {
        best.textContent = "Best: --";
      }

      card.append(header, meta, best);
      card.style.opacity = "0";
      card.style.transform = "translateY(10px) scale(0.96)";
      list.appendChild(card);
    });

    const actions = document.createElement("div");
    actions.className = "modal__actions";
    const closeBtn = document.createElement("button");
    closeBtn.className = "modal__btn primary";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", () => {
      overlay.classList.add("modal--leaving");
      window.setTimeout(() => overlay.remove(), 220);
    });
    actions.append(closeBtn);

    modal.append(title, list, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.remove("modal--entering");
      const cards = list.querySelectorAll<HTMLElement>(".endgame-card");
      gsap.to(cards, {
        opacity: 1,
        y: 0,
        scale: 1,
        duration: 0.45,
        ease: "back.out(1.6)",
        stagger: 1.5
      });
    });
  }

  // Debug helper to preview endgame modal without finishing a game
  public debugShowEndgamePreview() {
    this.showServerWinner();
  }

  public applyRemoteSelection(playerId: string, tileIds: string[]) {
    if (!this.isMultiplayer) return;
    if (playerId === this.playerId) return;
    if (this.isMyTurn()) return;
    this.board.setSelectionFromIds(tileIds);
    const selection = this.board.getSelection();
    this.updateWord(selection);
  }

  public applyGameSnapshot(snapshot: GameSnapshot) {
    if (snapshot.totalRounds && snapshot.totalRounds !== this.totalRounds) {
      this.totalRounds = snapshot.totalRounds;
    }
    this.board.applyExternalState(snapshot.tiles);
    const previousId = this.players[this.currentPlayerIndex]?.id;
    this.round = snapshot.round;
    this.currentPlayerIndex = snapshot.currentPlayerIndex;
    this.onTurnChanged(this.players[this.currentPlayerIndex]?.id, previousId);
    this.board.setMultipliersEnabled(snapshot.multipliersEnabled);
    this.board.setWordMultiplierEnabled(snapshot.wordMultiplierEnabled, {
      mode: this.isMultiplayer ? "sync" : "local",
      round: snapshot.round,
      tileId: snapshot.roundWordTileId
    });
    this.updateRoundLabel();
    const viewerId = this.isMultiplayer
      ? this.playerId
      : this.players[this.currentPlayerIndex]?.id;
    const swapActive = snapshot.swapModePlayerId === viewerId;
    this.board.setSwapMode(swapActive);
    this.swapMode = swapActive;
    if (snapshot.log && snapshot.log.length !== this.lastLogLength) {
      this.gameLog = [...snapshot.log];
      this.lastLogLength = snapshot.log.length;
    }
    if (snapshot.lastSubmission) {
      const token = `${snapshot.round}:${snapshot.lastSubmission.playerId}:${snapshot.lastSubmission.word}`;
      const submitter = this.players.find((p) => p.id === snapshot.lastSubmission!.playerId);
      if (submitter) {
        submitter.lastWord = snapshot.lastSubmission.word;
        submitter.lastWordPoints = snapshot.lastSubmission.points;
        if (
          typeof snapshot.lastSubmission.points === "number" &&
          (!submitter.bestWordPoints || snapshot.lastSubmission.points > submitter.bestWordPoints)
        ) {
          submitter.bestWordPoints = snapshot.lastSubmission.points;
          submitter.bestWord = snapshot.lastSubmission.word;
        }
      }
      if (token !== this.lastSubmissionToken) {
        this.lastSubmissionToken = token;
        soundManager.play("word-submit");
        this.playSubmissionWord(
          snapshot.lastSubmission.word,
          snapshot.lastSubmission.playerId,
          snapshot.lastSubmission.points
        );
      }
    }
    this.renderPlayers();
    if (typeof snapshot.turnStartedAt === "number") {
      const offset = Math.max(0, Date.now() - snapshot.turnStartedAt);
      this.turnStartTime = performance.now() - offset;
      this.restartTurnTimer();
    }
    this.updateTurnUi();
    if (snapshot.completed && !this.serverCompletionHandled) {
      this.serverCompletionHandled = true;
      this.showServerWinner();
    } else if (!snapshot.completed) {
      this.serverCompletionHandled = false;
    }
  }
}

function truncatePlayerName(name: string): string {
  if (name.length <= MAX_PLAYER_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_PLAYER_NAME_LENGTH - 1).trimEnd()}…`;
}
