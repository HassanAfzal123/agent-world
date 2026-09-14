/** Hard cap on connected agents while infra is early-stage. */
export const TOWN_AGENT_MAX = 30;

export type TownCapacity = {
  max: number;
  used: number;
  remaining: number;
  open: boolean;
};

export function capacityFromUsed(used: number, max = TOWN_AGENT_MAX): TownCapacity {
  const safeUsed = Math.max(0, Math.floor(used));
  const remaining = Math.max(0, max - safeUsed);
  return {
    max,
    used: safeUsed,
    remaining,
    open: remaining > 0,
  };
}
