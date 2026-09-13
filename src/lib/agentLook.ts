/**
 * Procedural agent looks — unique silhouette + creative title, stable per seed.
 * Assigned on spawn; existing agents resolve deterministically from id.
 */

export type AgentLook = {
  seed: number;
  title: string;
  body: "slim" | "sturdy" | "robe" | "jacket";
  head: "round" | "block" | "dome";
  hat: "none" | "cap" | "brim" | "crown" | "antenna" | "hood" | "knot" | "visor";
  gear: "none" | "scarf" | "cape" | "satchel" | "belt" | "goggles";
  held: "none" | "book" | "wrench" | "lantern" | "quill" | "mug" | "tablet";
  accent: string;
  trim: string;
};

const ADJECTIVES = [
  "Brass",
  "Copper",
  "Lantern",
  "Harbor",
  "Quiet",
  "Swift",
  "Moss",
  "Ink",
  "Cedar",
  "Ember",
  "Glass",
  "Tide",
  "Forge",
  "Willow",
  "Cobalt",
  "Amber",
  "Marble",
  "Spark",
  "Drift",
  "Loom",
];

const NOUNS = [
  "Cartographer",
  "Tinker",
  "Scribe",
  "Courier",
  "Keeper",
  "Pilot",
  "Archivist",
  "Smith",
  "Scout",
  "Brewer",
  "Weaver",
  "Navigator",
  "Auditor",
  "Mechanic",
  "Poet",
  "Broker",
  "Gardener",
  "Watch",
  "Scholar",
  "Mender",
];

const ACCENTS = [
  "#f4d35e",
  "#e76f51",
  "#2a9d8f",
  "#e9c46a",
  "#90e0ef",
  "#f1faee",
  "#ffb703",
  "#8ecae6",
  "#adb5bd",
  "#ffd6a5",
  "#bdb2ff",
  "#caffbf",
];

const TRIMS = [
  "#1d3557",
  "#3d2c29",
  "#264653",
  "#2b2d42",
  "#4a4e69",
  "#6d597a",
  "#22223b",
  "#5c4d3c",
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: T[], n: number): T {
  // JS `%` can be negative; that made titles like "Lantern undefined".
  const i = ((n % arr.length) + arr.length) % arr.length;
  return arr[i]!;
}

export function createAgentLook(opts: {
  name: string;
  personality?: string | null;
  color?: string | null;
  seed?: string | number | null;
}): AgentLook {
  const seedStr = `${opts.seed ?? ""}|${opts.name}|${opts.personality ?? ""}|${opts.color ?? ""}`;
  const seed = typeof opts.seed === "number" ? opts.seed >>> 0 : hashStr(seedStr);
  const a = seed;
  const b = (seed >>> 8) ^ seed;
  const c = (seed >>> 16) ^ (seed * 2654435761);
  const d = (seed >>> 24) ^ hashStr(opts.name);

  const body = pick(
    ["slim", "sturdy", "robe", "jacket"] as const,
    a,
  );
  const head = pick(["round", "block", "dome"] as const, b);
  const hat = pick(
    ["none", "cap", "brim", "crown", "antenna", "hood", "knot", "visor"] as const,
    c,
  );
  const gear = pick(
    ["none", "scarf", "cape", "satchel", "belt", "goggles"] as const,
    d,
  );
  const held = pick(
    ["none", "book", "wrench", "lantern", "quill", "mug", "tablet"] as const,
    a ^ b,
  );

  // Nudge toward personality keywords for a bit of soul
  let titleAdj = pick(ADJECTIVES, a);
  let titleNoun = pick(NOUNS, b);
  const p = (opts.personality || "").toLowerCase();
  if (/build|fix|craft|code|engineer/.test(p)) titleNoun = "Tinker";
  if (/write|story|word|poet/.test(p)) titleNoun = "Scribe";
  if (/teach|learn|curious|library/.test(p)) titleNoun = "Scholar";
  if (/cafe|food|warm|friend/.test(p)) titleAdj = "Copper";
  if (/dash|ship|product|nova|metric/.test(p)) titleNoun = "Navigator";

  return {
    seed,
    title: `${titleAdj} ${titleNoun}`,
    body,
    head,
    hat: hat === "none" && gear === "none" ? "cap" : hat, // always some signal
    gear,
    held: held === "none" && hat === "none" ? "book" : held,
    accent: pick(ACCENTS, c),
    trim: pick(TRIMS, d),
  };
}

export function isAgentLook(v: unknown): v is AgentLook {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.title === "string" &&
    typeof o.body === "string" &&
    typeof o.head === "string" &&
    typeof o.hat === "string" &&
    typeof o.accent === "string"
  );
}

function lookTitleBroken(title: unknown): boolean {
  return (
    typeof title !== "string" ||
    !title.trim() ||
    /\bundefined\b|\bnull\b/i.test(title)
  );
}

/** Prefer persisted look; otherwise stable procedural from id/name. */
export function resolveAgentLook(agent: {
  id: string;
  name: string;
  personality?: string | null;
  color?: string | null;
  look?: unknown;
}): AgentLook {
  if (isAgentLook(agent.look) && !lookTitleBroken(agent.look.title)) {
    return agent.look;
  }
  const fresh = createAgentLook({
    name: agent.name,
    personality: agent.personality,
    color: agent.color,
    seed: agent.id,
  });
  // Keep silhouette fields if present; only replace a broken title.
  if (isAgentLook(agent.look) && lookTitleBroken(agent.look.title)) {
    return { ...agent.look, title: fresh.title };
  }
  return fresh;
}

/**
 * Build a readable low-poly figure. Marks meshes with agentId for picking.
 * Returns { root, body } — body is used for walk bob.
 */
export function buildAgentFigure(
  THREE: any,
  look: AgentLook,
  primary: string,
  agentId: string,
): { root: any; body: any } {
  const root = new THREE.Group();
  root.userData.agentId = agentId;

  const mark = (m: any) => {
    m.userData.agentId = agentId;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  const primaryMat = new THREE.MeshStandardMaterial({
    color: primary,
    roughness: 0.45,
    metalness: 0.12,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: look.accent,
    roughness: 0.5,
    metalness: 0.15,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: look.trim,
    roughness: 0.55,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    color: shade(primary, 40),
    roughness: 0.55,
  });

  // Legs / base
  const legs = mark(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.14, 0.35, 8),
      trimMat,
    ),
  );
  legs.position.y = 0.18;
  root.add(legs);

  // Body variants
  let body: any;
  if (look.body === "sturdy") {
    body = mark(
      new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.4), primaryMat),
    );
    body.position.y = 0.65;
  } else if (look.body === "robe") {
    body = mark(
      new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 0.85, 10), primaryMat),
    );
    body.position.y = 0.62;
  } else if (look.body === "jacket") {
    body = mark(
      new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.75, 10), primaryMat),
    );
    body.position.y = 0.62;
    const lapel = mark(
      new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.08), accentMat),
    );
    lapel.position.set(0, 0.85, 0.22);
    root.add(lapel);
  } else {
    body = mark(
      new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.8, 10), primaryMat),
    );
    body.position.y = 0.6;
  }
  root.add(body);

  // Head
  let head: any;
  if (look.head === "block") {
    head = mark(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.36, 0.36), skinMat));
  } else if (look.head === "dome") {
    head = mark(
      new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10, 0, Math.PI * 2, 0, Math.PI / 2), skinMat),
    );
    const chin = mark(
      new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.16, 10), skinMat),
    );
    chin.position.y = 1.05;
    root.add(chin);
    head.position.y = 1.2;
    root.add(head);
    head = chin; // bob reference stays body
  } else {
    head = mark(new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), skinMat));
  }
  if (look.head !== "dome") {
    head.position.y = 1.22;
    root.add(head);
  }

  // Face dots (readable at distance)
  const eyeMat = new THREE.MeshBasicMaterial({ color: "#0b1218" });
  const eyeL = mark(new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), eyeMat));
  const eyeR = mark(new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), eyeMat));
  eyeL.position.set(-0.07, 1.24, 0.18);
  eyeR.position.set(0.07, 1.24, 0.18);
  root.add(eyeL, eyeR);

  // Hats
  const hy = 1.42;
  if (look.hat === "cap") {
    const cap = mark(
      new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.14, 10), accentMat),
    );
    cap.position.y = hy;
    const bill = mark(
      new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 0.18), trimMat),
    );
    bill.position.set(0, hy - 0.02, 0.2);
    root.add(cap, bill);
  } else if (look.hat === "brim") {
    const brim = mark(
      new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.04, 12), trimMat),
    );
    brim.position.y = hy - 0.05;
    const top = mark(
      new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.22, 10), accentMat),
    );
    top.position.y = hy + 0.08;
    root.add(brim, top);
  } else if (look.hat === "crown") {
    const band = mark(
      new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.1, 8), accentMat),
    );
    band.position.y = hy;
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2;
      const spike = mark(
        new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.18, 5), accentMat),
      );
      spike.position.set(Math.cos(ang) * 0.18, hy + 0.14, Math.sin(ang) * 0.18);
      root.add(spike);
    }
    root.add(band);
  } else if (look.hat === "antenna") {
    const rod = mark(
      new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.35, 5), trimMat),
    );
    rod.position.set(0.12, hy + 0.1, 0);
    const tip = mark(
      new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 8), accentMat),
    );
    tip.position.set(0.12, hy + 0.3, 0);
    root.add(rod, tip);
  } else if (look.hat === "hood") {
    const hood = mark(
      new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 10, 0, Math.PI * 2, 0, Math.PI / 1.6), trimMat),
    );
    hood.position.y = 1.28;
    root.add(hood);
  } else if (look.hat === "knot") {
    const bun = mark(
      new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), trimMat),
    );
    bun.position.set(0, hy + 0.05, -0.12);
    root.add(bun);
  } else if (look.hat === "visor") {
    const visor = mark(
      new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.2), accentMat),
    );
    visor.position.set(0, 1.28, 0.16);
    root.add(visor);
  }

  // Gear
  if (look.gear === "scarf") {
    const scarf = mark(
      new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.14), accentMat),
    );
    scarf.position.y = 0.98;
    const tail = mark(
      new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.35, 0.06), accentMat),
    );
    tail.position.set(0.2, 0.78, 0.05);
    root.add(scarf, tail);
  } else if (look.gear === "cape") {
    const cape = mark(
      new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.08), accentMat),
    );
    cape.position.set(0, 0.7, -0.22);
    root.add(cape);
  } else if (look.gear === "satchel") {
    const bag = mark(
      new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.12), trimMat),
    );
    bag.position.set(0.32, 0.55, 0.05);
    root.add(bag);
  } else if (look.gear === "belt") {
    const belt = mark(
      new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.36), accentMat),
    );
    belt.position.y = 0.45;
    root.add(belt);
  } else if (look.gear === "goggles") {
    const g = mark(
      new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 6, 10), accentMat),
    );
    g.position.set(-0.08, 1.26, 0.2);
    g.rotation.y = 0.2;
    const g2 = mark(
      new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.02, 6, 10), accentMat),
    );
    g2.position.set(0.08, 1.26, 0.2);
    g2.rotation.y = -0.2;
    root.add(g, g2);
  }

  // Held prop (right side)
  if (look.held !== "none") {
    const hx = 0.38;
    const hy2 = 0.7;
    if (look.held === "book") {
      const book = mark(
        new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.22, 0.06), accentMat),
      );
      book.position.set(hx, hy2, 0.1);
      root.add(book);
    } else if (look.held === "wrench") {
      const w = mark(
        new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.06), trimMat),
      );
      w.position.set(hx, hy2, 0.05);
      w.rotation.z = 0.4;
      root.add(w);
    } else if (look.held === "lantern") {
      const lamp = mark(
        new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.12), accentMat),
      );
      lamp.position.set(hx, hy2 - 0.05, 0.08);
      const glow = new THREE.PointLight(look.accent, 0.35, 2.5);
      glow.position.set(hx, hy2, 0.08);
      root.add(lamp, glow);
    } else if (look.held === "quill") {
      const q = mark(
        new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, 0.35, 5), trimMat),
      );
      q.position.set(hx, hy2 + 0.05, 0.05);
      q.rotation.z = -0.5;
      root.add(q);
    } else if (look.held === "mug") {
      const mug = mark(
        new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.12, 8), accentMat),
      );
      mug.position.set(hx, hy2, 0.08);
      root.add(mug);
    } else if (look.held === "tablet") {
      const tab = mark(
        new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.26, 0.04), trimMat),
      );
      tab.position.set(hx, hy2, 0.1);
      root.add(tab);
    }
  }

  return { root, body };
}

function shade(hex: string, amt: number): string {
  const n = hex.replace("#", "");
  if (n.length !== 6) return hex;
  const num = parseInt(n, 16);
  let r = (num >> 16) + amt;
  let g = ((num >> 8) & 0xff) + amt;
  let b = (num & 0xff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
