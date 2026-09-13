import type { Agent, Place } from "@/lib/types";

/** Public venues pairs can use for meetups (homes excluded). */
export const MEET_VENUES = [
  "cafe",
  "library",
  "workshop",
  "park",
  "docks",
  "stage",
  "inn",
  "notice",
  "clinic",
  "bank",
  "market",
  "plaza",
] as const;

const BUSY_SOFT_CAP = 2;

function hashSalt(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** How many agents are currently at / walking to each place. */
export function placeTraffic(agents: Agent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of agents) {
    const here = a.place_id;
    if (here) m.set(here, (m.get(here) || 0) + 1);
    const going = a.target_place_id;
    if (going && going !== here) m.set(going, (m.get(going) || 0) + 1);
  }
  return m;
}

/**
 * Pick a meetup venue that isn't already packed.
 * Prefers peer haunt / peer place when quiet; spreads away from busy plaza.
 */
export function pickMeetupPlace(opts: {
  agents: Agent[];
  places: Place[];
  prefer?: string | null;
  avoid?: string | null;
  peerHaunt?: string | null;
  selfHaunt?: string | null;
  salt?: string;
}): string {
  const ids = new Set(opts.places.map((p) => p.id));
  const traffic = placeTraffic(opts.agents);
  const salt = hashSalt(opts.salt || "meet");

  const candidates = MEET_VENUES.filter(
    (id) => ids.has(id) && id !== opts.avoid,
  );

  const pool = candidates.length
    ? candidates
    : opts.places.map((p) => p.id).filter((id) => id !== opts.avoid);

  if (!pool.length) return opts.prefer || "plaza";

  const scored = pool.map((id, i) => {
    const n = traffic.get(id) || 0;
    let s = 40 - n * 12;
    if (id === opts.prefer && n < BUSY_SOFT_CAP) s += 18;
    if (id === opts.peerHaunt && n < BUSY_SOFT_CAP) s += 10;
    if (id === opts.selfHaunt && n < BUSY_SOFT_CAP) s += 6;
    // Plaza/market are fine when empty, bad when a pair is already there
    if ((id === "plaza" || id === "market") && n >= BUSY_SOFT_CAP) s -= 28;
    if ((id === "plaza" || id === "market") && n === 0) s += 4;
    // Stable jitter so different pairs don't all pick the same "quiet" spot
    s += ((salt + i * 17) % 7) - 3;
    return { id, s, n };
  });

  scored.sort((a, b) => b.s - a.s || a.id.localeCompare(b.id));

  // If preferred place is still quiet, keep it (go to the peer)
  if (opts.prefer && ids.has(opts.prefer)) {
    const prefN = traffic.get(opts.prefer) || 0;
    if (prefN < BUSY_SOFT_CAP) return opts.prefer;
  }

  return scored[0]!.id;
}

/** True when a place already has a social pair (or more) present/inbound. */
export function placeIsBusy(agents: Agent[], placeId: string | null | undefined): boolean {
  if (!placeId) return false;
  return (placeTraffic(agents).get(placeId) || 0) >= BUSY_SOFT_CAP;
}
