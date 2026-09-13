import { MAP, TERRAIN, T } from "@/lib/townMap";
import type { Place } from "@/lib/types";

export type Tile = { x: number; y: number };

/** 0 = blocked, 1 = walkable open, 2 = preferred road/path, 3 = entrance pad */
export type NavCell = 0 | 1 | 2 | 3;

const OPEN_KINDS = new Set(["plaza", "park", "docks", "stage", "notice"]);

export type FindPathOpts = {
  /** Soft cost bump — other agents standing/walking (prefer alternate routes). */
  softAvoid?: Set<string>;
  /** Hard skip — reserved arrival pads / stacked bodies (unless start/goal). */
  hardAvoid?: Set<string>;
};

function tileKey(x: number, y: number) {
  return `${x},${y}`;
}

/**
 * Build a structured town nav grid:
 * - water blocked
 * - building interiors blocked
 * - roads/paths preferred
 * - each place gets multiple meeting pads (not just one door)
 */
export function buildNavGrid(places: Place[]): {
  grid: NavCell[][];
  entrances: Record<string, Tile>;
  pads: Record<string, Tile[]>;
} {
  const grid: NavCell[][] = Array.from({ length: MAP.rows }, (_, y) =>
    Array.from({ length: MAP.cols }, (_, x) => {
      const code = TERRAIN[y]?.[x] ?? T.grass;
      if (code === T.water) return 0;
      if (code === T.road || code === T.path) return 2;
      if (code === T.plaza) return 2;
      return 1;
    }),
  );

  const entrances: Record<string, Tile> = {};
  const pads: Record<string, Tile[]> = {};

  for (const p of places) {
    if (OPEN_KINDS.has(p.kind)) {
      for (let y = p.y; y < p.y + p.h && y < MAP.rows; y++) {
        for (let x = p.x; x < p.x + p.w && x < MAP.cols; x++) {
          if (x >= 0 && y >= 0 && grid[y][x] === 0) grid[y][x] = 1;
        }
      }
      const spots = openVenuePads(p);
      const usable = spots
        .map((t) => snapWalkable(grid, t))
        .filter((t): t is Tile => !!t);
      const unique = dedupeTiles(usable);
      for (const t of unique) grid[t.y][t.x] = 3;
      pads[p.id] = unique.length ? unique : [{ x: p.x, y: p.y }];
      entrances[p.id] = pads[p.id][0]!;
      continue;
    }

    // Solid buildings: block interior
    for (let y = p.y; y < p.y + p.h && y < MAP.rows; y++) {
      for (let x = p.x; x < p.x + p.w && x < MAP.cols; x++) {
        if (x >= 0 && y >= 0) grid[y][x] = 0;
      }
    }

    const doorPads = buildingDoorPads(grid, p);
    for (const t of doorPads) grid[t.y][t.x] = 3;
    pads[p.id] = doorPads.length
      ? doorPads
      : [{ x: p.x + Math.floor(p.w / 2), y: Math.min(MAP.rows - 1, p.y + p.h) }];
    entrances[p.id] = pads[p.id][0]!;
  }

  return { grid, entrances, pads };
}

function openVenuePads(p: Place): Tile[] {
  const cx = p.x + Math.floor(p.w / 2);
  const cy = p.y + Math.floor(p.h / 2);
  const left = p.x + 1;
  const right = p.x + p.w - 2;
  const top = p.y + 1;
  const bottom = p.y + p.h - 2;
  return [
    { x: cx, y: cy },
    { x: left, y: top },
    { x: right, y: top },
    { x: left, y: bottom },
    { x: right, y: bottom },
    { x: cx, y: top },
    { x: cx, y: bottom },
    { x: left, y: cy },
    { x: right, y: cy },
  ].map((t) => ({
    x: Math.min(MAP.cols - 1, Math.max(0, t.x)),
    y: Math.min(MAP.rows - 1, Math.max(0, t.y)),
  }));
}

function buildingDoorPads(grid: NavCell[][], p: Place): Tile[] {
  const midX = p.x + Math.floor(p.w / 2);
  const candidates: Tile[] = [
    { x: midX, y: p.y + p.h }, // south
    { x: midX - 1, y: p.y + p.h },
    { x: midX + 1, y: p.y + p.h },
    { x: midX, y: p.y - 1 }, // north
    { x: p.x - 1, y: p.y + Math.floor(p.h / 2) }, // west
    { x: p.x + p.w, y: p.y + Math.floor(p.h / 2) }, // east
  ];
  const out: Tile[] = [];
  for (const c of candidates) {
    const snapped = snapWalkable(grid, c) || nearestWalkable(grid, c.x, c.y);
    if (!snapped) continue;
    if (out.some((t) => t.x === snapped.x && t.y === snapped.y)) continue;
    out.push(snapped);
  }
  return out;
}

function snapWalkable(grid: NavCell[][], t: Tile): Tile | null {
  if (isWalkable(grid, t.x, t.y)) return t;
  return nearestWalkable(grid, t.x, t.y);
}

function dedupeTiles(tiles: Tile[]): Tile[] {
  const seen = new Set<string>();
  const out: Tile[] = [];
  for (const t of tiles) {
    const k = tileKey(t.x, t.y);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function nearestWalkable(
  grid: NavCell[][],
  x: number,
  y: number,
  hardAvoid?: Set<string>,
): Tile | null {
  for (let r = 0; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (ny < 0 || nx < 0 || ny >= MAP.rows || nx >= MAP.cols) continue;
        if (grid[ny][nx] <= 0) continue;
        if (hardAvoid?.has(tileKey(nx, ny))) continue;
        return { x: nx, y: ny };
      }
    }
  }
  return null;
}

/**
 * Choose an arrival pad for a place. Prefer free pads when someone already
 * stands on the primary door/center.
 */
export function pickArrivalTile(
  pads: Tile[],
  primary: Tile,
  occupied: Set<string>,
  softAvoid: Set<string>,
): Tile {
  const list = pads.length ? pads : [primary];
  for (const t of list) {
    const k = tileKey(t.x, t.y);
    if (!occupied.has(k) && !softAvoid.has(k)) return t;
  }
  for (const t of list) {
    const k = tileKey(t.x, t.y);
    if (!occupied.has(k)) return t;
  }
  // Ring around primary, skipping occupied
  for (let r = 1; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = primary.x + dx;
        const y = primary.y + dy;
        const k = tileKey(x, y);
        if (occupied.has(k)) continue;
        return { x, y };
      }
    }
  }
  return primary;
}

export function isWalkable(grid: NavCell[][], x: number, y: number): boolean {
  if (y < 0 || x < 0 || y >= MAP.rows || x >= MAP.cols) return false;
  return grid[y][x] > 0;
}

/** A* with road preference + optional agent avoidance. */
export function findPath(
  grid: NavCell[][],
  start: Tile,
  goal: Tile,
  opts: FindPathOpts = {},
): Tile[] {
  const softAvoid = opts.softAvoid || new Set<string>();
  const hardAvoid = opts.hardAvoid || new Set<string>();

  if (!isWalkable(grid, goal.x, goal.y) || hardAvoid.has(tileKey(goal.x, goal.y))) {
    const alt = nearestWalkable(grid, goal.x, goal.y, hardAvoid);
    if (!alt) return [];
    goal = alt;
  }
  if (!isWalkable(grid, start.x, start.y)) {
    const alt = nearestWalkable(grid, start.x, start.y);
    if (!alt) return [];
    start = alt;
  }
  if (start.x === goal.x && start.y === goal.y) return [];

  const key = (t: Tile) => tileKey(t.x, t.y);
  const came = new Map<string, string>();
  const cost = new Map<string, number>();
  const open: { t: Tile; f: number }[] = [];
  const startK = key(start);
  const goalK = key(goal);
  cost.set(startK, 0);
  open.push({ t: start, f: heuristic(start, goal) });

  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift()!;
    const ck = key(cur.t);
    if (cur.t.x === goal.x && cur.t.y === goal.y) {
      return reconstruct(came, ck, startK);
    }
    const gScore = cost.get(ck) ?? Infinity;
    for (const [dx, dy] of dirs) {
      const nx = cur.t.x + dx;
      const ny = cur.t.y + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      const nk = tileKey(nx, ny);
      // Hard avoid occupied tiles except start/goal
      if (hardAvoid.has(nk) && nk !== startK && nk !== goalK) continue;
      const cell = grid[ny][nx];
      // Prefer roads (2/3) over grass (1); detour around standing agents
      let step = cell >= 2 ? 1 : 1.35;
      if (softAvoid.has(nk) && nk !== goalK) step += 4.5;
      const tentative = gScore + step;
      if (tentative < (cost.get(nk) ?? Infinity)) {
        came.set(nk, ck);
        cost.set(nk, tentative);
        open.push({
          t: { x: nx, y: ny },
          f: tentative + heuristic({ x: nx, y: ny }, goal),
        });
      }
    }
  }
  return [];
}

function heuristic(a: Tile, b: Tile) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function reconstruct(came: Map<string, string>, endK: string, startK: string): Tile[] {
  const path: Tile[] = [];
  let cur = endK;
  while (cur !== startK) {
    const [x, y] = cur.split(",").map(Number);
    path.push({ x, y });
    const prev = came.get(cur);
    if (!prev) break;
    cur = prev;
  }
  path.reverse();
  return path;
}

/** Snap an agent currently inside a blocked tile out to nearest walkable. */
export function ejectIfInside(grid: NavCell[][], x: number, y: number): Tile {
  if (isWalkable(grid, x, y)) return { x, y };
  return nearestWalkable(grid, x, y) || { x, y };
}
