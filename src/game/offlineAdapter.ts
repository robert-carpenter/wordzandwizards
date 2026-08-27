import {
  createInitialGameState,
  submitWord as sharedSubmitWord,
  shuffleBoard as sharedShuffleBoard,
  advanceRound as sharedAdvanceRound,
  advanceTurn as sharedAdvanceTurn,
  requestSwapMode as sharedRequestSwapMode,
  applySwap as sharedApplySwap,
  cancelSwap as sharedCancelSwap,
  startNewGame as sharedStartNewGame,
  toPublicGameState
} from "../shared/rules.js";
import type { GameState, Player, Room } from "../shared/rules.js";
import type { TileModel } from "../shared/gameTypes.js";

export interface OfflineAdapterOptions {
  totalRounds?: number;
  rng?: () => number;
}

export class OfflineAdapter {
  public room: Room;
  private rng?: () => number;

  constructor(options?: OfflineAdapterOptions) {
    this.rng = options?.rng;
    this.room = {
      id: "local-room",
      activityInstanceId: "local-room",
      createdAt: Date.now(),
      hostId: "local-player",
      status: "in-progress",
      rounds: options?.totalRounds ?? 5,
      players: [],
      chat: [],
      game: undefined
    };
    this.room.game = createInitialGameState(this.room.rounds);
  }

  public seedPlayers(players: Array<Pick<Player, "id" | "name" | "isHost">>) {
    this.room.players = players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      score: 0,
      gems: 3,
      joinedAt: Date.now(),
      connected: true,
      isSpectator: false
    }));
    if (!this.room.game) {
      this.room.game = createInitialGameState(this.room.rounds);
    }
  }

  public restart(totalRounds?: number) {
    this.withRng(() => sharedStartNewGame(this.room, totalRounds ?? this.room.rounds));
  }

  public submitWord(playerId: string, tileIds: string[], dictionary: Set<string>) {
    return this.withRng(() => sharedSubmitWord(this.room, playerId, tileIds, dictionary));
  }

  public shuffle(playerId: string) {
    return this.withRng(() => sharedShuffleBoard(this.room, playerId));
  }

  public requestSwapMode(playerId: string) {
    return sharedRequestSwapMode(this.room, playerId);
  }

  public applySwap(playerId: string, tileId: string, letter: string) {
    return sharedApplySwap(this.room, playerId, tileId, letter);
  }

  public cancelSwap(playerId: string) {
    return sharedCancelSwap(this.room, playerId);
  }

  public advanceTurn() {
    return this.withRng(() => sharedAdvanceTurn(this.room));
  }

  public advanceRound() {
    return this.withRng(() => sharedAdvanceRound(this.room));
  }

  public snapshot(): GameState | undefined {
    const snap = toPublicGameState(this.room.game);
    return snap ? { ...snap, log: this.room.game?.log ?? [] } : undefined;
  }

  public getTiles(): TileModel[] {
    return this.room.game?.tiles ?? [];
  }

  public getPlayers(): Player[] {
    return this.room.players;
  }

  private withRng<T>(fn: () => T): T {
    if (!this.rng) return fn();
    const original = Math.random;
    // eslint-disable-next-line no-global-assign
    Math.random = this.rng;
    try {
      return fn();
    } finally {
      // eslint-disable-next-line no-global-assign
      Math.random = original;
    }
  }
}
