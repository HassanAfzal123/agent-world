"use client";

import { useEffect, useRef } from "react";
import * as THREE from "@/lib/vendor/three.module.min.js";
import { OrbitControls } from "@/lib/vendor/OrbitControls.js";
import {
  BUILDING_STYLE,
  MAP,
  TERRAIN,
  TERRAIN_COLOR,
  T,
  WORLD_SCALE,
} from "@/lib/townMap";
import { agentNowLine } from "@/lib/spectator";
import { buildAgentFigure, resolveAgentLook } from "@/lib/agentLook";
import type { Agent, Place } from "@/lib/types";

type Props = {
  places: Place[];
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  hour: number;
  /** Latest speech line per agent for on-map bubbles */
  bubbles?: Record<string, string>;
  /** Moment/camera focus target */
  focusAgentId?: string | null;
  focusNonce?: number;
  /** At scale: only these agents get full nameplates (others = quiet dots) */
  highlightIds?: string[];
};

const S = WORLD_SCALE;
/** Match /api/city/walk cadence so motion looks continuous, not tick-lagged. */
const LERP_MS = 420;

function shade(hex: string, amt: number): string {
  const n = hex.replace("#", "");
  const num = parseInt(n, 16);
  let r = (num >> 16) + amt;
  let g = ((num >> 8) & 0xff) + amt;
  let b = (num & 0xff) + amt;
  r = Math.max(0, Math.min(255, r));
  g = Math.max(0, Math.min(255, g));
  b = Math.max(0, Math.min(255, b));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function worldX(tx: number, ox = 0.5) {
  return (tx + ox) * S - (MAP.cols * S) / 2;
}
function worldZ(ty: number, oy = 0.5) {
  return (ty + oy) * S - (MAP.rows * S) / 2;
}

function makeCanvasTexture(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  w = 256,
  h = 64,
) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function addMesh(g: any, geo: any, mat: any, x: number, y: number, z: number, cast = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (cast) m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

function buildLandmark(place: Place, night: boolean, THREE_NS: typeof THREE) {
  const style = BUILDING_STYLE[place.kind] ?? BUILDING_STYLE.home;
  const w = place.w * S;
  const d = place.h * S;
  const g = new THREE_NS.Group();
  g.position.set(worldX(place.x, place.w / 2), 0, worldZ(place.y, place.h / 2));
  const bodyMat = new THREE_NS.MeshStandardMaterial({
    color: style.body,
    roughness: 0.85,
  });
  const roofMat = new THREE_NS.MeshStandardMaterial({
    color: style.roof,
    roughness: 0.9,
  });
  const trimMat = new THREE_NS.MeshStandardMaterial({ color: style.trim });
  const accentMat = new THREE_NS.MeshStandardMaterial({ color: style.accent });

  const kind = place.kind;

  if (kind === "plaza") {
    addMesh(g, new THREE_NS.CylinderGeometry(1.2, 1.45, 0.18, 28), new THREE_NS.MeshStandardMaterial({ color: night ? "#2a6f9a" : "#48cae4" }), 0, 0.09, 0, false);
    addMesh(g, new THREE_NS.CylinderGeometry(0.12, 0.18, 1.35, 8), new THREE_NS.MeshStandardMaterial({ color: "#e9c46a" }), 0, 0.75, 0);
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2;
      addMesh(g, new THREE_NS.BoxGeometry(0.35, 0.5, 0.35), trimMat, Math.cos(ang) * 2.2, 0.25, Math.sin(ang) * 2.2);
    }
  } else if (kind === "park") {
    for (let i = 0; i < 7; i++) {
      const ox = ((i % 3) - 1) * (w / 3.2);
      const oz = (Math.floor(i / 3) - 0.8) * (d / 2.8);
      addMesh(g, new THREE_NS.CylinderGeometry(0.08, 0.11, 0.75, 6), new THREE_NS.MeshStandardMaterial({ color: "#3a2a1a" }), ox, 0.38, oz);
      addMesh(g, new THREE_NS.SphereGeometry(0.48 + (i % 3) * 0.05, 10, 10), new THREE_NS.MeshStandardMaterial({ color: night ? "#1b4332" : "#40916c" }), ox, 1.05, oz);
    }
    addMesh(g, new THREE_NS.BoxGeometry(1.2, 0.25, 0.45), trimMat, 0, 0.15, d * 0.15);
  } else if (kind === "docks") {
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.95, 0.22, d * 0.45), new THREE_NS.MeshStandardMaterial({ color: "#6b4f2e" }), 0, 0.12, 0);
    for (let i = -2; i <= 2; i++) {
      addMesh(g, new THREE_NS.CylinderGeometry(0.06, 0.08, 1.1, 6), new THREE_NS.MeshStandardMaterial({ color: "#4a3520" }), i * (w / 5), 0.35, d * 0.25);
    }
  } else if (kind === "cafe") {
    const bodyH = 1.7;
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.9, bodyH, d * 0.85), bodyMat, 0, bodyH / 2, 0);
    addMesh(g, new THREE_NS.BoxGeometry(w * 1.05, 0.12, d * 0.35), accentMat, 0, bodyH * 0.72, d * 0.35);
    addMesh(g, new THREE_NS.ConeGeometry(Math.max(w, d) * 0.48, 0.5, 4), roofMat, 0, bodyH + 0.25, 0).rotation.y = Math.PI / 4;
    addMesh(g, new THREE_NS.CylinderGeometry(0.08, 0.1, 0.9, 8), trimMat, w * 0.28, bodyH + 0.35, -d * 0.1);
    addMesh(g, new THREE_NS.BoxGeometry(0.35, 0.7, 0.08), trimMat, 0, 0.4, d * 0.42);
  } else if (kind === "market") {
    for (let i = 0; i < 3; i++) {
      const ox = (i - 1) * (w / 3.2);
      addMesh(g, new THREE_NS.BoxGeometry(w * 0.28, 0.9, d * 0.7), bodyMat, ox, 0.45, 0);
      addMesh(g, new THREE_NS.BoxGeometry(w * 0.32, 0.08, d * 0.78), i % 2 ? accentMat : new THREE_NS.MeshStandardMaterial({ color: "#e76f51" }), ox, 0.95, 0);
    }
  } else if (kind === "library") {
    const bodyH = 2.5;
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.92, bodyH, d * 0.88), bodyMat, 0, bodyH / 2, 0);
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.98, 0.2, d * 0.2), trimMat, 0, bodyH + 0.05, d * 0.35);
    for (let i = -2; i <= 2; i++) {
      addMesh(g, new THREE_NS.CylinderGeometry(0.1, 0.12, bodyH * 0.85, 8), trimMat, i * (w / 5.5), bodyH * 0.42, d * 0.48);
    }
    addMesh(g, new THREE_NS.BoxGeometry(0.5, 0.9, 0.1), accentMat, 0, 0.5, d * 0.5);
  } else if (kind === "workshop") {
    const bodyH = 1.9;
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.9, bodyH, d * 0.9), bodyMat, 0, bodyH / 2, 0);
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.95, 0.35, d * 0.95), roofMat, 0, bodyH + 0.1, 0);
    addMesh(g, new THREE_NS.CylinderGeometry(0.22, 0.28, 1.1, 8), new THREE_NS.MeshStandardMaterial({ color: "#3a3a42" }), w * 0.28, bodyH + 0.7, -d * 0.15);
    addMesh(g, new THREE_NS.BoxGeometry(0.4, 0.75, 0.1), trimMat, 0, 0.4, d * 0.46);
  } else if (kind === "stage") {
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.95, 0.35, d * 0.8), bodyMat, 0, 0.2, 0);
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.2, 1.6, 0.15), trimMat, -w * 0.35, 1.0, -d * 0.2);
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.2, 1.6, 0.15), trimMat, w * 0.35, 1.0, -d * 0.2);
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.85, 0.12, 0.12), accentMat, 0, 1.75, -d * 0.2);
    if (night) {
      const spot = new THREE_NS.PointLight(style.accent, 1.1, 8);
      spot.position.set(0, 2.2, 0.5);
      g.add(spot);
    }
  } else if (kind === "inn") {
    const bodyH = 2.1;
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.9, bodyH, d * 0.88), bodyMat, 0, bodyH / 2, 0);
    addMesh(g, new THREE_NS.ConeGeometry(Math.max(w, d) * 0.52, 0.65, 4), roofMat, 0, bodyH + 0.3, 0).rotation.y = Math.PI / 4;
    addMesh(g, new THREE_NS.BoxGeometry(0.7, 0.35, 0.08), accentMat, 0, bodyH * 0.7, d * 0.46);
    addMesh(g, new THREE_NS.BoxGeometry(0.4, 0.8, 0.1), trimMat, 0, 0.45, d * 0.46);
  } else if (kind === "bank") {
    const bodyH = 2.4;
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.92, bodyH, d * 0.88), bodyMat, 0, bodyH / 2, 0);
    addMesh(g, new THREE_NS.BoxGeometry(w * 1.0, 0.25, d * 0.25), accentMat, 0, bodyH + 0.05, d * 0.3);
    for (let i = -1; i <= 1; i++) {
      addMesh(g, new THREE_NS.BoxGeometry(0.18, bodyH * 0.7, 0.18), trimMat, i * (w / 4), bodyH * 0.35, d * 0.48);
    }
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.5, 0.12, 0.45), trimMat, 0, 0.08, d * 0.55);
  } else if (kind === "clinic") {
    const bodyH = 1.85;
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.9, bodyH, d * 0.88), bodyMat, 0, bodyH / 2, 0);
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.95, 0.2, d * 0.95), roofMat, 0, bodyH + 0.05, 0);
    addMesh(g, new THREE_NS.BoxGeometry(0.55, 0.12, 0.12), accentMat, 0, bodyH * 0.75, d * 0.46);
    addMesh(g, new THREE_NS.BoxGeometry(0.12, 0.55, 0.12), accentMat, 0, bodyH * 0.75, d * 0.46);
  } else if (kind === "notice") {
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.85, 1.2, 0.12), bodyMat, 0, 0.85, 0);
    addMesh(g, new THREE_NS.BoxGeometry(0.08, 1.5, 0.08), trimMat, -w * 0.35, 0.75, 0);
    addMesh(g, new THREE_NS.BoxGeometry(0.08, 1.5, 0.08), trimMat, w * 0.35, 0.75, 0);
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.7, 0.08, 0.04), accentMat, 0, 1.1, 0.08);
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.7, 0.08, 0.04), accentMat, 0, 0.85, 0.08);
  } else {
    const bodyH = kind === "home" ? 1.55 : 1.8;
    addMesh(g, new THREE_NS.BoxGeometry(w * 0.88, bodyH, d * 0.88), bodyMat, 0, bodyH / 2, 0);
    const roof = addMesh(g, new THREE_NS.ConeGeometry(Math.max(w, d) * 0.52, 0.55, 4), roofMat, 0, bodyH + 0.28, 0);
    roof.rotation.y = Math.PI / 4;
    addMesh(g, new THREE_NS.BoxGeometry(0.32, 0.65, 0.08), trimMat, 0, 0.38, d * 0.44);
  }

  if (night && !["park", "docks", "plaza", "notice"].includes(kind)) {
    const light = new THREE_NS.PointLight(style.accent, 0.55, 5);
    light.position.set(0, 1.4, d * 0.4);
    g.add(light);
  }

  // Place nameplate — clearer, slightly larger
  const labelTex = makeCanvasTexture((ctx, cw, ch) => {
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = "rgba(8,16,22,0.88)";
    ctx.strokeStyle = "rgba(233,196,106,0.85)";
    ctx.lineWidth = 3;
    roundRect(ctx, 8, 10, cw - 16, ch - 20, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fff8e7";
    ctx.font = "bold 22px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(place.name.slice(0, 22), cw / 2, ch / 2 + 4);
  }, 340, 68);
  const nameSprite = new THREE_NS.Sprite(
    new THREE_NS.SpriteMaterial({ map: labelTex, transparent: true, depthTest: false }),
  );
  nameSprite.position.y = kind === "plaza" ? 2.4 : kind === "park" ? 2.2 : 3.2;
  nameSprite.scale.set(3.6, 0.72, 1);
  g.add(nameSprite);

  return g;
}

export function CityMap({
  places,
  agents,
  selectedId,
  onSelect,
  hour,
  bubbles = {},
  focusAgentId = null,
  focusNonce = 0,
  highlightIds = [],
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const placesRef = useRef(places);
  placesRef.current = places;
  const hourRef = useRef(hour);
  hourRef.current = hour;
  const bubblesRef = useRef(bubbles);
  bubblesRef.current = bubbles;
  const focusRef = useRef({ id: focusAgentId, nonce: focusNonce });
  focusRef.current = { id: focusAgentId, nonce: focusNonce };
  const highlightRef = useRef(new Set(highlightIds));
  highlightRef.current = new Set(highlightIds);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const night0 = hourRef.current >= 20 || hourRef.current < 6;
    // Horizon haze matches countryside skirt — no empty blue void
    const skyDay = "#8fb59a";
    const skyNight = "#0e1c22";
    scene.background = new THREE.Color(night0 ? skyNight : skyDay);
    scene.fog = new THREE.Fog(night0 ? skyNight : skyDay, 45, 110);

    const worldW = MAP.cols * S;
    const worldD = MAP.rows * S;
    const camDist = Math.max(worldW, worldD) * 0.42;

    const camera = new THREE.PerspectiveCamera(
      40,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.1,
      Math.max(220, camDist * 4),
    );
    camera.position.set(camDist * 0.55, camDist * 0.72, camDist * 0.85);

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    // Match device pixels so CSS stretch doesn't blur the buffer
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, Math.max(1, mount.clientHeight), false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(night0 ? 0x0e1c22 : 0x8fb59a, 1);
    const canvas = renderer.domElement;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    mount.appendChild(canvas);

    let controls: OrbitControls;
    try {
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.maxPolarAngle = Math.PI / 2.55; // keep gaze on ground, not sky void
      controls.minPolarAngle = Math.PI / 5.5;
      controls.minDistance = Math.max(14, camDist * 0.28);
      controls.maxDistance = camDist * 1.15;
      controls.target.set(0, 0.2, 0);
      // Soft pan bounds so you stay over the city + skirt
      controls.update();
    } catch (err) {
      console.error("OrbitControls failed", err);
      controls = {
        update: () => true,
        dispose: () => undefined,
        target: { set: () => undefined, x: 0, y: 0, z: 0, lerp: () => undefined, copy: () => undefined },
      } as unknown as OrbitControls;
    }
    camera.lookAt(0, 0, 0);

    const ambient = new THREE.AmbientLight(0xffffff, night0 ? 0.55 : 0.65);
    scene.add(ambient);
    const hemi = new THREE.HemisphereLight(
      night0 ? 0x6a8cff : 0xd8eeff,
      night0 ? 0x1a3040 : 0x3a5a40,
      night0 ? 0.7 : 0.7,
    );
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(night0 ? 0x8aa4ff : 0xfff2d8, night0 ? 0.55 : 1.15);
    sun.position.set(18, 28, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -Math.max(worldW, worldD) * 0.7;
    sun.shadow.camera.right = Math.max(worldW, worldD) * 0.7;
    sun.shadow.camera.top = Math.max(worldW, worldD) * 0.7;
    sun.shadow.camera.bottom = -Math.max(worldW, worldD) * 0.7;
    scene.add(sun);
    const nightGlow = new THREE.PointLight(0x3ad4ff, night0 ? 0.85 : 0, 50);
    nightGlow.position.set(0, 8, 0);
    scene.add(nightGlow);

    const groundGeo = new THREE.PlaneGeometry(MAP.cols * S, MAP.rows * S, MAP.cols, MAP.rows);
    groundGeo.rotateX(-Math.PI / 2);
    const colors: number[] = [];
    const pos = groundGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const col = Math.min(MAP.cols - 1, Math.max(0, Math.floor(x / S + MAP.cols / 2)));
      const row = Math.min(MAP.rows - 1, Math.max(0, Math.floor(z / S + MAP.rows / 2)));
      const hex = TERRAIN_COLOR[TERRAIN[row]?.[col] ?? 0] || "#1f4d3a";
      const c = new THREE.Color(hex);
      colors.push(c.r, c.g, c.b);
    }
    groundGeo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const ground = new THREE.Mesh(
      groundGeo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.05 }),
    );
    ground.receiveShadow = true;
    scene.add(ground);

    // Countryside skirt + outer haze — fills the frame so orbit never shows empty blue
    const skirtR = Math.max(worldW, worldD) * 1.65;
    const skirt = new THREE.Mesh(
      new THREE.CircleGeometry(skirtR, 72),
      new THREE.MeshStandardMaterial({
        color: night0 ? "#163528" : "#4f9268",
        roughness: 1,
        metalness: 0,
      }),
    );
    skirt.rotation.x = -Math.PI / 2;
    skirt.position.y = -0.04;
    skirt.receiveShadow = true;
    scene.add(skirt);

    const fields = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(worldW, worldD) * 0.55, skirtR * 0.92, 64),
      new THREE.MeshStandardMaterial({
        color: night0 ? "#1a4030" : "#5a9a6e",
        roughness: 1,
      }),
    );
    fields.rotation.x = -Math.PI / 2;
    fields.position.y = -0.03;
    scene.add(fields);

    const sea = new THREE.Mesh(
      new THREE.RingGeometry(skirtR * 0.9, skirtR * 1.25, 64),
      new THREE.MeshStandardMaterial({
        color: night0 ? "#0a2c3c" : "#3a8aaa",
        roughness: 0.88,
        metalness: 0.05,
      }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -0.05;
    scene.add(sea);

    // Soft horizon hills so the edge reads as landscape
    const hillMat = new THREE.MeshStandardMaterial({
      color: night0 ? "#142820" : "#3d7a55",
      roughness: 1,
    });
    for (let i = 0; i < 10; i++) {
      const ang = (i / 10) * Math.PI * 2;
      const r = skirtR * 0.78;
      const hill = new THREE.Mesh(
        new THREE.SphereGeometry(6 + (i % 3) * 2.2, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        hillMat,
      );
      hill.position.set(Math.cos(ang) * r, -0.5, Math.sin(ang) * r);
      hill.scale.set(1.4, 0.55 + (i % 3) * 0.12, 1.4);
      scene.add(hill);
    }

    const townRoot = new THREE.Group();
    scene.add(townRoot);
    const agentRoot = new THREE.Group();
    scene.add(agentRoot);

    type AgentEntry = {
      group: any;
      body: any;
      ring: any;
      label: any;
      bubble: any;
      fromX: number;
      fromZ: number;
      toX: number;
      toZ: number;
      moveStarted: number;
      tileKey: string;
      lookTitle?: string;
    };
    const agentMeshes = new Map<string, AgentEntry>();
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    let camFocusUntil = 0;
    let camFocusPos = new THREE.Vector3(0, 0, 0);
    let lastFocusNonce = -1;

    function makeAgentLabel(
      title: string,
      line: string,
      color: string,
      selected: boolean,
    ) {
      return makeCanvasTexture((ctx, cw, ch) => {
        ctx.clearRect(0, 0, cw, ch);
        ctx.fillStyle = selected ? "rgba(12,28,40,0.95)" : "rgba(6,14,20,0.88)";
        ctx.strokeStyle = selected ? "#ffffff" : color;
        ctx.lineWidth = 3;
        roundRect(ctx, 6, 6, cw - 12, ch - 12, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(22, ch / 2, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.font = "bold 20px Segoe UI, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(title.slice(0, 16), 36, 28);
        ctx.fillStyle = "#c5d6e2";
        ctx.font = "13px Segoe UI, sans-serif";
        ctx.fillText(line.slice(0, 28), 36, 48);
      }, 340, 64);
    }

    function makeBubbleTex(text: string) {
      return makeCanvasTexture((ctx, cw, ch) => {
        ctx.clearRect(0, 0, cw, ch);
        ctx.fillStyle = "rgba(255,255,255,0.94)";
        ctx.strokeStyle = "rgba(20,40,55,0.35)";
        ctx.lineWidth = 2;
        roundRect(ctx, 8, 8, cw - 16, ch - 20, 10);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cw / 2 - 8, ch - 12);
        ctx.lineTo(cw / 2, ch - 2);
        ctx.lineTo(cw / 2 + 8, ch - 12);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#13202a";
        ctx.font = "14px Segoe UI, sans-serif";
        ctx.textAlign = "center";
        wrapText(ctx, text.slice(0, 90), cw / 2, 28, cw - 36, 16);
      }, 320, 96);
    }

    function addScenery(list: Place[], night: boolean) {
      const occupied = new Set<string>();
      for (const p of list) {
        for (let y = p.y; y < p.y + p.h; y++) {
          for (let x = p.x; x < p.x + p.w; x++) occupied.add(`${x},${y}`);
        }
      }

      const curbMat = new THREE.MeshStandardMaterial({
        color: night ? "#3d3a36" : "#b8b0a0",
        roughness: 0.9,
      });
      const stripeMat = new THREE.MeshBasicMaterial({
        color: night ? "#c9a227" : "#f4d35e",
      });
      const lampMat = new THREE.MeshStandardMaterial({ color: "#2c2c34" });
      const glowMat = new THREE.MeshStandardMaterial({
        color: night ? "#ffe08a" : "#fff6d0",
        emissive: night ? "#ffb703" : "#000000",
        emissiveIntensity: night ? 0.7 : 0,
      });
      const trunkMat = new THREE.MeshStandardMaterial({ color: "#4a3424" });
      const leafMat = new THREE.MeshStandardMaterial({
        color: night ? "#1b4332" : "#52b788",
        roughness: 0.85,
      });

      // Raised road beds + center stripes (readable avenues)
      const roadMat = new THREE.MeshStandardMaterial({
        color: night ? "#3a3e46" : "#5c6068",
        roughness: 0.92,
      });
      const pathMat = new THREE.MeshStandardMaterial({
        color: night ? "#6a5f4e" : "#b5a488",
        roughness: 0.9,
      });
      const plazaMat = new THREE.MeshStandardMaterial({
        color: night ? "#6a604e" : "#c4b496",
        roughness: 0.88,
      });

      for (let y = 0; y < MAP.rows; y++) {
        for (let x = 0; x < MAP.cols; x++) {
          const code = TERRAIN[y][x];
          if (code !== T.road && code !== T.path && code !== T.plaza) continue;
          const mat =
            code === T.road ? roadMat : code === T.plaza ? plazaMat : pathMat;
          const slab = new THREE.Mesh(
            new THREE.BoxGeometry(S * 0.98, code === T.road ? 0.08 : 0.05, S * 0.98),
            mat,
          );
          slab.position.set(worldX(x), code === T.road ? 0.04 : 0.025, worldZ(y));
          slab.receiveShadow = true;
          townRoot.add(slab);
        }
      }

      // Road center stripes on main avenues
      for (let x = 0; x < MAP.cols; x += 2) {
        for (const y of [25, 26, 27]) {
          if (TERRAIN[y]?.[x] !== T.road) continue;
          const stripe = new THREE.Mesh(
            new THREE.BoxGeometry(S * 0.35, 0.04, S * 0.12),
            stripeMat,
          );
          stripe.position.set(worldX(x), 0.09, worldZ(y));
          townRoot.add(stripe);
        }
      }
      for (let y = 0; y < MAP.rows; y += 2) {
        for (const x of [35, 36, 37]) {
          if (TERRAIN[y]?.[x] !== T.road) continue;
          const stripe = new THREE.Mesh(
            new THREE.BoxGeometry(S * 0.12, 0.04, S * 0.35),
            stripeMat,
          );
          stripe.position.set(worldX(x), 0.09, worldZ(y));
          townRoot.add(stripe);
        }
      }

      // Street lamps on grass sidewalks (tile centers), trees in park interiors
      const dirs: [number, number][] = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ];
      const terrainAt = (cx: number, cy: number) =>
        cy >= 0 && cy < MAP.rows && cx >= 0 && cx < MAP.cols
          ? TERRAIN[cy][cx]
          : -1;
      const isGrass = (code: number) =>
        code === T.grass || code === T.darkGrass;
      const isHard = (code: number) =>
        code === T.road || code === T.path || code === T.plaza;

      const usedProp = new Set<string>();

      // Lamps: grass tiles that border a road/path — stand on sidewalk center
      for (let y = 1; y < MAP.rows - 1; y++) {
        for (let x = 1; x < MAP.cols - 1; x++) {
          const key = `${x},${y}`;
          if (occupied.has(key) || usedProp.has(key)) continue;
          if (!isGrass(TERRAIN[y][x])) continue;
          let roadDir: [number, number] | null = null;
          for (const d of dirs) {
            if (isHard(terrainAt(x + d[0], y + d[1]))) {
              roadDir = d;
              break;
            }
          }
          if (!roadDir) continue;
          // Regular spacing along sidewalks
          if ((x * 2 + y * 5) % 7 !== 0) continue;
          usedProp.add(key);

          // Slightly toward the street, still clearly on grass
          const ox = 0.5 + roadDir[0] * 0.18;
          const oz = 0.5 + roadDir[1] * 0.18;
          const px = worldX(x, ox);
          const pz = worldZ(y, oz);

          const pole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05, 0.06, 1.5, 6),
            lampMat,
          );
          pole.position.set(px, 0.75, pz);
          pole.castShadow = true;
          townRoot.add(pole);
          const bulb = new THREE.Mesh(
            new THREE.SphereGeometry(0.13, 8, 8),
            glowMat,
          );
          bulb.position.set(px, 1.55, pz);
          townRoot.add(bulb);
          if (night) {
            const light = new THREE.PointLight(0xffd166, 0.55, 5);
            light.position.set(px, 1.55, pz);
            townRoot.add(light);
          }
        }
      }

      // Trees: grass not next to road (parks / yards), exact tile center
      for (let y = 2; y < MAP.rows - 2; y++) {
        for (let x = 2; x < MAP.cols - 2; x++) {
          const key = `${x},${y}`;
          if (occupied.has(key) || usedProp.has(key)) continue;
          if (!isGrass(TERRAIN[y][x])) continue;
          let nextToHard = false;
          for (const d of dirs) {
            if (isHard(terrainAt(x + d[0], y + d[1]))) {
              nextToHard = true;
              break;
            }
          }
          if (nextToHard) continue;
          // Sparse, stable pattern
          if ((x * 13 + y * 7) % 19 !== 0) continue;
          usedProp.add(key);

          const px = worldX(x, 0.5);
          const pz = worldZ(y, 0.5);
          const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(0.08, 0.11, 0.75, 6),
            trunkMat,
          );
          trunk.position.set(px, 0.38, pz);
          trunk.castShadow = true;
          townRoot.add(trunk);
          const canopy = new THREE.Mesh(
            new THREE.SphereGeometry(0.48 + ((x + y) % 3) * 0.05, 8, 8),
            leafMat,
          );
          canopy.position.set(px, 1.05, pz);
          canopy.castShadow = true;
          townRoot.add(canopy);
        }
      }
    }

    function buildTown(list: Place[], night: boolean) {
      while (townRoot.children.length) townRoot.remove(townRoot.children[0]);
      addScenery(list, night);
      for (const place of list) {
        townRoot.add(buildLandmark(place, night, THREE));
        if (!["plaza", "park", "docks", "stage", "notice"].includes(place.kind)) {
          const doorX = place.x + Math.floor(place.w / 2);
          let doorY = place.y + place.h;
          if (doorY >= MAP.rows) doorY = Math.max(0, place.y - 1);
          const pad = new THREE.Mesh(
            new THREE.BoxGeometry(S * 0.9, 0.07, S * 0.6),
            new THREE.MeshStandardMaterial({
              color: night ? "#6b5a3e" : "#d4b483",
              roughness: 0.8,
            }),
          );
          pad.position.set(worldX(doorX), 0.04, worldZ(doorY));
          pad.receiveShadow = true;
          townRoot.add(pad);
        }
      }
    }

    function syncAgents(list: Agent[], selected: string | null, now: number) {
      const seen = new Set<string>();
      const bubbleMap = bubblesRef.current || {};
      const placesNow = placesRef.current;

      // Base world positions, then push anyone too close apart (figures ~1 unit wide)
      const MIN_SEP = 1.35;
      type Pos = { id: string; x: number; z: number };
      const positions: Pos[] = list.map((a) => ({
        id: a.id,
        x: worldX(a.x),
        z: worldZ(a.y),
      }));
      // Stable order so pushes don't flicker
      positions.sort((a, b) => a.id.localeCompare(b.id));
      for (let pass = 0; pass < 6; pass++) {
        for (let i = 0; i < positions.length; i++) {
          for (let j = i + 1; j < positions.length; j++) {
            const dx = positions[j].x - positions[i].x;
            const dz = positions[j].z - positions[i].z;
            const dist = Math.hypot(dx, dz);
            if (dist >= MIN_SEP) continue;
            const push = (MIN_SEP - (dist || 0.001)) * 0.55;
            const nx = dist > 0.001 ? dx / dist : 1;
            const nz = dist > 0.001 ? dz / dist : 0;
            positions[i].x -= nx * push;
            positions[i].z -= nz * push;
            positions[j].x += nx * push;
            positions[j].z += nz * push;
          }
        }
      }
      const slotOf = new Map(
        positions.map((p) => [p.id, { x: p.x, z: p.z }] as const),
      );

      for (const a of list) {
        seen.add(a.id);
        const slot = slotOf.get(a.id)!;
        const tx = slot.x;
        const tz = slot.z;
        const tileKey = `${tx.toFixed(2)},${tz.toFixed(2)}`;
        const nowInfo = agentNowLine(a, placesNow);
        let entry = agentMeshes.get(a.id);
        if (!entry) {
          const group = new THREE.Group();
          group.userData.agentId = a.id;
          const look = resolveAgentLook(a);
          const figure = buildAgentFigure(THREE, look, a.color, a.id);
          const body = figure.body;
          group.add(figure.root);
          const ring = new THREE.Mesh(
            new THREE.RingGeometry(0.5, 0.66, 32),
            new THREE.MeshBasicMaterial({
              color: "#ffffff",
              transparent: true,
              opacity: 0.9,
              side: THREE.DoubleSide,
            }),
          );
          ring.rotation.x = -Math.PI / 2;
          ring.position.y = 0.06;
          ring.visible = false;
          const label = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: makeAgentLabel(
                a.name,
                `${look.title} · ${nowInfo.line}`,
                a.color,
                false,
              ),
              transparent: true,
              depthTest: false,
            }),
          );
          label.position.y = 2.25;
          label.scale.set(3.6, 0.78, 1);
          label.userData.agentId = a.id;
          const bubble = new THREE.Sprite(
            new THREE.SpriteMaterial({
              map: makeBubbleTex("…"),
              transparent: true,
              depthTest: false,
              opacity: 0,
            }),
          );
          bubble.position.y = 2.95;
          bubble.scale.set(3.4, 1.05, 1);
          bubble.visible = false;
          group.add(ring, label, bubble);
          group.position.set(tx, 0, tz);
          agentRoot.add(group);
          entry = {
            group,
            body,
            ring,
            label,
            bubble,
            fromX: tx,
            fromZ: tz,
            toX: tx,
            toZ: tz,
            moveStarted: now,
            tileKey,
            lookTitle: look.title,
          };
          agentMeshes.set(a.id, entry);
        }

        if (entry.tileKey !== tileKey) {
          entry.fromX = entry.group.position.x;
          entry.fromZ = entry.group.position.z;
          entry.toX = tx;
          entry.toZ = tz;
          entry.moveStarted = now;
          entry.tileKey = tileKey;
        } else {
          // Soft-follow separation target even without tile change
          entry.toX = tx;
          entry.toZ = tz;
          if (
            Math.hypot(entry.toX - entry.fromX, entry.toZ - entry.fromZ) > 0.08 &&
            now - entry.moveStarted > LERP_MS
          ) {
            entry.fromX = entry.group.position.x;
            entry.fromZ = entry.group.position.z;
            entry.moveStarted = now;
          }
        }

        const t = Math.min(1, (now - entry.moveStarted) / LERP_MS);
        const ease = t * (2 - t);
        entry.group.position.x = entry.fromX + (entry.toX - entry.fromX) * ease;
        entry.group.position.z = entry.fromZ + (entry.toZ - entry.fromZ) * ease;

        const moving =
          Math.abs(entry.toX - entry.fromX) > 0.01 ||
          Math.abs(entry.toZ - entry.fromZ) > 0.01;
        const walking = a.status === "walking" && (moving || t < 1);
        if (walking) {
          const bob = Math.sin(now * 0.014) * 0.06;
          entry.group.position.y = bob;
          entry.body.rotation.z = Math.sin(now * 0.014) * 0.08;
          entry.body.rotation.x = Math.sin(now * 0.028) * 0.04;
          const dx = entry.toX - entry.fromX;
          const dz = entry.toZ - entry.fromZ;
          if (Math.abs(dx) + Math.abs(dz) > 0.01) {
            entry.group.rotation.y = Math.atan2(dx, dz);
          }
        } else {
          entry.group.position.y = 0;
          entry.body.rotation.z *= 0.85;
          entry.body.rotation.x *= 0.85;
        }

        (entry.body.material as any)?.color?.set?.(a.color);
        entry.ring.visible = a.id === selected;

        const look = resolveAgentLook(a);
        const featured =
          highlightRef.current.size === 0 ||
          highlightRef.current.has(a.id) ||
          a.id === selected;
        entry.label.visible = featured;
        entry.body.scale.setScalar(featured ? 1 : 0.78);

        const labelLine = `${look.title} · ${nowInfo.line}`;
        const labelKey = `${a.name}|${labelLine}|${a.id === selected ? 1 : 0}|${a.color}|${featured ? 1 : 0}`;
        if (featured && entry.group.userData.labelKey !== labelKey) {
          entry.group.userData.labelKey = labelKey;
          const mat = entry.label.material as any;
          const prev = mat.map;
          mat.map = makeAgentLabel(
            a.name,
            labelLine,
            a.color,
            a.id === selected,
          );
          mat.needsUpdate = true;
          prev?.dispose();
        }

        const line = bubbleMap[a.id];
        if (featured && line && entry.group.userData.bubbleText !== line) {
          entry.group.userData.bubbleText = line;
          const mat = entry.bubble.material as any;
          const prev = mat.map;
          mat.map = makeBubbleTex(line);
          mat.opacity = 1;
          mat.needsUpdate = true;
          prev?.dispose();
          entry.bubble.visible = true;
          entry.group.userData.bubbleUntil = now + 6500;
        }
        if (entry.bubble.visible && now > (entry.group.userData.bubbleUntil || 0)) {
          entry.bubble.visible = false;
          (entry.bubble.material as any).opacity = 0;
        }
      }
      for (const [id, entry] of agentMeshes) {
        if (!seen.has(id)) {
          agentRoot.remove(entry.group);
          agentMeshes.delete(id);
        }
      }
    }

    function applyLighting(h: number) {
      const night = h >= 20 || h < 6;
      const sky = night ? "#0e1c22" : "#8fb59a";
      scene.background = new THREE.Color(sky);
      scene.fog = new THREE.Fog(sky, 45, 110);
      renderer.setClearColor(night ? 0x0e1c22 : 0x8fb59a, 1);
      ambient.intensity = night ? 0.55 : 0.65;
      sun.intensity = night ? 0.55 : h < 10 || h > 17 ? 0.85 : 1.15;
      sun.color.set(night ? "#8aa4ff" : "#fff2d8");
      hemi.intensity = night ? 0.7 : 0.65;
      nightGlow.intensity = night ? 0.85 : 0;
      const attr = groundGeo.getAttribute("color") as any;
      for (let i = 0; i < attr.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        const col = Math.min(MAP.cols - 1, Math.max(0, Math.floor(x / S + MAP.cols / 2)));
        const row = Math.min(MAP.rows - 1, Math.max(0, Math.floor(z / S + MAP.rows / 2)));
        let hex = TERRAIN_COLOR[TERRAIN[row]?.[col] ?? 0] || "#1f4d3a";
        if (night) hex = shade(hex, -30);
        const c = new THREE.Color(hex);
        attr.setXYZ(i, c.r, c.g, c.b);
      }
      attr.needsUpdate = true;
    }

    function updateCameraFocus(now: number) {
      const focus = focusRef.current;
      if (focus.nonce !== lastFocusNonce && focus.id) {
        lastFocusNonce = focus.nonce;
        const entry = agentMeshes.get(focus.id);
        if (entry) {
          camFocusPos.set(entry.group.position.x, 0.5, entry.group.position.z);
          camFocusUntil = now + 2200;
        }
      }
      // Soft follow selected when idle focus expired
      const sel = selectedRef.current;
      if (now < camFocusUntil) {
        const tgt = (controls as any).target;
        if (tgt && typeof tgt.lerp === "function") {
          tgt.lerp(camFocusPos, 0.08);
        } else if (tgt && typeof tgt.set === "function") {
          tgt.set(camFocusPos.x, camFocusPos.y, camFocusPos.z);
        }
        camera.position.lerp(
          new THREE.Vector3(camFocusPos.x + 10, 16, camFocusPos.z + 14),
          0.05,
        );
      } else if (sel) {
        const entry = agentMeshes.get(sel);
        if (entry) {
          const soft = new THREE.Vector3(entry.group.position.x, 0.2, entry.group.position.z);
          const tgt = (controls as any).target;
          if (tgt && typeof tgt.lerp === "function") tgt.lerp(soft, 0.03);
        }
      }
    }

    buildTown(placesRef.current, night0);
    syncAgents(agentsRef.current, selectedRef.current, performance.now());
    applyLighting(hourRef.current);

    const onClick = (ev: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(agentRoot.children, true);
      const hit = hits.find(
        (h: { object: { userData: { agentId?: string } } }) => h.object.userData.agentId,
      );
      onSelectRef.current(hit ? String(hit.object.userData.agentId) : null);
    };
    renderer.domElement.addEventListener("click", onClick);

    const onResize = () => {
      const w = Math.max(1, mount.clientWidth);
      const h = Math.max(1, mount.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      // false = don't overwrite CSS size; buffer matches layout box × DPR
      renderer.setSize(w, h, false);
    };
    window.addEventListener("resize", onResize);
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => onResize())
        : null;
    ro?.observe(mount);
    // Layout may settle after sticky/side panel mounts
    requestAnimationFrame(onResize);
    window.setTimeout(onResize, 50);

    let lastHour = hourRef.current;
    let lastPlacesLen = placesRef.current.length;
    const frame = window.setInterval(() => {
      const now = performance.now();
      try {
        if (hourRef.current !== lastHour) {
          lastHour = hourRef.current;
          applyLighting(lastHour);
          buildTown(placesRef.current, lastHour >= 20 || lastHour < 6);
          lastPlacesLen = placesRef.current.length;
        } else if (placesRef.current.length !== lastPlacesLen) {
          lastPlacesLen = placesRef.current.length;
          buildTown(placesRef.current, lastHour >= 20 || lastHour < 6);
        }
        syncAgents(agentsRef.current, selectedRef.current, now);
        updateCameraFocus(now);
        controls.update();
      } catch (err) {
        console.error("city map frame error", err);
      }
      renderer.render(scene, camera);
    }, 33);

    (window as unknown as { __agentWorld?: unknown }).__agentWorld = {
      scene,
      camera,
      renderer,
      children: scene.children.length,
      places: placesRef.current.length,
      agents: agentsRef.current.length,
    };

    return () => {
      window.clearInterval(frame);
      window.removeEventListener("resize", onResize);
      ro?.disconnect();
      renderer.domElement.removeEventListener("click", onClick);
      try {
        controls.dispose();
      } catch {
        /* ignore */
      }
      renderer.dispose();
      if (renderer.domElement.parentElement === mount) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, []);

  return (
    <div className="city-3d" ref={mountRef}>
      <div className="city-3d-hint">
        Drag to orbit · scroll zoom · countryside fills the frame — no empty sky void
      </div>
    </div>
  );
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
) {
  const words = text.split(" ");
  let line = "";
  let yy = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      line = word;
      yy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, yy);
}
