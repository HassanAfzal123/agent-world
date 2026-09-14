/** Static town layout — wide districted city with countryside margin. */
export const MAP = {
  cols: 72,
  rows: 54,
  tile: 20,
} as const;

/** Tile codes */
export const T = {
  grass: 0,
  darkGrass: 1,
  road: 2,
  plaza: 3,
  water: 4,
  sand: 5,
  path: 6,
} as const;

/**
 * Districted town with room to breathe:
 * - North: homes + clinic/cafe
 * - Center: plaza / stage / notice
 * - West: library + park
 * - East: market / workshop
 * - South: inn, bank, docks + river
 * - Edges: countryside grass (no hard drop into void)
 */
export function buildTerrain(): number[][] {
  const g: number[][] = Array.from({ length: MAP.rows }, () =>
    Array.from({ length: MAP.cols }, () => T.grass as number),
  );

  const fill = (x0: number, y0: number, w: number, h: number, code: number) => {
    for (let y = y0; y < y0 + h && y < MAP.rows; y++) {
      for (let x = x0; x < x0 + w && x < MAP.cols; x++) {
        if (x >= 0 && y >= 0) g[y][x] = code;
      }
    }
  };

  for (let y = 0; y < MAP.rows; y++) {
    for (let x = 0; x < MAP.cols; x++) {
      if ((x * 3 + y * 5) % 11 === 0) g[y][x] = T.darkGrass;
    }
  }

  // Primary avenues (3 tiles)
  fill(0, 25, MAP.cols, 3, T.road);
  fill(35, 0, 3, MAP.rows, T.road);

  // Secondary streets
  fill(0, 12, MAP.cols, 2, T.path);
  fill(0, 38, MAP.cols, 2, T.path);
  fill(16, 0, 2, MAP.rows, T.path);
  fill(52, 0, 2, MAP.rows, T.path);

  // Block connectors
  fill(10, 18, 12, 1, T.path);
  fill(40, 18, 14, 1, T.path);
  fill(10, 32, 24, 1, T.path);
  fill(40, 32, 16, 1, T.path);

  // Central plaza paving
  fill(30, 21, 12, 8, T.plaza);

  // River + docks beach (SE)
  fill(54, 40, 18, 14, T.water);
  fill(48, 42, 8, 6, T.sand);
  fill(50, 39, 12, 2, T.sand);

  // Soft countryside fringe as darker grass bands (reads as fields)
  for (let y = 0; y < MAP.rows; y++) {
    for (let x = 0; x < MAP.cols; x++) {
      const edge =
        x < 3 || y < 3 || x >= MAP.cols - 3 || y >= MAP.rows - 3;
      if (edge && g[y][x] === T.grass) g[y][x] = T.darkGrass;
    }
  }

  fill(10, 16, 8, 1, T.path);
  fill(48, 16, 10, 1, T.path);

  return g;
}

export const TERRAIN = buildTerrain();

export const TERRAIN_COLOR: Record<number, string> = {
  [T.grass]: "#3f845c",
  [T.darkGrass]: "#2f6348",
  [T.road]: "#555962",
  [T.plaza]: "#9a8d72",
  [T.path]: "#a89878",
  [T.water]: "#1a6f94",
  [T.sand]: "#d2b48c",
};

export type BuildingStyle = {
  body: string;
  roof: string;
  trim: string;
  accent: string;
};

export const BUILDING_STYLE: Record<string, BuildingStyle> = {
  cafe: { body: "#6b3f2e", roof: "#3d2118", trim: "#c4a484", accent: "#e8b86d" },
  market: { body: "#3f5c34", roof: "#243820", trim: "#c9d4a5", accent: "#f0d27a" },
  library: { body: "#3a4560", roof: "#1e2740", trim: "#b7c4e0", accent: "#8ecae6" },
  clinic: { body: "#dfe7ef", roof: "#7a8b9a", trim: "#2a9d8f", accent: "#e76f51" },
  workshop: { body: "#5a5348", roof: "#2f2a24", trim: "#e9c46a", accent: "#f4a261" },
  inn: { body: "#7a4e3a", roof: "#3b241c", trim: "#f1d6b0", accent: "#e76f51" },
  bank: { body: "#4a5568", roof: "#1f2937", trim: "#f6e27a", accent: "#f6e27a" },
  notice: { body: "#5c4030", roof: "#3a281c", trim: "#f4d35e", accent: "#f4d35e" },
  park: { body: "#2f6b4f", roof: "#1d4333", trim: "#a7d7c5", accent: "#90be6d" },
  docks: { body: "#4a5d6b", roof: "#243039", trim: "#9fb4c4", accent: "#48cae4" },
  stage: { body: "#5a3d6b", roof: "#2d1d3a", trim: "#e0b1f0", accent: "#ff85a2" },
  plaza: { body: "#5c5346", roof: "#3a342c", trim: "#e7d7b1", accent: "#e9c46a" },
  home: { body: "#6d5a4c", roof: "#3d2f28", trim: "#f0e2d0", accent: "#90e0ef" },
  square: { body: "#4a5560", roof: "#2a323a", trim: "#cbd5e1", accent: "#94a3b8" },
  road: { body: "#3a3a42", roof: "#2a2a30", trim: "#888", accent: "#aaa" },
};

export const ACTIONS = [
  "set_plan",
  "walk",
  "talk",
  "share_experience",
  "teach",
  "ask_question",
  "practice_skill",
  "debate",
  "demo",
  "reflect",
  "ask_favor",
  "invite_to_group",
  "compose_proposal",
  "file_proposal",
  "accept",
  "refuse",
  "join",
  "give",
  "leave_note",
  "inspect",
  "fix",
  "work",
  "start_shift",
  "eat",
  "shop",
  "post_notice",
  "watch_show",
  "rest",
  "sleep",
  "idle",
] as const;

export type ActionName = (typeof ACTIONS)[number];

export const WORLD_SCALE = 1.15;

/** Canonical place footprints for the enlarged map (kept in sync with DB). */
export const PLACE_LAYOUT: Record<
  string,
  { x: number; y: number; w: number; h: number }
> = {
  home_a: { x: 10, y: 8, w: 4, h: 3 },
  home_b: { x: 56, y: 8, w: 4, h: 3 },
  clinic: { x: 22, y: 9, w: 5, h: 4 },
  cafe: { x: 12, y: 11, w: 5, h: 4 },
  market: { x: 51, y: 10, w: 7, h: 5 },
  library: { x: 12, y: 19, w: 5, h: 4 },
  notice: { x: 34, y: 20, w: 3, h: 2 },
  plaza: { x: 30, y: 21, w: 12, h: 8 },
  stage: { x: 43, y: 21, w: 5, h: 4 },
  workshop: { x: 54, y: 21, w: 5, h: 4 },
  park: { x: 11, y: 30, w: 7, h: 6 },
  bank: { x: 24, y: 31, w: 5, h: 3 },
  inn: { x: 39, y: 31, w: 6, h: 4 },
  docks: { x: 52, y: 34, w: 7, h: 5 },
  home_c: { x: 10, y: 42, w: 4, h: 3 },
  home_d: { x: 56, y: 42, w: 4, h: 3 },
};
