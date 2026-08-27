import {
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Texture,
  DoubleSide
} from "three";
import type { TileModel } from "../shared/gameTypes";
import {
  GEM_TARGET,
  LETTER_COUNTS,
  LETTERS,
  LETTER_VALUES,
  MIN_VOWELS,
  TRIPLE_CHANCE,
  VOWELS
} from "../shared/constants";

export type TileMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;

export type TileState = "base" | "hover" | "selected";
export type Multiplier = "none" | "doubleLetter" | "tripleLetter";
export type WordMultiplier = "none" | "doubleWord";

export interface SelectionResult {
  selection: Tile[];
  success: boolean;
  action?: "added" | "removed";
  reason?: string;
}

export interface Tile {
  id: string;
  mesh: TileMesh;
  letter: string;
  x: number;
  y: number;
  state: TileState;
  hasGem: boolean;
  multiplier: Multiplier;
  badge?: Mesh<PlaneGeometry, MeshBasicMaterial>;
  wordMultiplier: WordMultiplier;
  wordBadge?: Mesh<PlaneGeometry, MeshBasicMaterial>;
  wordOutline?: Mesh;
  bagTracked: boolean;
}

export class WordBoard extends Group {
  public readonly cols: number;
  public readonly rows: number;
  public readonly tileSize = 1.3 * 1.1;

  private tiles: Tile[] = [];
  private tileMap = new Map<string, Tile>();
  private hovered?: Tile;
  private selected = new Set<Tile>();
  private selectedOrder: Tile[] = [];
  private baseGeometry = new PlaneGeometry(1, 1);
  private textureCache = new Map<string, Texture>();
  private connectionsGroup = new Group();
  private connectionGeometry = new PlaneGeometry(1, 1);
  private connectionMaterial: MeshBasicMaterial;
  private connectionPool: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private activeConnections: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private connectionThickness = 0.2;
  private badgeGeometry = new PlaneGeometry(0.55, 0.55);
  private badgeMaterials = new Map<Multiplier, MeshBasicMaterial>();
  private wordBadgeGeometry = new PlaneGeometry(0.5, 0.5);
  private wordBadgeMaterial?: MeshBasicMaterial;
  private multipliersEnabled = true;
  private swapMode = false;
  private wordMultiplierEnabled = false;
  private wordMultiplierControl: "local" | "sync" = "local";
  private currentWordMultiplierRound = 1;
  private roundWordTileId?: string;
  private letterBag = new Map<string, number>();
  private bagTotal = 0;
  private shuffleAnimating = false;

  constructor(cols = 5, rows = 5) {
    super();
    this.cols = cols;
    this.rows = rows;
    this.name = "WordBoard";

    this.connectionMaterial = new MeshBasicMaterial({
      color: "#39b9ff",
      transparent: true,
      opacity: 0.9
    });

    this.connectionsGroup.position.z = -0.04;
    this.add(this.connectionsGroup);

    this.buildTiles();
  }

  public allTiles(): Tile[] {
    return this.tiles;
  }

  public getTileById(id: string): Tile | undefined {
    return this.tileMap.get(id);
  }

  public getTileId(tile: Tile): string {
    return tile.id;
  }

  public applyExternalState(states: TileModel[]) {
    const selectionSet = new Set(this.selected);
    const applyUpdates = () => {
      states.forEach((state) => {
        const tile = this.tileMap.get(state.id);
        if (!tile) return;
        tile.letter = state.letter;
        tile.hasGem = state.hasGem;
        tile.multiplier = state.multiplier;
        tile.wordMultiplier = state.wordMultiplier;
        tile.bagTracked = true;
        const nextState = selectionSet.has(tile)
          ? "selected"
          : tile === this.hovered
            ? "hover"
            : "base";
        this.applyStyle(tile, nextState);
        this.updateMultiplierBadge(tile);
        this.updateWordMultiplierBadge(tile);
        this.updateSwapTint(tile);
      });
      this.updateSelectionLine();
      this.rebuildLetterBagFromBoard();
    };

    const moves =
      !this.shuffleAnimating && states.length === this.tiles.length
        ? this.deriveShuffleMoves(states)
        : null;

    if (moves && moves.some((move) => move.from !== move.to)) {
      this.animateShuffle(moves, () => {
        applyUpdates();
      });
    } else {
      applyUpdates();
    }
  }

  public setSelectionFromIds(tileIds: string[]) {
    this.clearSelection();
    tileIds.forEach((id) => {
      const tile = this.tileMap.get(id);
      if (!tile) return;
      this.selected.add(tile);
      this.selectedOrder.push(tile);
      this.applyStyle(tile, "selected");
    });
    this.updateSelectionLine();
  }

  public setHovered(tile?: Tile) {
    if (this.hovered === tile) return;

    if (this.hovered && !this.selected.has(this.hovered)) {
      this.applyStyle(this.hovered, "base");
    }

    this.hovered = tile;

    if (this.hovered && !this.selected.has(this.hovered)) {
      this.applyStyle(this.hovered, "hover");
    }
  }

  public selectTile(tile: Tile): SelectionResult {
    const last = this.selectedOrder[this.selectedOrder.length - 1];

    if (this.selected.has(tile)) {
      if (last !== tile) {
        return {
          selection: [...this.selectedOrder],
          success: false,
          reason: "Undo letters in reverse order."
        };
      }

      this.selected.delete(tile);
      this.selectedOrder.pop();
      this.applyStyle(tile, tile === this.hovered ? "hover" : "base");
      this.updateSelectionLine();
      return {
        selection: [...this.selectedOrder],
        success: true,
        action: "removed"
      };
    }

    if (last && !this.areNeighbors(last, tile)) {
      return {
        selection: [...this.selectedOrder],
        success: false,
        reason: "Next letter must touch the previous tile."
      };
    }

    this.selected.add(tile);
    this.selectedOrder.push(tile);
    this.applyStyle(tile, "selected");
    this.updateSelectionLine();
    return {
      selection: [...this.selectedOrder],
      success: true,
      action: "added"
    };
  }

  public clearSelection() {
    for (const tile of this.selected) {
      this.applyStyle(tile, tile === this.hovered ? "hover" : "base");
    }
    this.selected.clear();
    this.selectedOrder = [];
    this.updateSelectionLine();
  }

  public getSelection(): Tile[] {
    return [...this.selectedOrder];
  }

  public collectGemsFromSelection(): number {
    let collected = 0;
    for (const tile of this.selectedOrder) {
      if (tile.hasGem) {
        collected += 1;
        tile.hasGem = false;
        this.applyStyle(tile, tile.state);
      }
    }
    return collected;
  }

  public shuffleLetters() {
    if (!this.tiles.length || this.shuffleAnimating) return;
    const payload = this.tiles.map((tile) => ({
      sourceTile: tile,
      letter: tile.letter,
      bagTracked: tile.bagTracked,
      multiplier: tile.multiplier
    }));

    this.shuffleArray(payload);

    const moves = this.tiles.map((tile, index) => ({
      from: payload[index].sourceTile,
      to: tile
    }));

    const applyShuffle = () => {
      this.tiles.forEach((tile, index) => {
        const data = payload[index];
        tile.letter = data.letter;
        tile.bagTracked = data.bagTracked;
        tile.multiplier = data.multiplier;
        this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
        this.updateMultiplierBadge(tile);
      });
      if (this.wordMultiplierControl === "local") {
        if (this.wordMultiplierEnabled) {
          this.roundWordTileId = this.pickRoundWordTile(true);
        }
        this.applyRoundWordMultiplier();
      } else {
        this.tiles.forEach((tile) => this.updateWordMultiplierBadge(tile));
      }
      this.updateSelectionLine();
    };

    if (moves.every((move) => move.from === move.to)) {
      applyShuffle();
    } else {
      this.animateShuffle(moves, applyShuffle);
    }
  }

  public rerollLetter(tile: Tile) {
    this.releaseTileLetter(tile);
    this.assignLetterFromBag(tile);
    this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
    this.updateSelectionLine();
    this.ensureMinimumVowels();
  }

  public swapTileLetter(tile: Tile, letter: string) {
    this.releaseTileLetter(tile);
    tile.letter = this.normalizeLetter(letter);
    tile.bagTracked = false;
    this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
  }

  public setSwapMode(active: boolean) {
    if (this.swapMode === active) return;
    this.swapMode = active;
    this.tiles.forEach((tile) => this.updateSwapTint(tile));
  }

  public refreshTiles(tiles: Tile[], _resetWordMultiplier = false) {
    tiles.forEach((tile) => {
      this.releaseTileLetter(tile);
      this.assignLetterFromBag(tile);
      tile.hasGem = false;
      tile.multiplier = "none";

      this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
      this.updateMultiplierBadge(tile);
      this.updateWordMultiplierBadge(tile);
      this.updateSwapTint(tile);
    });

    this.ensureMinimumVowels(MIN_VOWELS, tiles);
    this.ensureMultiplier(tiles);
    if (this.wordMultiplierControl === "local") {
      this.applyRoundWordMultiplier();
    }

    this.ensureGemQuota();
    this.updateSelectionLine();
  }

  public setMultipliersEnabled(enabled: boolean) {
    this.multipliersEnabled = enabled;
    if (!enabled) {
      this.tiles.forEach((tile) => {
        tile.multiplier = "none";
        this.applyStyle(tile, this.selected.has(tile) ? "selected" : "base");
        this.updateMultiplierBadge(tile);
      });
    } else {
      this.ensureMultiplier();
    }
  }

  public setWordMultiplierEnabled(
    enabled: boolean,
    options?: { round?: number; mode?: "local" | "sync"; tileId?: string }
  ) {
    if (options?.mode) {
      this.wordMultiplierControl = options.mode;
    }
    const roundValue = options?.round ?? this.currentWordMultiplierRound;
    const roundChanged = roundValue !== this.currentWordMultiplierRound;
    this.currentWordMultiplierRound = roundValue;
    const previousState = this.wordMultiplierEnabled;
    this.wordMultiplierEnabled = enabled;
    const providedTile = typeof options?.tileId === "string" ? options.tileId : undefined;

    if (this.wordMultiplierControl === "sync") {
      if (!enabled) {
        this.roundWordTileId = undefined;
      } else if (providedTile) {
        this.roundWordTileId = providedTile;
      }
      return;
    }

    if (!enabled) {
      this.roundWordTileId = undefined;
      this.tiles.forEach((tile) => {
        tile.wordMultiplier = "none";
        this.updateWordMultiplierBadge(tile);
      });
      return;
    }

    if (providedTile) {
      this.roundWordTileId = providedTile;
    }

    const shouldSelectNew =
      !providedTile && (roundChanged || !previousState || !this.roundWordTileId);
    if (shouldSelectNew) {
      this.roundWordTileId = this.pickRoundWordTile(roundChanged || !previousState);
    }
    this.applyRoundWordMultiplier();
  }

  public width(): number {
    return (this.cols - 1) * this.tileSize;
  }

  public height(): number {
    return (this.rows - 1) * this.tileSize;
  }

  private areNeighbors(a: Tile, b: Tile): boolean {
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
  }

  private acquireConnectionMesh(): Mesh<PlaneGeometry, MeshBasicMaterial> {
    const mesh = this.connectionPool.pop();
    if (mesh) {
      mesh.visible = true;
      return mesh;
    }

    const newMesh = new Mesh(this.connectionGeometry, this.connectionMaterial);
    newMesh.visible = true;
    newMesh.renderOrder = -1;
    return newMesh;
  }

  private releaseActiveConnections() {
    for (const mesh of this.activeConnections) {
      mesh.visible = false;
      this.connectionsGroup.remove(mesh);
      this.connectionPool.push(mesh);
    }
    this.activeConnections = [];
  }

  private ensureMultiplier(exclude: Tile[] = []) {
    if (!this.multipliersEnabled) return;
    const existing = this.tiles.find((tile) => tile.multiplier !== "none");
    if (existing) return;

    const excludedSet = new Set(exclude);
    let candidates = this.tiles.filter((tile) => tile.multiplier === "none" && !excludedSet.has(tile));
    if (!candidates.length) {
      candidates = this.tiles.filter((tile) => tile.multiplier === "none");
    }
    if (!candidates.length) return;

    const target = candidates[Math.floor(Math.random() * candidates.length)];
    target.multiplier = Math.random() < TRIPLE_CHANCE ? "tripleLetter" : "doubleLetter";
    this.applyStyle(target, this.selected.has(target) ? "selected" : "base");
    this.updateMultiplierBadge(target);
  }

  private pickRoundWordTile(forceNew = false): string | undefined {
    if (!this.tiles.length) return undefined;
    let candidates = [...this.tiles];
    if (forceNew && this.roundWordTileId && candidates.length > 1) {
      candidates = candidates.filter((tile) => tile.id !== this.roundWordTileId);
      if (!candidates.length) {
        candidates = [...this.tiles];
      }
    }
    const target = candidates[Math.floor(Math.random() * candidates.length)];
    return target?.id;
  }

  private applyRoundWordMultiplier() {
    if (this.wordMultiplierControl === "sync") return;
    const targetId = this.wordMultiplierEnabled ? this.roundWordTileId : undefined;
    this.tiles.forEach((tile) => {
      const next = targetId && tile.id === targetId ? "doubleWord" : "none";
      if (tile.wordMultiplier !== next) {
        tile.wordMultiplier = next;
        this.updateWordMultiplierBadge(tile);
      }
    });
  }

  private assignRandomGems(target = GEM_TARGET) {
    this.tiles.forEach((tile) => {
      if (tile.hasGem) {
        tile.hasGem = false;
        this.applyStyle(tile, tile.state);
      }
    });
    this.ensureGemQuota(target);
    if (this.wordMultiplierControl === "local") {
      this.applyRoundWordMultiplier();
    }
  }

  private ensureGemQuota(target = GEM_TARGET) {
    if (!this.tiles.length) return;
    const desired = Math.min(target, this.tiles.length);
    const current = this.tiles.reduce((count, tile) => count + (tile.hasGem ? 1 : 0), 0);
    if (current >= desired) return;
    const missing = desired - current;
    const candidates = this.tiles.filter((tile) => !tile.hasGem);
    if (!candidates.length) return;
    this.shuffleArray(candidates);
    const additions = Math.min(missing, candidates.length);
    for (let i = 0; i < additions; i += 1) {
      const tile = candidates[i];
      tile.hasGem = true;
      this.applyStyle(tile, tile.state);
    }
  }

  private ensureMinimumVowels(target = MIN_VOWELS, scope?: Tile[]) {
    const pool = scope && scope.length ? scope : this.tiles;
    if (!pool.length) return;
    const desired = Math.min(target, pool.length);
    const current = pool.reduce((count, tile) => count + (this.isVowel(tile.letter) ? 1 : 0), 0);
    if (current >= desired) return;
    const candidates = pool.filter((tile) => !this.isVowel(tile.letter));
    if (!candidates.length) return;
    this.shuffleArray(candidates);
    const needed = Math.min(desired - current, candidates.length);
    for (let i = 0; i < needed; i += 1) {
      this.forceTileToVowel(candidates[i]);
    }
  }

  private forceTileToVowel(tile: Tile) {
    this.releaseTileLetter(tile);
    const draw = this.drawLetterFromBag((letter) => this.isVowel(letter));
    tile.letter = this.normalizeLetter(draw.letter);
    tile.bagTracked = draw.fromBag;
    const nextState = this.selected.has(tile)
      ? "selected"
      : tile === this.hovered
        ? "hover"
        : "base";
    this.applyStyle(tile, nextState);
    this.updateMultiplierBadge(tile);
    this.updateWordMultiplierBadge(tile);
    this.updateSwapTint(tile);
    if (this.wordMultiplierControl === "local") {
      this.applyRoundWordMultiplier();
    }
  }

  private shuffleArray<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
  }

  private createMultiplierBadge(multiplier: Multiplier): Mesh<PlaneGeometry, MeshBasicMaterial> {
    let material = this.badgeMaterials.get(multiplier);
    if (!material) {
      const texture = this.generateBadgeTexture(multiplier);
      material = new MeshBasicMaterial({
        map: texture,
        transparent: true
      });
      this.badgeMaterials.set(multiplier, material);
    }
    const mesh = new Mesh<PlaneGeometry, MeshBasicMaterial>(this.badgeGeometry, material);
    mesh.renderOrder = 5;
    return mesh;
  }

  private generateBadgeTexture(multiplier: Multiplier): CanvasTexture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2d context");

    ctx.fillStyle = multiplier === "tripleLetter" ? "#f2a93d" : "#536cff";
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.font = "bold 140px 'Play', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(multiplier === "tripleLetter" ? "TL" : "DL", size / 2, size / 2 + 10);

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private updateMultiplierBadge(tile: Tile) {
    if (tile.badge) {
      tile.mesh.remove(tile.badge);
      tile.badge = undefined;
    }
    if (tile.multiplier === "none") return;

    const badge = this.createMultiplierBadge(tile.multiplier);
    badge.scale.set(.8,.8,.8);
    badge.position.set(-0.45, 0.45, 0.05);
    tile.mesh.add(badge);
    tile.badge = badge;
  }

  private updateSwapTint(tile: Tile) {
    tile.mesh.material.color.set(this.swapMode ? 0xC4E6F5 : 0xffffff);
  }

  private updateWordMultiplierBadge(tile: Tile) {
    if (tile.wordBadge) {
      tile.mesh.remove(tile.wordBadge);
      tile.wordBadge = undefined;
    }
    if (tile.wordOutline) {
      tile.mesh.remove(tile.wordOutline);
      tile.wordOutline = undefined;
    }
    if (tile.wordMultiplier === "none") return;

    const badge = this.createWordMultiplierBadge();
    badge.position.set(0.45, 0.45, 0.05);

    const outline = this.createWordMultiplierOutline();
    outline.position.set(0, 0, 0.01);

    tile.mesh.add(outline);
    tile.mesh.add(badge);
    tile.wordBadge = badge;
    tile.wordOutline = outline;
  }

  private createWordMultiplierBadge(): Mesh<PlaneGeometry, MeshBasicMaterial> {
    if (!this.wordBadgeMaterial) {
      const texture = this.generateWordMultiplierBadgeTexture();
      this.wordBadgeMaterial = new MeshBasicMaterial({
        map: texture,
        transparent: true
      });
    }
    const mesh = new Mesh(this.wordBadgeGeometry, this.wordBadgeMaterial);
    mesh.renderOrder = 5;
    return mesh;
  }

  private wordOutlineMaterial?: MeshBasicMaterial;

  private createWordMultiplierOutline(): Mesh<PlaneGeometry, MeshBasicMaterial> {
    if (!this.wordOutlineMaterial) {
      const texture = this.generateWordOutlineTexture();
      this.wordOutlineMaterial = new MeshBasicMaterial({
        map: texture,
        transparent: true,
        side: DoubleSide,
        depthWrite: false
      });
    }
    const geo = new PlaneGeometry(1.15, 1.15);
    const mesh = new Mesh(geo, this.wordOutlineMaterial);
    mesh.renderOrder = 4;
    return mesh;
  }

  private generateWordOutlineTexture(): CanvasTexture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = "rgba(44, 208, 165, 1)";
    ctx.lineWidth = 20;
    ctx.lineJoin = "round";
    const inset = 16;
    ctx.strokeRect(inset, inset, size - inset * 2, size - inset * 2);
    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private generateWordMultiplierBadgeTexture(): CanvasTexture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2d context");

    ctx.fillStyle = "rgba(44, 208, 165, 1)";
    ctx.strokeStyle = "rgba(44, 208, 165, .45)";
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#fff";
    ctx.font = "bold 120px 'Play', 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("2W", size / 2, size / 2 + 10);

    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  private updateSelectionLine() {
    this.releaseActiveConnections();
    if (this.selectedOrder.length < 2) {
      return;
    }

    for (let i = 0; i < this.selectedOrder.length - 1; i += 1) {
      const start = this.selectedOrder[i].mesh.position;
      const end = this.selectedOrder[i + 1].mesh.position;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.hypot(dx, dy) || 0.0001;

      const connection = this.acquireConnectionMesh();
      connection.scale.set(length, this.connectionThickness, 1);
      connection.position.set((start.x + end.x) / 2, (start.y + end.y) / 2, -0.04);
      connection.rotation.set(0, 0, Math.atan2(dy, dx));

      this.connectionsGroup.add(connection);
      this.activeConnections.push(connection);
    }
  }

  private resetLetterBag() {
    this.letterBag.clear();
    this.bagTotal = 0;
    Object.entries(LETTER_COUNTS).forEach(([letter, count]) => {
      const upper = letter.toUpperCase();
      const amount = Math.max(0, count ?? 0);
      this.letterBag.set(upper, amount);
      this.bagTotal += amount;
    });
  }

  private rebuildLetterBagFromBoard() {
    this.resetLetterBag();
    this.tiles.forEach((tile) => {
      tile.bagTracked = this.consumeLetterFromBag(tile.letter);
    });
  }

  private consumeLetterFromBag(letter: string): boolean {
    const key = this.normalizeLetterKey(letter);
    const current = this.letterBag.get(key);
    if (typeof current !== "number" || current <= 0) {
      return false;
    }
    this.letterBag.set(key, current - 1);
    this.bagTotal -= 1;
    return true;
  }

  private returnLetterToBag(letter: string) {
    const key = this.normalizeLetterKey(letter);
    if (!key) return;
    const current = this.letterBag.get(key) ?? 0;
    this.letterBag.set(key, current + 1);
    this.bagTotal += 1;
  }

  private drawLetterFromBag(
    filter?: (letter: string) => boolean
  ): { letter: string; fromBag: boolean } {
    const entries = Array.from(this.letterBag.entries()).filter(([letter, count]) => {
      if (count <= 0) return false;
      return filter ? filter(letter) : true;
    });
    const total = filter
      ? entries.reduce((sum, [, count]) => sum + count, 0)
      : this.bagTotal;
    if (total > 0 && entries.length) {
      const target = Math.random() * total;
      let cumulative = 0;
      for (const [letter, count] of entries) {
        cumulative += count;
        if (target < cumulative) {
          this.consumeLetterFromBag(letter);
          return { letter, fromBag: true };
        }
      }
    }
    const pool = filter ? VOWELS : LETTERS;
    return {
      letter: this.randomLetterFromSet(pool),
      fromBag: false
    };
  }

  private normalizeLetterKey(letter: string): string {
    return (letter ?? "").trim().charAt(0).toUpperCase();
  }

  private isVowel(letter: string): boolean {
    return VOWELS.includes(this.normalizeLetterKey(letter));
  }

  private randomLetterFromSet(pool: string): string {
    const source = pool && pool.length ? pool : LETTERS;
    const index = Math.floor(Math.random() * source.length);
    return source.charAt(index);
  }

  private assignLetterFromBag(tile: Tile) {
    const draw = this.drawLetterFromBag();
    const letter = this.normalizeLetter(draw.letter);
    tile.letter = letter;
    tile.bagTracked = draw.fromBag;
  }

  private releaseTileLetter(tile: Tile) {
    if (!tile.bagTracked) return;
    this.returnLetterToBag(tile.letter);
    tile.bagTracked = false;
  }

  private buildTiles() {
    this.resetLetterBag();
    const offsetX = (this.cols - 1) * (this.tileSize / 2) - 0.25;
    const offsetY = (this.rows - 1) * (this.tileSize / 2) - 0.1;

    const total = this.cols * this.rows;
    const tilesData = [];

    for (let y = 0; y < this.rows; y += 1) {
      for (let x = 0; x < this.cols; x += 1) {
        const draw = this.drawLetterFromBag();
        const letter = this.normalizeLetter(draw.letter);
        tilesData.push({ x, y, letter, hasGem: false, bagTracked: draw.fromBag });
      }
    }

    const specialIndex = Math.floor(Math.random() * total);
    const specialType: Multiplier = Math.random() < TRIPLE_CHANCE ? "tripleLetter" : "doubleLetter";
    tilesData.forEach((data, index) => {
      const multiplier = index === specialIndex ? specialType : "none";
      const material = new MeshBasicMaterial({
        color: "#ffffff",
        map: this.getLetterTexture(data.letter, "base", data.hasGem, multiplier),
        transparent: true
      });
      const mesh: TileMesh = new Mesh<PlaneGeometry, MeshBasicMaterial>(this.baseGeometry, material);
      mesh.position.set(data.x * this.tileSize - offsetX, data.y * this.tileSize - offsetY, 0);
      mesh.userData.tileCoordinates = { x: data.x, y: data.y };

      const tile: Tile = {
        id: `${data.x}-${data.y}`,
        mesh,
        letter: data.letter,
        x: data.x,
        y: data.y,
        state: "base",
        hasGem: data.hasGem,
        multiplier,
        wordMultiplier: "none",
        bagTracked: Boolean(data.bagTracked)
      };
      mesh.userData.tile = tile;
      mesh.userData.tileId = tile.id;
      this.tiles.push(tile);
      this.tileMap.set(tile.id, tile);
      this.add(mesh);
      this.updateMultiplierBadge(tile);
      this.updateWordMultiplierBadge(tile);
    });

    this.ensureMinimumVowels();
    this.assignRandomGems();
    this.ensureMultiplier();
    if (this.wordMultiplierControl === "local") {
      this.applyRoundWordMultiplier();
    }
  }

  private normalizeLetter(letter: string): string {
    const upper = (letter ?? "").trim().charAt(0).toUpperCase();
    return LETTERS.includes(upper) ? upper : LETTERS[Math.floor(Math.random() * LETTERS.length)];
  }

  private applyStyle(tile: Tile, state: TileState) {
    tile.state = state;
    tile.mesh.material.map = this.getLetterTexture(tile.letter, state, tile.hasGem, tile.multiplier);
    tile.mesh.material.needsUpdate = true;
    this.updateSwapTint(tile);
  }

  private animateShuffle(
    moves: Array<{ from: Tile; to: Tile }>,
    onComplete: () => void,
    duration = 500
  ) {
    this.shuffleAnimating = true;
    const clones = moves.map((move) => {
      const cloneMaterial = (move.from.mesh.material as MeshBasicMaterial).clone();
      cloneMaterial.transparent = true;
      const mesh = new Mesh<PlaneGeometry, MeshBasicMaterial>(this.baseGeometry, cloneMaterial);
      mesh.position.copy(move.from.mesh.position);
      mesh.renderOrder = move.from.mesh.renderOrder + 1;
      this.add(mesh);
      return { mesh, move };
    });

    const affectedTiles = new Set<Tile>();
    moves.forEach(({ from, to }) => {
      affectedTiles.add(from);
      affectedTiles.add(to);
    });
    const originalOpacity = new Map<Tile, number>();
    affectedTiles.forEach((tile) => {
      const mat = tile.mesh.material as MeshBasicMaterial;
      originalOpacity.set(tile, mat.opacity);
      mat.opacity = 0.25;
    });

    const ease = (t: number) => t * t * (3 - 2 * t);
    const start = performance.now();
    const animate = (time: number) => {
      const progress = Math.min((time - start) / duration, 1);
      const eased = ease(progress);
      clones.forEach(({ mesh, move }) => {
        mesh.position.lerpVectors(move.from.mesh.position, move.to.mesh.position, eased);
      });
      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        clones.forEach(({ mesh }) => {
          mesh.removeFromParent();
        });
        originalOpacity.forEach((value, tile) => {
          const mat = tile.mesh.material as MeshBasicMaterial;
          mat.opacity = value;
          mat.needsUpdate = true;
        });
        this.shuffleAnimating = false;
        onComplete();
      }
    };
    requestAnimationFrame(animate);
  }

  private deriveShuffleMoves(states: TileModel[]): Array<{ from: Tile; to: Tile }> | null {
    if (states.length !== this.tiles.length) return null;
    const available = this.tiles.map((tile) => ({
      tile,
      signature: this.encodeTileState(tile),
      used: false
    }));
    const moves: Array<{ from: Tile; to: Tile }> = [];
    for (const state of states) {
      const target = this.tileMap.get(state.id);
      if (!target) return null;
      const signature = this.encodeState(state);
      const match = available.find((entry) => !entry.used && entry.signature === signature);
      if (!match) return null;
      match.used = true;
      moves.push({ from: match.tile, to: target });
    }
    return moves;
  }

  private encodeTileState(tile: Tile): string {
    return `${tile.letter}|${tile.hasGem ? 1 : 0}|${tile.multiplier}`;
  }

  private encodeState(state: TileModel): string {
    return `${state.letter}|${state.hasGem ? 1 : 0}|${state.multiplier}`;
  }

  private getLetterTexture(letter: string, state: TileState, hasGem: boolean, multiplier: Multiplier): Texture {
    const key = `${letter}-${state}-${hasGem ? "gem" : "plain"}-${multiplier}`;
    const cached = this.textureCache.get(key);
    if (cached) return cached;

    const tex = this.makeLetterTexture(letter, state, hasGem, multiplier);
    this.textureCache.set(key, tex);
    return tex;
  }

  private makeLetterTexture(letter: string, state: TileState, hasGem: boolean, multiplier: Multiplier): Texture {
    const size = 256;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    if (!ctx) throw new Error("Failed to get 2d context");
    const drawRoundedRect = (
      context: CanvasRenderingContext2D,
      x: number,
      y: number,
      width: number,
      height: number,
      radius: number
    ) => {
      const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
      context.beginPath();
      context.moveTo(x + r, y);
      context.lineTo(x + width - r, y);
      context.quadraticCurveTo(x + width, y, x + width, y + r);
      context.lineTo(x + width, y + height - r);
      context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      context.lineTo(x + r, y + height);
      context.quadraticCurveTo(x, y + height, x, y + height - r);
      context.lineTo(x, y + r);
      context.quadraticCurveTo(x, y, x + r, y);
      context.closePath();
    };

    const palette: Record<
      TileState,
      { top: string; bottom: string; border: string; text: string; shadow: string }
    > = {
      base: {
        top: "#fffdf8",
        bottom: "#dce9f2",
        border: "#a9c4d7",
        text: "#10263f",
        shadow: "rgba(7, 28, 50, 0.32)"
      },
      hover: {
        top: "#f9feff",
        bottom: "#cdeeff",
        border: "#70d4ff",
        text: "#10263c",
        shadow: "rgba(31, 141, 196, 0.28)"
      },
      selected: {
        top: "#72e3ff",
        bottom: "#249cd9",
        border: "#bff4ff",
        text: "#ffffff",
        shadow: "rgba(5, 82, 132, 0.55)"
      }
    };

    const colors = palette[state];

    ctx.save();
    ctx.shadowColor = state === "selected" ? "rgba(22, 144, 201, 0.48)" : "rgba(4, 20, 39, 0.24)";
    ctx.shadowBlur = state === "selected" ? 18 : 11;
    ctx.shadowOffsetY = 5;
    const tileGradient = ctx.createLinearGradient(0, 8, 0, size - 8);
    tileGradient.addColorStop(0, colors.top);
    tileGradient.addColorStop(1, colors.bottom);
    ctx.fillStyle = tileGradient;
    drawRoundedRect(ctx, 10, 8, size - 20, size - 22, 20);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = colors.border;
    ctx.lineWidth = state === "selected" ? 7 : 4;
    drawRoundedRect(ctx, 10, 8, size - 20, size - 22, 20);
    ctx.stroke();

    ctx.strokeStyle = state === "selected" ? "rgba(255,255,255,0.46)" : "rgba(255,255,255,0.75)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(30, 28);
    ctx.lineTo(size - 30, 28);
    ctx.stroke();

    ctx.fillStyle = colors.text;
    ctx.font = "bold 134px Play, 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = colors.shadow;
    ctx.shadowBlur = state === "selected" ? 16 : 9;
    ctx.fillText(letter, size / 2, size / 2 + 1);

    // Draw letter value bottom right
    const valueColor =
      state === "selected" ? "rgba(248,253,255,0.96)" : "rgba(28,49,70,0.8)";
    const baseValue = LETTER_VALUES[letter.toLowerCase()] ?? 0;
    const multiplierValue =
      multiplier === "tripleLetter" ? 3 : multiplier === "doubleLetter" ? 2 : 1;
    const value = baseValue * multiplierValue;
    if (value) {
      ctx.fillStyle = valueColor;
      ctx.font = "bold 42px 'Segoe UI', sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.shadowColor = "rgba(0,0,0,0.15)";
      ctx.shadowBlur = 6;
      ctx.fillText(String(value), size - 25, size - 23);
    }

    if (hasGem) {
      ctx.save();
      ctx.translate(size * 0.19, size * 0.79);

      // High-contrast reward badge. Drawing the facets directly keeps the gem
      // legible even when icon fonts have not finished loading.
      ctx.shadowColor = "rgba(64, 8, 76, 0.62)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
      const gemBadgeGradient = ctx.createLinearGradient(0, -31, 0, 31);
      gemBadgeGradient.addColorStop(0, "#ff6aee");
      gemBadgeGradient.addColorStop(1, "#c719c9");
      ctx.fillStyle = gemBadgeGradient;
      ctx.beginPath();
      ctx.arc(0, 0, 32, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 5;
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#8b168f";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-18, -7);
      ctx.lineTo(-11, -17);
      ctx.lineTo(11, -17);
      ctx.lineTo(18, -7);
      ctx.lineTo(0, 17);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.strokeStyle = "rgba(178, 35, 180, 0.75)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-18, -7);
      ctx.lineTo(18, -7);
      ctx.moveTo(-11, -17);
      ctx.lineTo(0, 17);
      ctx.moveTo(11, -17);
      ctx.lineTo(0, 17);
      ctx.stroke();
      ctx.restore();
    }

    const texture = new CanvasTexture(canvas);
    // Canvas colors are authored in sRGB; tagging them prevents Three.js from
    // lifting dark text and saturated gems into a washed-out display range.
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }
}
