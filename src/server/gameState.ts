import { GEM_TARGET, LETTER_COUNTS, LETTER_VALUES, MIN_VOWELS, VOWELS } from "../shared/constants.js";
import { GameSnapshot, LastSubmission, TileModel, type WordMultiplier } from "../shared/gameTypes.js";
import { GameState, Player, Room } from "./types.js";

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TRIPLE_CHANCE = 0.12;
const BOARD_COLS = 5;
const BOARD_ROWS = 5;
const DEFAULT_ROUND_COUNT = 5;
const LONG_WORD_THRESHOLD = 6;
const LONG_WORD_BONUS = 10;

function getActivePlayers(room: Room): Player[] {
  return room.players.filter((player: Player) => !player.isSpectator);
}

function hasActivePlayers(room: Room): boolean {
  return room.players.some((player: Player) => !player.isSpectator);
}

function findFirstActiveIndex(room: Room): number {
  return room.players.findIndex((player: Player) => !player.isSpectator);
}

function getCurrentTurnPlayer(room: Room): Player | undefined {
  const game = room.game;
  if (!game) return undefined;
  if (!hasActivePlayers(room)) return undefined;
  const players = room.players;
  if (!players.length) return undefined;
  if (
    game.currentPlayerIndex >= players.length ||
    players[game.currentPlayerIndex]?.isSpectator
  ) {
    const firstActive = findFirstActiveIndex(room);
    if (firstActive === -1) return undefined;
    game.currentPlayerIndex = firstActive;
  }
  return players[game.currentPlayerIndex];
}

function getNextActiveIndex(room: Room, currentIndex: number): {
  index: number;
  wrapped: boolean;
} {
  const players = room.players;
  const total = players.length;
  if (!total || !hasActivePlayers(room)) {
    return { index: currentIndex, wrapped: false };
  }
  let idx = currentIndex;
  do {
    idx = (idx + 1) % total;
    if (!players[idx].isSpectator) {
      return { index: idx, wrapped: idx <= currentIndex };
    }
  } while (idx !== currentIndex);
  return { index: currentIndex, wrapped: true };
}

export interface SubmitResult {
  success: boolean;
  error?: string;
  payload?: {
    word: string;
    points: number;
    gems: number;
    longWordBonus: boolean;
  };
}

export interface ActionResult {
  success: boolean;
  error?: string;
}

export function createInitialGameState(totalRounds = DEFAULT_ROUND_COUNT): GameState {
  const tiles = createTiles(true, false);
  return {
    cols: BOARD_COLS,
    rows: BOARD_ROWS,
    tiles,
    round: 1,
    totalRounds,
    currentPlayerIndex: 0,
    turnStartedAt: Date.now(),
    multipliersEnabled: true,
    wordMultiplierEnabled: false,
    roundWordTileId: undefined,
    swapModePlayerId: undefined,
    lastSubmission: undefined,
    completed: false,
    winnerId: undefined,
    log: []
  };
}

export function startNewGame(room: Room, totalRounds = room.rounds ?? DEFAULT_ROUND_COUNT) {
  room.game = createInitialGameState(totalRounds);
  room.players.forEach((player: Player) => {
    player.score = 0;
    player.gems = 3;
    player.isSpectator = false;
  });
  const firstActive = findFirstActiveIndex(room);
  if (firstActive >= 0 && room.game) {
    room.game.currentPlayerIndex = firstActive;
    room.game.turnStartedAt = Date.now();
  }
}

export function submitWord(
  room: Room,
  playerId: string,
  tileIds: string[],
  dictionary: Set<string>
): SubmitResult {
  const game = requireGame(room);
  if (!game) return { success: false, error: "Game not started." };
  if (game.completed) {
    return { success: false, error: "Game already completed." };
  }
  if (!tileIds.length) {
    return { success: false, error: "Select tiles to form a word." };
  }
  const player = getCurrentTurnPlayer(room);
  if (!player) {
    return { success: false, error: "No active players available." };
  }
  if (player.id !== playerId) {
    return { success: false, error: "It is not your turn." };
  }

  const tiles = tileIds.map((id) => game.tiles.find((tile: TileModel) => tile.id === id));
  if (tiles.some((tile) => !tile)) {
    return { success: false, error: "Invalid tile selection." };
  }
  const typedTiles = tiles as TileModel[];
  if (!isValidSelection(typedTiles)) {
    return {
      success: false,
      error: "Tiles must be unique and touch the previous tile."
    };
  }

  const word = typedTiles.map((tile) => tile.letter).join("");
  if (!dictionary.has(word.toUpperCase())) {
    return { success: false, error: `"${word}" is not a valid word.` };
  }

  const longWordBonus = word.length >= LONG_WORD_THRESHOLD;
  const points = calculateWordScore(typedTiles, longWordBonus);
  const gems = typedTiles.filter((tile) => tile.hasGem).length;

  player.score += points;
  player.gems += gems;

  refreshTiles(game, typedTiles);
  assignMultipliers(game);

  const submission: LastSubmission = {
    playerId: player.id,
    playerName: player.name,
    word: word.toUpperCase(),
    points,
    gems,
    longWordBonus
  };
  game.lastSubmission = submission;
  addLogEntry(
    game,
    `Round ${game.round}: ${submission.playerName} scored ${submission.points} pts${
      submission.gems ? ` and ${submission.gems} gem(s)` : ""
    } with ${submission.word}.`
  );

  advanceTurn(room);

  return {
    success: true,
    payload: {
      word: submission.word,
      points,
      gems,
      longWordBonus
    }
  };
}

export function shuffleBoard(room: Room, playerId: string): ActionResult {
  const game = requireGame(room);
  if (!game) return { success: false, error: "Game not started." };
  const player = room.players.find((p: Player) => p.id === playerId);
  if (!player) return { success: false, error: "Player not found." };
  if (player.isSpectator) return { success: false, error: "Spectators cannot use Shuffle." };
  if (player.gems < 1) return { success: false, error: "Need 1 gem to shuffle." };
  player.gems -= 1;
  const payload = game.tiles.map((tile: TileModel) => ({
    letter: tile.letter,
    multiplier: tile.multiplier,
    hasGem: tile.hasGem,
    wordMultiplier: "none" as WordMultiplier
  }));
  const preservedWordId = game.wordMultiplierEnabled ? game.roundWordTileId : undefined;
  shuffleArray(payload);
  game.tiles.forEach((tile: TileModel, index: number) => {
    const data = payload[index];
    tile.letter = data.letter;
    tile.multiplier = data.multiplier;
    tile.hasGem = data.hasGem;
    tile.wordMultiplier = "none";
  });
  // keep roundWordTileId stable during shuffle; if missing and enabled, pick one
  if (game.wordMultiplierEnabled && !game.roundWordTileId && game.tiles.length) {
    const random = game.tiles[Math.floor(Math.random() * game.tiles.length)];
    game.roundWordTileId = random?.id;
  } else if (preservedWordId) {
    game.roundWordTileId = preservedWordId;
  }
  applyRoundWordTile(game);
  return { success: true };
}

export function requestSwapMode(room: Room, playerId: string): ActionResult {
  const game = requireGame(room);
  if (!game) return { success: false, error: "Game not started." };
  const player = room.players.find((p: Player) => p.id === playerId);
  if (!player) return { success: false, error: "Player not found." };
  if (player.isSpectator) return { success: false, error: "Spectators cannot swap letters." };
  if (player.gems < 3) return { success: false, error: "Need 3 gems to swap a letter." };
  game.swapModePlayerId = playerId;
  return { success: true };
}

export function applySwap(
  room: Room,
  playerId: string,
  tileId: string,
  letter: string
): ActionResult {
  const game = requireGame(room);
  if (!game) return { success: false, error: "Game not started." };
  const player = room.players.find((p: Player) => p.id === playerId);
  if (!player) return { success: false, error: "Player not found." };
  if (player.isSpectator) {
    return { success: false, error: "Spectators cannot swap letters." };
  }
  if (game.swapModePlayerId !== playerId) {
    return { success: false, error: "You are not swapping a letter." };
  }
  if (player.gems < 3) {
    return { success: false, error: "You do not have enough gems." };
  }
  // Preserve existing letter multipliers before mutating tiles.
  const multiplierSnapshot = new Map<string, TileModel["multiplier"]>();
  game.tiles.forEach((t) => multiplierSnapshot.set(t.id, t.multiplier));

  const tile = game.tiles.find((t: TileModel) => t.id === tileId);
  if (!tile) {
    return { success: false, error: "Tile not found." };
  }
  player.gems -= 3;
  tile.letter = normalizeLetter(letter);
  tile.hasGem = tile.hasGem; // no change
  // Restore multiplier state exactly as before the swap.
  game.tiles.forEach((t) => {
    t.multiplier = multiplierSnapshot.get(t.id) ?? "none";
  });
  game.swapModePlayerId = undefined;
  return { success: true };
}

export function cancelSwap(room: Room, playerId: string) {
  const game = requireGame(room);
  if (!game) return;
  if (game.swapModePlayerId === playerId) {
    game.swapModePlayerId = undefined;
  }
}

export function toPublicGameState(game?: GameState): GameSnapshot | undefined {
  if (!game) return undefined;
  return { ...game };
}

function createTiles(
  multipliersEnabled: boolean,
  wordMultiplierEnabled: boolean
): TileModel[] {
  const tiles: TileModel[] = [];
  const bag = buildLetterBag();
  for (let y = 0; y < BOARD_ROWS; y += 1) {
    for (let x = 0; x < BOARD_COLS; x += 1) {
      const draw = drawLetterFromBag(bag);
      tiles.push({
        id: tileId(x, y),
        x,
        y,
        letter: draw.letter,
        hasGem: false,
        multiplier: "none",
        wordMultiplier: "none"
      });
    }
  }
  assignRandomGems(tiles);
  ensureMinimumVowels(tiles, MIN_VOWELS, bag);
  if (multipliersEnabled) {
    ensureLetterMultiplier(tiles);
  }
  if (wordMultiplierEnabled) {
    ensureWordMultiplier({
      tiles,
      wordMultiplierEnabled: true,
      roundWordTileId: undefined
    } as GameState);
  }
  return tiles;
}

function refreshTiles(game: GameState, tiles: TileModel[]) {
  const bag = buildLetterBag();
  const refreshIds = new Set(tiles.map((t) => t.id));
  game.tiles.forEach((tile) => {
    if (!refreshIds.has(tile.id)) {
      consumeLetterFromBag(bag, tile.letter);
    }
  });
  tiles.forEach((tile: TileModel) => {
    const draw = drawLetterFromBag(bag);
    tile.letter = draw.letter;
    tile.hasGem = false;
    tile.multiplier = "none";
  });
  topUpGems(game.tiles);
  applyRoundWordTile(game);
  ensureMinimumVowels(game.tiles, MIN_VOWELS, bag);
}

function assignMultipliers(game: GameState) {
  if (game.multipliersEnabled) {
    ensureLetterMultiplier(game.tiles);
  }
}

function ensureLetterMultiplier(tiles: TileModel[]) {
  const existing = tiles.find((tile: TileModel) => tile.multiplier !== "none");
  if (existing) return;
  const candidates = tiles.filter((tile: TileModel) => tile.multiplier === "none");
  if (!candidates.length) return;
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  target.multiplier = Math.random() < TRIPLE_CHANCE ? "tripleLetter" : "doubleLetter";
}

function isValidSelection(tiles: TileModel[]): boolean {
  const seen = new Set<string>();
  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i];
    if (seen.has(tile.id)) {
      return false;
    }
    seen.add(tile.id);
    if (i === 0) continue;
    const prev = tiles[i - 1];
    const dx = Math.abs(prev.x - tile.x);
    const dy = Math.abs(prev.y - tile.y);
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
      return false;
    }
  }
  return true;
}

function calculateWordScore(tiles: TileModel[], hasLongWordBonus: boolean): number {
  const baseScore = tiles.reduce((total, tile) => {
    const base = LETTER_VALUES[tile.letter.toLowerCase()] ?? 0;
    const multiplier =
      tile.multiplier === "tripleLetter" ? 3 : tile.multiplier === "doubleLetter" ? 2 : 1;
    return total + base * multiplier;
  }, 0);
  const hasDoubleWord = tiles.some((tile) => tile.wordMultiplier === "doubleWord");
  const total = hasDoubleWord ? baseScore * 2 : baseScore;
  return total + (hasLongWordBonus ? LONG_WORD_BONUS : 0);
}

export function advanceTurn(room: Room) {
  const game = requireGame(room);
  if (!game) return;
  if (!hasActivePlayers(room)) return;
  const { index, wrapped } = getNextActiveIndex(room, game.currentPlayerIndex);
  game.currentPlayerIndex = index;
  game.turnStartedAt = Date.now();
  if (wrapped) {
    advanceRound(room);
  }
}

function determineWinner(room: Room) {
  const candidates = getActivePlayers(room);
  const pool = candidates.length ? candidates : room.players;
  const sorted = [...pool].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  if (room.game) {
    room.game.winnerId = top?.id;
  }
}

export function addLogEntry(game: GameState, message: string) {
  game.log.push(message);
  if (game.log.length > 50) {
    game.log.shift();
  }
}

export function advanceRound(room: Room) {
  const game = requireGame(room);
  if (!game) return;
  if (game.round < game.totalRounds) {
    game.round += 1;
    game.multipliersEnabled = game.round > 1;
    game.wordMultiplierEnabled = game.round >= 2;
    assignMultipliers(game);
    if (!game.wordMultiplierEnabled) {
      game.roundWordTileId = undefined;
    }
    if (game.wordMultiplierEnabled) {
      selectRoundWordTile(game, true);
    } else {
      applyRoundWordTile(game);
    }
    ensureMinimumVowels(game.tiles, MIN_VOWELS);
    game.turnStartedAt = Date.now();
  } else {
    game.completed = true;
    determineWinner(room);
  }
}

function assignRandomGems(tiles: TileModel[], target = GEM_TARGET) {
  tiles.forEach((tile) => {
    if (tile.hasGem) {
      tile.hasGem = false;
    }
  });
  topUpGems(tiles, target);
}

function topUpGems(tiles: TileModel[], target = GEM_TARGET) {
  if (!tiles.length) return;
  const desired = Math.min(target, tiles.length);
  const current = tiles.reduce((count, tile) => count + (tile.hasGem ? 1 : 0), 0);
  if (current >= desired) return;
  const pool = tiles.filter((tile) => !tile.hasGem);
  if (!pool.length) return;
  shuffleArray(pool);
  const needed = Math.min(desired - current, pool.length);
  for (let i = 0; i < needed; i += 1) {
    pool[i].hasGem = true;
  }
}

function ensureMinimumVowels(tiles: TileModel[], target = MIN_VOWELS, bag?: Map<string, number>) {
  if (!tiles.length) return;
  const desired = Math.min(target, tiles.length);
  const current = tiles.reduce((count, tile) => count + (isVowel(tile.letter) ? 1 : 0), 0);
  if (current >= desired) return;
  const pool = tiles.filter((tile) => !isVowel(tile.letter));
  if (!pool.length) return;
  shuffleArray(pool);
  const needed = Math.min(desired - current, pool.length);
  for (let i = 0; i < needed; i += 1) {
    if (bag) {
      returnLetterToBag(bag, pool[i].letter);
      const draw = drawLetterFromBag(bag, (letter) => isVowel(letter));
      pool[i].letter = draw.letter;
    } else {
      pool[i].letter = randomVowel();
    }
  }
}

function shuffleArray<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function selectRoundWordTile(game: GameState, forceNew = false) {
  if (!game.wordMultiplierEnabled) {
    game.roundWordTileId = undefined;
    applyRoundWordTile(game);
    return;
  }
  const tiles = game.tiles;
  if (!tiles.length) return;
  let candidates = [...tiles];
  if (forceNew && game.roundWordTileId && candidates.length > 1) {
    candidates = candidates.filter((tile) => tile.id !== game.roundWordTileId);
    if (!candidates.length) {
      candidates = [...tiles];
    }
  }
  const target = candidates[Math.floor(Math.random() * candidates.length)];
  game.roundWordTileId = target.id;
  applyRoundWordTile(game);
}

function ensureWordMultiplier(game: GameState) {
  if (!game.wordMultiplierEnabled) return;
  const hasTarget =
    game.roundWordTileId && game.tiles.some((tile) => tile.id === game.roundWordTileId);
  if (hasTarget) {
    applyRoundWordTile(game);
    return;
  }
  selectRoundWordTile(game, true);
}

function applyRoundWordTile(game: GameState) {
  const targetId = game.wordMultiplierEnabled ? game.roundWordTileId : undefined;
  game.tiles.forEach((tile) => {
    tile.wordMultiplier = targetId && tile.id === targetId ? "doubleWord" : "none";
  });
}

function buildLetterBag(): Map<string, number> {
  const bag = new Map<string, number>();
  Object.entries(LETTER_COUNTS).forEach(([letter, count]) => {
    bag.set(letter.toUpperCase(), Math.max(0, count ?? 0));
  });
  return bag;
}

function normalizeLetterKey(letter: string): string {
  return (letter ?? "").trim().charAt(0).toUpperCase();
}

function consumeLetterFromBag(bag: Map<string, number>, letter: string): boolean {
  const key = normalizeLetterKey(letter);
  const current = bag.get(key);
  if (typeof current !== "number" || current <= 0) return false;
  bag.set(key, current - 1);
  return true;
}

function returnLetterToBag(bag: Map<string, number>, letter: string) {
  const key = normalizeLetterKey(letter);
  if (!key) return;
  bag.set(key, (bag.get(key) ?? 0) + 1);
}

function drawLetterFromBag(
  bag: Map<string, number>,
  filter?: (letter: string) => boolean
): { letter: string; fromBag: boolean } {
  const entries = Array.from(bag.entries()).filter(([letter, count]) => {
    if (count <= 0) return false;
    return filter ? filter(letter) : true;
  });
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total > 0 && entries.length) {
    const target = Math.random() * total;
    let cumulative = 0;
    for (const [letter, count] of entries) {
      cumulative += count;
      if (target <= cumulative) {
        consumeLetterFromBag(bag, letter);
        return { letter, fromBag: true };
      }
    }
  }
  return { letter: randomLetter(), fromBag: false };
}

function randomLetter(): string {
  return LETTERS[Math.floor(Math.random() * LETTERS.length)];
}

function randomVowel(): string {
  return VOWELS[Math.floor(Math.random() * VOWELS.length)];
}

function isVowel(letter: string): boolean {
  return VOWELS.includes((letter ?? "").toUpperCase());
}

function normalizeLetter(letter: string): string {
  const upper = (letter ?? "").trim().charAt(0).toUpperCase();
  return LETTERS.includes(upper) ? upper : randomLetter();
}

function tileId(x: number, y: number): string {
  return `${x}-${y}`;
}

function requireGame(room: Room): GameState | undefined {
  return room.game;
}
