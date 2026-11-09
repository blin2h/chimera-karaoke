/**
 * The karaoke stage in 3D, drawn like the head: glowing lines on black (the same beams kit,
 * max-blended, fog-dimmed with depth), no solids, no lights. A platform outline with a faint
 * grid, the lead singer at the front, and the whole band: each performer is one musician, or a
 * section of several (strings, a choir, brass), drawn as line figures playing line drawings of
 * their instruments, moving with their notes — sticks strike the drum each note hits, hands follow
 * the pitches along a keyboard, a strumming hand strokes on each chord, bows travel and turn at
 * each note, horns come up to the mouth while they play, singers open their mouths. Everyone
 * breathes and sways a little. A performer brightens while its channel sounds; the singer while
 * the voice sings. Drag to orbit, wheel to zoom, double-click to go back to the audience's view.
 * Fills its parent, which needs a definite height.
 *
 * Figures are rebuilt every frame from joint positions (immediate mode, into one reused buffer);
 * the instruments that don't move are placed once.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FAMILY_LABEL, type Family } from "../../audio/gm.ts";
import { V } from "../colors.ts";
import { Beams } from "../render/beams3d.ts";
import { Anatomy3D } from "../render/anatomy3d.ts";
import { footprint, LISTENER, ROW, ROW_DEPTH, SCALE, SINGER, SPREAD, type Performer } from "../stage.ts";
import type { BandNote } from "../karaoke.ts";
import { useModel } from "../useModel.ts";
import { useStore } from "../store.ts";
import { sameBody, type BodyMix } from "../body.ts";
import { VoiceModel } from "../analysis.ts";
import { engine } from "../../audio/AudioEngine.ts";

const FAMILY_COLOR: Record<Family, string> = {
  drums: V.red, bass: V.blue, piano: V.white, chromatic: V.white, organ: V.white, guitar: V.amber, ethnic: V.amber,
  strings: V.pink, ensemble: V.pink, brass: V.green, reed: V.green, pipe: V.green,
  lead: V.blue, pad: V.blue, fx: V.blue, sfx: V.blue, percussive: V.red,
};
const HOME = new THREE.Vector3(LISTENER.x, LISTENER.y + 9, LISTENER.z - 1.5);
const TARGET = new THREE.Vector3(0, 0.5, -2.8);
/** the singer's height against an adult man's (the body's mix of male, female and child) */
const sizeOf = (b: BodyMix) => (1 - 0.07 * b.female) * (1 - 0.32 * b.child);

// ---- static line drawings, in drawing units (metres before SCALE), facing +z (the audience)
// standing on y = 0. A figure facing +z has its right hand on −x.
type Shape = number[][]; // polylines of xyz triples
const ring = (r: number, at: (x: number, y: number) => [number, number, number], n = 20): number[] => {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(...at(r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)));
  return out;
};
/** a ring lying flat at height y */
const flat = (cx: number, y: number, cz: number, r: number, n?: number) => ring(r, (a, b) => [cx + a, y, cz + b], n);
/** a ring standing up, facing the audience */
const upright = (cx: number, cy: number, cz: number, r: number, n?: number) => ring(r, (a, b) => [cx + a, cy + b, cz], n);
const seg = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => [x0, y0, z0, x1, y1, z1];
/** a drum: two flat rings joined at four points */
const drum = (cx: number, y: number, cz: number, r: number, h: number): Shape => [
  flat(cx, y, cz, r), flat(cx, y + h, cz, r),
  ...[0, 1, 2, 3].map((k) => seg(cx + r * Math.cos(k * 1.571 + 0.785), y, cz + r * Math.sin(k * 1.571 + 0.785), cx + r * Math.cos(k * 1.571 + 0.785), y + h, cz + r * Math.sin(k * 1.571 + 0.785))),
];
/** a box's twelve edges */
const box = (cx: number, cy: number, cz: number, w: number, h: number, d: number): Shape => {
  const [x0, x1, y0, y1, z0, z1] = [cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2, cz - d / 2, cz + d / 2];
  return [
    [x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, x0, y0, z0],
    [x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, x0, y1, z0],
    seg(x0, y0, z0, x0, y1, z0), seg(x1, y0, z0, x1, y1, z0), seg(x1, y0, z1, x1, y1, z1), seg(x0, y0, z1, x0, y1, z1),
  ];
};
/** a stand: a pole and three feet */
const stand = (cx: number, cz: number, h: number): Shape => [seg(cx, 0, cz, cx, h, cz), ...[0, 2.09, 4.19].map((a) => seg(cx, 0.12, cz, cx + 0.25 * Math.cos(a), 0, cz + 0.25 * Math.sin(a)))];
/** a stool under a seated player at depth z */
const stool = (z: number): Shape => [[-0.17, 0.45, z - 0.14, 0.17, 0.45, z - 0.14, 0.17, 0.45, z + 0.14, -0.17, 0.45, z + 0.14, -0.17, 0.45, z - 0.14], seg(-0.14, 0.45, z, -0.17, 0, z), seg(0.14, 0.45, z, 0.17, 0, z)];
/** a waisted body outline, upright, turned by `tilt` about its centre at height h; neck of length `neck` */
function stringed(scale: number, neck: number, tilt: number, h: number, dz = 0): Shape {
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const r = ([x, y]: [number, number]): [number, number, number] => [x * c - y * s, h + x * s + y * c, dz];
  const body: number[] = [];
  for (let i = 0; i <= 32; i++) {
    const a = (2 * Math.PI * i) / 32;
    const y = 0.32 * scale * Math.sin(a);
    const w = (0.2 + 0.07 * Math.cos(2 * a) - 0.05 * Math.sin(a)) * scale;
    body.push(...r([w * Math.cos(a), y]));
  }
  return [body, [...r([-0.03, 0.3 * scale]), ...r([-0.03, 0.3 * scale + neck]), ...r([0.03, 0.3 * scale + neck]), ...r([0.03, 0.3 * scale])], [...r([0, -0.25 * scale]), ...r([0, 0.3 * scale + neck])]];
}

/** what a musician plays, which decides its pose and its movements */
type Kind = "drums" | "keys" | "synth" | "guitar" | "bass" | "violin" | "cello" | "horn" | "voice" | "perc" | "singer";

function kindOf(p: Performer): Kind {
  if (p.voice) return "voice";
  switch (p.family) {
    case "drums":
      return "drums";
    case "piano":
    case "organ":
    case "chromatic":
      return "keys";
    case "guitar":
    case "ethnic":
      return "guitar";
    case "bass":
      return "bass";
    case "strings":
      return p.program === 42 || p.program === 43 || p.program === 46 ? "cello" : p.program === 47 ? "perc" : "violin";
    case "ensemble":
      return "violin";
    case "brass":
    case "reed":
    case "pipe":
      return "horn";
    case "percussive":
      return "perc";
    default:
      return "synth";
  }
}

/** seated or standing; where the hips are (z, behind the instrument) and the forward lean */
const POSE: Record<Kind, { seated: boolean; z: number; lean: number }> = {
  drums: { seated: true, z: -0.7, lean: 0.12 },
  keys: { seated: true, z: -0.42, lean: 0.2 },
  synth: { seated: false, z: -0.4, lean: 0.12 },
  guitar: { seated: false, z: -0.08, lean: 0.04 },
  bass: { seated: false, z: -0.08, lean: 0.04 },
  violin: { seated: true, z: -0.1, lean: 0.08 },
  cello: { seated: true, z: -0.18, lean: 0.1 },
  horn: { seated: false, z: 0, lean: 0 },
  voice: { seated: false, z: 0, lean: 0 },
  perc: { seated: false, z: -0.4, lean: 0.12 },
  singer: { seated: false, z: 0, lean: 0 },
};

// the drum kit, and where each drum's head is
const SNARE = [-0.45, 0.8, 0.1];
const TOM_HI = [0.4, 0.86, 0.05];
const TOM_LO = [0.75, 0.75, 0.3];
const HAT = [-0.8, 1.12, -0.05];
const RIDE = [0.95, 1.2, -0.2];
const KIT: Shape = [
  upright(0, 0.38, 0.1, 0.36), upright(0, 0.38, -0.25, 0.36), seg(-0.36, 0.38, 0.1, -0.36, 0.38, -0.25), seg(0.36, 0.38, 0.1, 0.36, 0.38, -0.25),
  ...drum(-0.45, 0.62, 0.1, 0.18, 0.18), ...drum(0.4, 0.66, 0.05, 0.2, 0.2), ...drum(0.75, 0.45, 0.3, 0.24, 0.3),
  flat(-0.8, 1.12, -0.05, 0.3), flat(0.95, 1.2, -0.2, 0.32), ...stand(-0.8, -0.05, 1.12), ...stand(0.95, -0.2, 1.2),
];
// the violin under the chin: from its tail at the jaw to its scroll, and where the bow crosses
const VIOLIN_TAIL = [0.1, 1.1, 0.0];
const VIOLIN_SCROLL = [0.33, 1.17, 0.42];
const BOW = 0.62;
/** the bow's direction, frog to tip: across the strings, toward the player's right */
const VIOLIN_BOW = [0.84, 0.1, -0.53];
const CELLO_BOW = [0.99, 0.08, 0.05];

/** the instrument's lines that don't move, for a performer's family */
function instrument(kind: Kind, family: Family): Shape {
  const seat = POSE[kind].seated ? stool(POSE[kind].z) : [];
  switch (kind) {
    case "drums":
      return [...KIT, ...seat];
    case "keys": {
      const keys = Array.from({ length: 14 }, (_, k) => seg(-0.6 + k * 0.0923, 0.91, 0.22, -0.6 + k * 0.0923, 0.91, 0.06));
      return [...box(0, 0.85, 0, 1.3, 0.12, 0.45), ...keys, seg(-0.55, 0, 0, -0.55, 0.79, 0), seg(0.55, 0, 0, 0.55, 0.79, 0), ...(family === "organ" ? box(0, 1.15, -0.18, 1.3, 0.5, 0.08) : []), ...seat];
    }
    case "synth":
      return [...box(0, 0.95, 0, 1.0, 0.08, 0.35), seg(-0.4, 0, 0.12, 0.4, 0.9, -0.12), seg(0.4, 0, 0.12, -0.4, 0.9, -0.12), ...Array.from({ length: 10 }, (_, k) => seg(-0.45 + k * 0.1, 1.0, 0.16, -0.45 + k * 0.1, 1.0, 0.03))];
    case "guitar":
      return stringed(1, 0.55, -1.1, 0.98, 0.14);
    case "bass":
      return stringed(1.05, 0.8, -1.15, 0.96, 0.14);
    case "violin": {
      const [t, s] = [VIOLIN_TAIL, VIOLIN_SCROLL];
      return [[t[0], t[1], t[2], 0.2, 1.17, 0.15, s[0], s[1], s[2], 0.25, 1.07, 0.14, t[0], t[1], t[2]], [t[0], t[1] + 0.02, t[2], s[0], s[1], s[2]], ...seat];
    }
    case "cello":
      return [...stringed(1.6, 0.55, 0, 0.62, 0.22), seg(0, 0, 0.22, 0, 0.12, 0.22), ...seat];
    case "perc":
      return [...drum(-0.22, 0.55, 0, 0.17, 0.25), ...drum(0.2, 0.55, 0, 0.2, 0.25), ...stand(0, 0, 0.55)];
    case "singer":
      // the mic stand
      return [seg(0, 0, 0.42, 0, 1.38, 0.42), seg(0, 1.38, 0.42, 0, 1.45, 0.3), upright(0, 1.47, 0.28, 0.04, 10), ...stand(0, 0.42, 0.12)];
    default:
      return []; // horns are drawn moving; singers hold nothing
  }
}

/** a wind instrument held to the mouth, relative to the mouth, raised: its line, two hand points,
 *  and the bell (centre, axis, radius) */
interface Horn {
  line: number[];
  hands: number[];
  bell: number[] | null;
}
const HORNS: Record<"trumpet" | "sax" | "clarinet" | "flute", Horn> = {
  trumpet: { line: [0, 0, 0.02, 0, -0.03, 0.3, 0, 0, 0.52], hands: [0.02, -0.06, 0.2, -0.01, -0.06, 0.36], bell: [0, 0, 0.55, 0, 0, 1, 0.11] },
  sax: { line: [0, 0, 0.03, 0, -0.12, 0.12, 0.02, -0.55, 0.16, 0.05, -0.62, 0.27, 0.06, -0.47, 0.33], hands: [0.02, -0.28, 0.15, -0.01, -0.48, 0.17], bell: [0.06, -0.45, 0.33, 0, 0.6, 0.8, 0.08] },
  clarinet: { line: [0, 0, 0.02, 0, -0.5, 0.3], hands: [0.01, -0.2, 0.13, -0.01, -0.38, 0.23], bell: [0, -0.52, 0.31, 0, -0.86, 0.5, 0.045] },
  flute: { line: [0.06, 0, 0.05, -0.58, 0.02, 0.12], hands: [0.0, -0.02, 0.08, -0.42, 0, 0.12], bell: null },
};
const hornOf = (p: Performer): Horn => (p.family === "brass" ? HORNS.trumpet : p.family === "reed" ? (p.program <= 67 ? HORNS.sax : HORNS.clarinet) : p.program === 72 || p.program === 73 || p.program === 75 ? HORNS.flute : HORNS.clarinet);

/** a label (instrument, family) on a canvas texture */
function label(name: string, sub: string, color: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.textAlign = "center";
  g.fillStyle = color;
  g.font = "600 44px system-ui, sans-serif";
  g.fillText(name, 256, 58, 500);
  g.fillStyle = V.blue;
  g.font = "32px system-ui, sans-serif";
  g.fillText(sub.toUpperCase(), 256, 106, 500);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(2.2, 0.55, 1);
  return s;
}

// ---- what a channel is doing now
interface Limb {
  /** time of its last hit, and where the stick tip is going / is */
  t: number;
  tx: number;
  ty: number;
  tz: number;
  x: number;
  y: number;
  z: number;
}

/** a channel's notes and, as the clock runs, what it plays: the sounding pitches, its last note-on
 *  (a chord counts once), when it last sounded, and for the kit each hand's last hit and the kick */
interface Lane {
  notes: BandNote[];
  drums: boolean;
  /** first note not yet ended (moves forward with the clock, back on a rewind) */
  i: number;
  /** notes whose note-on has been handled */
  seen: number;
  last: number;
  count: number;
  lo: number;
  hi: number;
  onT: number;
  onPitch: number;
  onVel: number;
  onLen: number;
  /** note-ons so far: a bow or a strum turns at each */
  flips: number;
  offT: number;
  /** right hand, left hand */
  limbs: [Limb, Limb];
  kickT: number;
}

const limb = (x: number, y: number, z: number): Limb => ({ t: -1e9, tx: x, ty: y, tz: z, x, y, z });
const newLane = (drums: boolean): Lane => ({
  notes: [], drums, i: 0, seen: 0, last: -1e9, count: 0, lo: 0, hi: 0, onT: -1e9, onPitch: 60, onVel: 0, onLen: 0.5, flips: 0, offT: -1e9,
  limbs: [limb(-0.35, 1.0, -0.1), limb(0.15, 1.0, -0.1)], kickT: -1e9,
});

function noteOn(l: Lane, n: BandNote): void {
  if (!l.drums) {
    if (n.start - l.onT > 0.03) {
      l.flips++;
      l.onT = n.start;
      l.onPitch = n.midi;
      l.onVel = n.velocity;
      l.onLen = n.end - n.start;
    } else l.onVel = Math.max(l.onVel, n.velocity);
    return;
  }
  const k = n.midi;
  if (k === 35 || k === 36) {
    l.kickT = n.start;
    return;
  }
  const [r, lh] = l.limbs;
  const freer = r.t < lh.t ? 0 : 1;
  let target = SNARE;
  let hand = 1; // the snare is the left hand's
  if (k === 42 || k === 44 || k === 46) [target, hand] = [HAT, 0];
  else if (k === 51 || k === 53 || k === 59) [target, hand] = [RIDE, 0];
  else if (k === 49 || k === 52 || k === 55 || k === 57) [target, hand] = [HAT, freer];
  else if (k >= 41 && k <= 50) [target, hand] = [k >= 47 ? TOM_HI : TOM_LO, freer];
  else if (!(k >= 37 && k <= 40)) hand = freer;
  // a hand that struck within 60 ms hands the hit to the other
  if (n.start - l.limbs[hand].t < 0.06 && n.start - l.limbs[1 - hand].t >= 0.06) hand = 1 - hand;
  const m = l.limbs[hand];
  m.t = n.start;
  m.tx = target[0];
  m.ty = target[1];
  m.tz = target[2];
}

/** Bring a lane to song time t: handle the note-ons passed, find what sounds. O(sounding). */
function update(l: Lane, t: number): void {
  const n = l.notes;
  if (t < l.last - 0.05) {
    // the clock went back (a new song or a seek): start over from there
    l.seen = 0;
    l.i = 0;
    l.onT = l.offT = l.kickT = l.limbs[0].t = l.limbs[1].t = -1e9;
  }
  l.last = t;
  // a jump forward passes many note-ons at once: only the recent ones move anyone
  while (l.seen < n.length && n[l.seen].start <= t) {
    const x = n[l.seen++];
    if (t - x.start < 0.5) noteOn(l, x);
  }
  while (l.i < n.length && n[l.i].end <= t) l.i++;
  l.count = 0;
  l.lo = 999;
  l.hi = -1;
  for (let k = l.i; k < n.length && n[k].start <= t; k++) {
    const x = n[k];
    if (x.end <= t) continue;
    l.count++;
    if (x.midi < l.lo) l.lo = x.midi;
    if (x.midi > l.hi) l.hi = x.midi;
  }
  if (l.count) l.offT = t;
}

/** how lit a lane is at song time t: 1 while a note sounds, a quick flash for each drum hit */
function level(l: Lane, t: number): number {
  if (!l.drums) return l.count ? 1 : 0;
  return Math.max(Math.exp(-(t - l.limbs[0].t) / 0.12), Math.exp(-(t - l.limbs[1].t) / 0.12), Math.exp(-(t - l.kickT) / 0.12));
}

// ---- drawing, immediate mode
const OPTS = { alpha: 1, hot: false };

/** Points into one reused buffer, through a musician's transform: drawing units → stage metres. */
class Pen {
  readonly a = new Float32Array(3 * 64);
  n = 0;
  private ox = 0;
  private oz = 0;
  private c = 1;
  private s = 0;
  /** the section player's offset, in the performer's drawing units */
  dx = 0;
  dz = 0;
  /** the figure's height against an adult's (the lead singer's body) */
  size = 1;
  /** face the audience from (x, z) */
  at(x: number, z: number): void {
    const a = Math.atan2(LISTENER.x - x, LISTENER.z - z);
    this.ox = x;
    this.oz = z;
    this.c = Math.cos(a);
    this.s = Math.sin(a);
  }
  p(x: number, y: number, z: number): this {
    if (this.n >= 64) return this;
    const i = 3 * this.n++;
    const k = SCALE * this.size;
    x += this.dx;
    z += this.dz;
    this.a[i] = this.ox + k * (x * this.c + z * this.s);
    this.a[i + 1] = k * y;
    this.a[i + 2] = this.oz + k * (-x * this.s + z * this.c);
    return this;
  }
  v(q: ArrayLike<number>): this {
    return this.p(q[0], q[1], q[2]);
  }
  /** an upright circle (a head) */
  circle(cx: number, cy: number, cz: number, r: number, n = 12): this {
    for (let i = 0; i <= n; i++) this.p(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n), cz);
    return this;
  }
  stroke(b: Beams, color: string, width: number, alpha: number, hot = false): void {
    if (this.n > 1) {
      OPTS.alpha = alpha;
      OPTS.hot = hot;
      b.line(this.a, this.n, color, width, OPTS);
    }
    this.n = 0;
  }
  /** a static polyline already in stage metres (placed once) */
  static place(shape: Shape, x: number, z: number, dx: number, dz: number): Float32Array[] {
    const a = Math.atan2(LISTENER.x - x, LISTENER.z - z);
    const c = Math.cos(a), s = Math.sin(a);
    return shape.map((l) => {
      const out = new Float32Array(l.length);
      for (let i = 0; i < l.length; i += 3) {
        const lx = l[i] + dx, lz = l[i + 2] + dz;
        out[i] = x + SCALE * (lx * c + lz * s);
        out[i + 1] = SCALE * l[i + 1];
        out[i + 2] = z + SCALE * (-lx * s + lz * c);
      }
      return out;
    });
  }
}

// joint scratch (drawing units), reused every frame
const v3 = () => [0, 0, 0];
const [HIP, NECK, HEAD, SHL, SHR, HL, HR, EL, ER, KL, KR, FL, FR, Q, TIP] = Array.from({ length: 15 }, v3);
const set = (o: number[], x: number, y: number, z: number) => {
  o[0] = x;
  o[1] = y;
  o[2] = z;
  return o;
};
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (o: number[], to: number[], k: number) => set(o, lerp(o[0], to[0], k), lerp(o[1], to[1], k), lerp(o[2], to[2], k));
const UPPER = 0.3;
const FORE = 0.31;

/** Two-bone arm: the elbow between shoulder s and hand h (moved within reach), bent toward (bx, by, bz). */
function arm(s: number[], h: number[], e: number[], bx: number, by: number, bz: number): void {
  let dx = h[0] - s[0], dy = h[1] - s[1], dz = h[2] - s[2];
  let d = Math.hypot(dx, dy, dz) || 1e-6;
  const reach = UPPER + FORE - 0.005;
  if (d > reach) {
    const k = reach / d;
    set(h, s[0] + dx * k, s[1] + dy * k, s[2] + dz * k);
    dx *= k;
    dy *= k;
    dz *= k;
    d = reach;
  }
  const [ux, uy, uz] = [dx / d, dy / d, dz / d];
  const along = (UPPER * UPPER - FORE * FORE + d * d) / (2 * d);
  const up = Math.sqrt(Math.max(0, UPPER * UPPER - along * along));
  // the bend direction, square to the arm
  const dot = bx * ux + by * uy + bz * uz;
  let wx = bx - dot * ux, wy = by - dot * uy, wz = bz - dot * uz;
  const wl = Math.hypot(wx, wy, wz) || 1;
  wx /= wl;
  wy /= wl;
  wz /= wl;
  set(e, s[0] + ux * along + wx * up, s[1] + uy * along + wy * up, s[2] + uz * along + wz * up);
}

/** a musician on the stage */
interface Player {
  kind: Kind;
  horn: Horn | null;
  dx: number;
  dz: number;
  phase: number;
  /** the instrument's still lines, placed */
  still: Float32Array[];
  /** smoothed hands: left xyz, right xyz */
  hand: number[];
  bow: number;
  bowDir: number;
  flips: number;
  raise: number;
  mouth: number;
}

/** keyboard x for a pitch: low notes under the left hand (+x), 36–96 across `w` */
const keyX = (p: number, w: number) => w / 2 - Math.min(1, Math.max(0, (p - 36) / 60)) * w;

/**
 * One musician this frame: pose from the lane (null: the song isn't playing, rest), drawn with
 * `pen` at the performer's place. `act` is the lead singer's voice (0–1).
 */
function drawMusician(b: Beams, pen: Pen, pl: Player, lane: Lane | undefined, t: number | null, w: number, dt: number, color: string, glow: number, act: number): void {
  const pose = POSE[pl.kind];
  const live = t !== null && lane !== undefined;
  const since = (x: number) => (live ? t - x : 1e9);
  const strong = live ? Math.exp(-since(lane.onT) / 0.18) * lane.onVel : 0;
  const sways = pl.kind === "horn" || pl.kind === "voice" || pl.kind === "guitar" || pl.kind === "bass" || pl.kind === "singer";
  const sway = 0.025 * Math.sin(0.9 * w + pl.phase) + (pl.kind === "singer" ? 0.03 * act * Math.sin(1.6 * w) : 0);
  const lean = pose.lean + 0.02 * Math.sin(1.3 * w + 1.7 * pl.phase) + (sways ? 0.05 * strong : 0);
  const hy = pose.seated ? 0.5 : 0.92;
  const hz = pose.z;
  set(HIP, 0, hy, hz);
  set(NECK, sway, hy + 0.55 * Math.cos(lean), hz + 0.55 * Math.sin(lean));
  const nod = 0.035 * strong + (pl.kind === "singer" ? 0.02 * act * Math.sin(3.1 * w) : 0);
  set(HEAD, NECK[0] + 0.3 * sway, NECK[1] + 0.17 - nod, NECK[2] + 0.02 + nod);
  set(SHL, NECK[0] + 0.17, NECK[1] - 0.04, NECK[2]);
  set(SHR, NECK[0] - 0.17, NECK[1] - 0.04, NECK[2]);
  if (pose.seated) {
    const kx = pl.kind === "cello" ? 0.21 : 0.11;
    set(KL, kx, hy + 0.02, hz + 0.4);
    set(KR, -kx, hy + 0.02, hz + 0.4);
    set(FL, kx + 0.02, 0, hz + 0.45);
    set(FR, -kx - 0.02, 0, hz + 0.45);
  } else {
    set(KL, 0.09, 0.47, hz + 0.03);
    set(KR, -0.09, 0.47, hz + 0.03);
    set(FL, 0.12, 0, hz + 0.05);
    set(FR, -0.12, 0, hz + 0.05);
  }
  // the hands' targets (left HL, right HR), the smoothing, and what else moves
  let smooth = 0.25;
  let sticks = false;
  let bowDir: number[] | null = null;
  let mouth = -1;
  const h = pl.hand;
  switch (pl.kind) {
    case "drums": {
      smooth = 1;
      sticks = true;
      for (let k = 0; k < 2; k++) {
        const m = lane!.limbs[k];
        // between hits the stick hovers over its drum; idle a second, it comes back to rest
        const idle = since(m.t) > 1.2;
        const [rx, ry, rz] = k === 0 ? [-0.35, 1.0, -0.1] : [0.15, 1.0, -0.1];
        m.x = lerp(m.x, idle ? rx : m.tx, 0.45);
        m.z = lerp(m.z, idle ? rz : m.tz, 0.45);
        const lift = idle ? 0.1 : 0.22 * (1 - Math.exp(-Math.max(0, since(m.t)) / 0.05));
        m.y = (idle ? ry : m.ty) + lift;
        const s = k === 0 ? SHR : SHL;
        set(k === 0 ? HR : HL, m.x * 0.7 + s[0] * 0.3, m.y + 0.06, m.z - 0.34);
      }
      // the right foot on the kick pedal
      set(FR, -0.12, 0.04 + 0.08 * (1 - Math.exp(-Math.max(0, since(lane!.kickT)) / 0.05)), -0.3);
      set(KR, -0.12, hy + 0.04, hz + 0.38);
      break;
    }
    case "keys":
    case "synth": {
      smooth = 0.3;
      const wide = pl.kind === "keys" ? 1.1 : 0.85;
      const ky = pl.kind === "keys" ? 0.95 : 1.04;
      const kz = pl.kind === "keys" ? 0.12 : 0.08;
      const count = live ? lane!.count : 0;
      let l = keyX(48, wide), r = keyX(72, wide);
      if (count > 1) [l, r] = [keyX(lane!.lo, wide), keyX(lane!.hi, wide)];
      else if (count === 1) {
        if (lane!.lo < 60) l = keyX(lane!.lo, wide);
        else r = keyX(lane!.lo, wide);
      }
      if (l < r + 0.12) l = r + 0.12; // the left hand stays left of the right
      const dip = live ? 0.04 * Math.exp(-since(lane!.onT) / 0.08) : 0;
      const leftPlayed = live && lane!.onPitch < 60;
      set(HL, l, ky + 0.05 - (leftPlayed ? dip : 0) + (count ? 0 : 0.04), kz);
      set(HR, r, ky + 0.05 - (leftPlayed ? 0 : dip) + (count ? 0 : 0.04), kz);
      break;
    }
    case "guitar":
    case "bass": {
      smooth = 0.45;
      const bass = pl.kind === "bass";
      const [tilt, cy, len] = bass ? [-1.15, 0.96, 0.8] : [-1.1, 0.98, 0.55];
      const scale = bass ? 1.05 : 1;
      const nx = -Math.sin(tilt), ny = Math.cos(tilt);
      const norm = Math.min(1, Math.max(0, (lane ? lane.onPitch : 50) - (bass ? 28 : 40)) / (bass ? 27 : 36));
      const f = live && since(lane!.offT) < 1.5 ? 0.85 - 0.7 * norm : 0.5;
      const along = 0.3 * scale + f * len;
      set(HL, nx * along, cy + ny * along, 0.17);
      // the picking hand strokes down, then up, at each note-on
      const stroke = live && since(lane!.offT) < 0.6 ? (lane!.flips % 2 ? 1 : -1) * (bass ? 0.035 : 0.075) : 0;
      set(HR, -0.05, cy + 0.03 + stroke, 0.21);
      break;
    }
    case "violin":
    case "cello": {
      const cello = pl.kind === "cello";
      // the bow travels while notes sound, turning at each new note, faster for short ones
      if (live) {
        if (lane!.flips !== pl.flips) {
          pl.flips = lane!.flips;
          pl.bowDir = -pl.bowDir;
        }
        if (lane!.count) pl.bow += pl.bowDir * (0.8 / Math.min(2, Math.max(0.25, lane!.onLen))) * dt;
        if (pl.bow > 0.9 || pl.bow < 0.1) {
          pl.bow = Math.min(0.9, Math.max(0.1, pl.bow));
          pl.bowDir = -pl.bowDir;
        }
      }
      const f = pl.bow + 0.03 * Math.sin(pl.phase);
      bowDir = cello ? CELLO_BOW : VIOLIN_BOW;
      const norm = Math.min(1, Math.max(0, (lane ? lane.onPitch : 60) - (cello ? 36 : 55)) / 36);
      if (cello) {
        set(HL, 0.03, 1.55 - 0.4 * norm, 0.22);
        set(HR, -f * 0.7 * CELLO_BOW[0], 0.75 - f * 0.7 * CELLO_BOW[1], 0.28 - f * 0.7 * CELLO_BOW[2]);
      } else {
        const k = 0.6 + 0.3 * (1 - norm);
        set(HL, lerp(VIOLIN_TAIL[0], VIOLIN_SCROLL[0], k), lerp(VIOLIN_TAIL[1], VIOLIN_SCROLL[1], k) - 0.03, lerp(VIOLIN_TAIL[2], VIOLIN_SCROLL[2], k));
        const cx = lerp(VIOLIN_TAIL[0], VIOLIN_SCROLL[0], 0.3), cy = lerp(VIOLIN_TAIL[1], VIOLIN_SCROLL[1], 0.3) + 0.03, cz = lerp(VIOLIN_TAIL[2], VIOLIN_SCROLL[2], 0.3);
        set(HR, cx - f * BOW * VIOLIN_BOW[0], cy - f * BOW * VIOLIN_BOW[1], cz - f * BOW * VIOLIN_BOW[2]);
      }
      smooth = 0.6;
      break;
    }
    case "horn": {
      // up to the mouth while it plays, down after a second's rest
      pl.raise = lerp(pl.raise, live && since(lane!.offT) < 1 ? 1 : 0, 0.08);
      break;
    }
    case "voice": {
      set(HL, 0.1, 1.05, 0.18);
      set(HR, -0.1, 1.05, 0.18);
      pl.mouth = lerp(pl.mouth, live && lane!.count ? 0.03 + 0.015 * lane!.onVel : 0.004, 0.3);
      mouth = pl.mouth;
      break;
    }
    case "perc": {
      smooth = 1;
      const struck = live ? lane!.flips % 2 : 0;
      for (let k = 0; k < 2; k++) {
        const top = k === 0 ? [-0.22, 0.8, 0] : [0.2, 0.8, 0];
        const hitting = live && k === struck;
        const lift = hitting ? 0.15 * (1 - Math.exp(-since(lane!.onT) / 0.05)) : 0.15;
        set(k === 0 ? HR : HL, top[0], top[1] + 0.03 + lift, top[2] - 0.05);
      }
      break;
    }
    case "singer": {
      set(HR, -0.03, 1.38, 0.38);
      set(HL, 0.3 + 0.08 * act * Math.sin(1.7 * w), 1.05 + 0.18 * act + 0.05 * act * Math.sin(2.3 * w), 0.18 + 0.1 * act);
      pl.mouth = lerp(pl.mouth, 0.004 + 0.035 * act, 0.3);
      mouth = pl.mouth;
      break;
    }
  }

  // the horn and its hands, from the mouth
  if (pl.horn) {
    const r = pl.raise;
    const a = (1 - r) * 1.2; // lowered: pointing down, held at the chest
    const ca = Math.cos(a), sa = Math.sin(a);
    const ox = lerp(0, HEAD[0], r), oy = lerp(hy + 0.25, HEAD[1] - 0.07, r), oz = lerp(hz + 0.2, HEAD[2] + 0.12, r);
    const tr = (src: ArrayLike<number>, i: number, out: number[]) => set(out, ox + src[i], oy + src[i + 1] * ca - src[i + 2] * sa, oz + src[i + 1] * sa + src[i + 2] * ca);
    const hn = pl.horn;
    for (let i = 0; i < hn.line.length; i += 3) pen.v(tr(hn.line, i, Q));
    pen.stroke(b, color, 0.85 + 0.9 * glow, 0.45 + 0.55 * glow, glow > 0.5);
    tr(hn.hands, 0, HL);
    tr(hn.hands, 3, HR);
    if (hn.bell) {
      const c = tr(hn.bell, 0, TIP);
      const [axx, axy, axz] = [hn.bell[3], hn.bell[4] * ca - hn.bell[5] * sa, hn.bell[4] * sa + hn.bell[5] * ca];
      // two directions square to the bell's axis
      let e1x = axz, e1z = -axx;
      const e1l = Math.hypot(e1x, e1z);
      if (e1l < 1e-3) [e1x, e1z] = [1, 0];
      else [e1x, e1z] = [e1x / e1l, e1z / e1l];
      const [e2x, e2y, e2z] = [axy * e1z, axz * e1x - axx * e1z, -axy * e1x];
      const rad = hn.bell[6];
      for (let i = 0; i <= 12; i++) {
        const u = (2 * Math.PI * i) / 12, cu = Math.cos(u), su = Math.sin(u);
        pen.p(c[0] + rad * (cu * e1x + su * e2x), c[1] + rad * su * e2y, c[2] + rad * (cu * e1z + su * e2z));
      }
      pen.stroke(b, color, 0.85 + 0.9 * glow, 0.45 + 0.55 * glow, glow > 0.5);
    }
  } else if (smooth < 1) {
    // ease the hands toward their targets
    set(Q, h[0], h[1], h[2]);
    ease(Q, HL, smooth);
    h[0] = Q[0];
    h[1] = Q[1];
    h[2] = Q[2];
    set(Q, h[3], h[4], h[5]);
    ease(Q, HR, smooth);
    h[3] = Q[0];
    h[4] = Q[1];
    h[5] = Q[2];
    set(HL, h[0], h[1], h[2]);
    set(HR, h[3], h[4], h[5]);
  }

  arm(SHL, HL, EL, 0.6, -1, -0.3);
  arm(SHR, HR, ER, -0.6, -1, -0.3);

  // what the hands hold
  if (sticks) {
    for (const [hand, sh] of [[HL, SHL], [HR, SHR]] as const) {
      const dx = hand[0] - sh[0], dz = hand[2] - sh[2], dl = Math.hypot(dx, dz) || 1;
      pen.v(hand).p(hand[0] + (0.34 * dx) / dl, hand[1] - 0.06, hand[2] + (0.34 * dz) / dl);
      pen.stroke(b, V.white, 0.85, 0.6 + 0.4 * glow);
    }
  }
  if (bowDir) {
    const len = pl.kind === "cello" ? 0.7 : BOW;
    pen.v(HR).p(HR[0] + bowDir[0] * len, HR[1] + bowDir[1] * len, HR[2] + bowDir[2] * len);
    pen.stroke(b, color, 0.85, 0.5 + 0.5 * glow);
  }

  if (pl.kind === "singer") return drawBody(b, pen, hy, hz, glow);
  // the figure: head, torso, arms across the shoulders, legs across the hips
  const fa = 0.4 + 0.45 * glow;
  const fw = 0.85 + 0.5 * glow;
  pen.circle(HEAD[0], HEAD[1], HEAD[2], 0.13).stroke(b, color, fw, fa);
  pen.v(HIP).v(NECK).p(HEAD[0], HEAD[1] - 0.13, HEAD[2]).stroke(b, color, fw, fa);
  pen.v(HL).v(EL).v(SHL).v(SHR).v(ER).v(HR).stroke(b, color, fw, fa);
  pen.v(FL).v(KL).p(0.09, hy, hz).p(-0.09, hy, hz).v(KR).v(FR).stroke(b, color, fw, fa);
  if (mouth >= 0) {
    const [mx, my, mz] = [HEAD[0], HEAD[1] - 0.06, HEAD[2] + 0.11];
    pen.p(mx - 0.035, my, mz).p(mx, my - mouth, mz).p(mx + 0.035, my, mz).p(mx, my + mouth * 0.3, mz).p(mx - 0.035, my, mz).stroke(b, color, fw, Math.min(1, fa + 0.2));
  }
}

const R0 = v3(), R1 = v3();
/**
 * A limb or the trunk drawn as the head is: rings across it and lines along it, from a to c,
 * `r(k)` its half-width k of the way along (`deep` × that front to back).
 */
function tube(b: Beams, pen: Pen, a: number[], c: number[], r: (k: number) => number, rings: number, deep: number, glow: number): void {
  const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2];
  const L = Math.hypot(dx, dy, dz) || 1e-6;
  const [ux, uy, uz] = [dx / L, dy / L, dz / L];
  // across: square to the axis and to front–back (the body's side), else to up
  let [e1x, e1y, e1z] = [uy, -ux, 0];
  if (Math.hypot(e1x, e1y) < 0.3) [e1x, e1y, e1z] = [0, uz, -uy];
  const l1 = Math.hypot(e1x, e1y, e1z);
  [e1x, e1y, e1z] = [e1x / l1, e1y / l1, e1z / l1];
  const [e2x, e2y, e2z] = [uy * e1z - uz * e1y, uz * e1x - ux * e1z, ux * e1y - uy * e1x];
  const at = (k: number, ang: number, o: number[]) => {
    const rr = r(k), cu = Math.cos(ang) * rr, su = Math.sin(ang) * rr * deep;
    return set(o, a[0] + dx * k + cu * e1x + su * e2x, a[1] + dy * k + cu * e1y + su * e2y, a[2] + dz * k + cu * e1z + su * e2z);
  };
  const ringAlpha = 0.35 + 0.4 * glow, lineAlpha = 0.55 + 0.45 * glow;
  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j <= 14; j++) pen.v(at(i / rings, (2 * Math.PI * j) / 14, R0));
    pen.stroke(b, V.blueDim, 0.9, ringAlpha);
  }
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i <= rings; i++) pen.v(at(i / rings, (Math.PI / 2) * j, R1));
    pen.stroke(b, V.blueMid, 1.0, lineAlpha, glow > 0.6);
  }
}

const [WAIST, CHEST, HIPL, HIPR] = Array.from({ length: 4 }, v3);
/** the lead singer's body in the head's drawing style (the head itself is the voice's, mounted
 *  on the neck); joints from drawMusician, hips at height hy, depth hz */
function drawBody(b: Beams, pen: Pen, hy: number, hz: number, glow: number): void {
  set(WAIST, lerp(HIP[0], NECK[0], 0.35), lerp(HIP[1], NECK[1], 0.35), lerp(HIP[2], NECK[2], 0.35));
  set(CHEST, lerp(HIP[0], NECK[0], 0.7), lerp(HIP[1], NECK[1], 0.7), lerp(HIP[2], NECK[2], 0.7));
  set(HIPL, 0.09, hy, hz);
  set(HIPR, -0.09, hy, hz);
  tube(b, pen, HIP, WAIST, (k) => 0.17 - 0.035 * k, 2, 0.62, glow);
  tube(b, pen, WAIST, CHEST, (k) => 0.135 + 0.04 * k, 2, 0.65, glow);
  tube(b, pen, CHEST, NECK, (k) => 0.175 + 0.025 * Math.sin(Math.PI * k * 0.8) - 0.1 * k * k, 2, 0.6, glow);
  for (const [s, e, h] of [[SHL, EL, HL], [SHR, ER, HR]]) {
    tube(b, pen, s, e, (k) => 0.05 - 0.01 * k, 3, 1, glow);
    tube(b, pen, e, h, (k) => 0.04 - 0.012 * k, 3, 1, glow);
  }
  for (const [hp, kn, ft] of [[HIPL, KL, FL], [HIPR, KR, FR]]) {
    tube(b, pen, hp, kn, (k) => 0.075 - 0.025 * k, 3, 1, glow);
    tube(b, pen, kn, ft, (k) => 0.05 - 0.015 * k, 3, 1, glow);
  }
}

export function StageView(props: { performers: Performer[]; notes: BandNote[]; time: () => number | null; singerActive: () => boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef(props.time);
  timeRef.current = props.time;
  const singerRef = useRef(props.singerActive);
  singerRef.current = props.singerActive;
  const [failed, setFailed] = useState(false);
  const modelRef = useModel();
  const { performers, notes } = props;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let gl: THREE.WebGLRenderer;
    try {
      gl = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    gl.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    gl.setClearColor(0x000000, 1);
    wrap.appendChild(gl.domElement);
    gl.domElement.style.display = "block";

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x000000, 10, 30);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 60);
    camera.position.copy(HOME);
    const controls = new OrbitControls(camera, gl.domElement);
    controls.target.copy(TARGET);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.06; // not under the floor
    controls.minDistance = 3;
    controls.maxDistance = 32;
    controls.update();
    // the view from the audience: back along HOME's direction until the performers (sections
    // spread out) and their labels fit the frame, whatever the screen's shape
    const xs: number[] = [SINGER.x - 1, SINGER.x + 1];
    const zs: number[] = [SINGER.z];
    for (const p of performers) {
      const f = footprint(p);
      xs.push(p.x - f.half, p.x + f.half);
      zs.push(p.z - f.back);
    }
    const [x0, x1, z0] = [Math.min(...xs) - 0.6, Math.max(...xs) + 0.6, Math.min(...zs) - 0.4];
    const corners = [x0, x1].flatMap((x) => [0.4, z0].flatMap((z) => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 3.6 - z * 0.22, z)]));
    const dir = HOME.clone().sub(TARGET).normalize();
    const fit = (target: THREE.Vector3) => {
      for (let d = 4; d <= 34; d += 0.25) {
        camera.position.copy(target).addScaledVector(dir, d);
        camera.lookAt(target);
        camera.updateMatrixWorld();
        if (corners.every((c) => {
          const v = c.clone().project(camera);
          return Math.abs(v.x) <= 0.97 && Math.abs(v.y) <= 0.97;
        }))
          return;
      }
    };
    const reset = () => {
      // fit, then centre what is seen (the labels make the stage top-heavy) and fit again closer
      const target = TARGET.clone();
      fit(target);
      const ys = corners.map((c) => c.clone().project(camera).y);
      const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
      const half = camera.position.distanceTo(target) * Math.tan((camera.fov * Math.PI) / 360);
      target.addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion), mid * half);
      fit(target);
      controls.target.copy(target);
      controls.update();
    };
    gl.domElement.addEventListener("dblclick", reset);

    const beams = new Beams();
    scene.add(beams.group);
    // the platform: its outline (front edge at z = 0) and a faint metre grid
    // as wide and deep as the band needs (a big orchestra spreads out), at least 14 m by 8
    const W = Math.ceil(Math.max(7, -x0 + 0.3, x1 + 0.3)), D = Math.ceil(Math.max(8, -z0 + 0.3));
    const floor: Float32Array[] = [new Float32Array([-W, 0, 0, W, 0, 0, W, 0, -D, -W, 0, -D, -W, 0, 0]), new Float32Array([-W, -0.4, 0, W, -0.4, 0]), new Float32Array([-W, 0, 0, -W, -0.4, 0]), new Float32Array([W, 0, 0, W, -0.4, 0])];
    const grid: Float32Array[] = [];
    for (let x = 1 - W; x < W; x++) grid.push(new Float32Array([x, 0, 0, x, 0, -D]));
    for (let z = -1; z > -D; z--) grid.push(new Float32Array([-W, 0, z, W, 0, z]));

    const newPlayer = (kind: Kind, horn: Horn | null, dx: number, dz: number, still: Float32Array[], phase: number): Player => ({
      kind, horn, dx, dz, phase, still, hand: [0.2, 1, 0, -0.2, 1, 0], bow: 0.5, bowDir: 1, flips: 0, raise: 0, mouth: 0,
    });
    const singer = newPlayer("singer", null, 0, 0, [], 0);
    let singerSize = 0;
    // the voice's own head, on the singer's neck: stage → the singer's place (facing the
    // audience, at its size) → the neck → body cm in the head's frame (+x forward), about its pivot
    const head = new Anatomy3D();
    head.centred = true;
    const root = new THREE.Group();
    const neck = new THREE.Group();
    const shift = new THREE.Group();
    root.position.set(SINGER.x, 0, SINGER.z);
    root.rotation.y = Math.atan2(LISTENER.x - SINGER.x, LISTENER.z - SINGER.z);
    neck.rotation.y = -Math.PI / 2;
    scene.add(root);
    root.add(neck);
    neck.add(shift);
    shift.add(head.group);
    let headModel: VoiceModel | null = null;
    const singerLabel = label("Voce", "Solista", V.amber);
    singerLabel.position.set(SINGER.x, 3.0, SINGER.z);
    scene.add(singerLabel);

    // the band: a lane of notes per channel, a performer per channel, a musician per player
    const lanes = new Map<number, Lane>();
    for (const n of notes) {
      const l = lanes.get(n.channel) ?? newLane(n.channel === 9);
      l.notes.push(n);
      lanes.set(n.channel, l);
    }
    // labels rise toward the back, and neighbours take turns a step higher, so none hides another
    const band = performers.map((p, k) => {
      const color = FAMILY_COLOR[p.family];
      const tag = label(p.name, p.voice ? "Voce" : FAMILY_LABEL[p.family], color);
      tag.position.set(p.x, 2.9 - p.z * 0.22 + (k % 2) * 0.42, p.z);
      scene.add(tag);
      const kind = kindOf(p);
      const players = Array.from({ length: p.players }, (_, j) => {
        // a section sits in rows of three around its spot, in a shallow arc, the back rows behind
        const row = Math.floor(j / ROW);
        const inRow = Math.min(ROW, p.players - row * ROW);
        const off = (j % ROW) - (inRow - 1) / 2;
        const [dx, dz] = [off * SPREAD + (row % 2) * 0.2, -row * ROW_DEPTH - 0.15 * Math.abs(off)];
        return newPlayer(kind, kind === "horn" ? hornOf(p) : null, dx, dz, Pen.place(instrument(kind, p.family), p.x, p.z, dx, dz), 1.7 * j + k);
      });
      return { p, color, lane: lanes.get(p.channel), players, glow: 0 };
    });

    const resize = () => {
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      gl.setSize(w, h);
      beams.setResolution(w, h);
      head.resize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      reset();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const pen = new Pen();
    let raf = 0;
    let singerGlow = 0;
    let lastWall = performance.now() / 1000;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const t = timeRef.current();
      const w = performance.now() / 1000;
      const dt = Math.min(0.05, Math.max(0, w - lastWall));
      lastWall = w;
      beams.begin();
      for (const l of floor) beams.line(l, l.length / 3, V.blueMid, 1.05);
      for (const l of grid) beams.line(l, 2, V.blueDim, 0.6, { alpha: 0.45 });
      for (const m of band) {
        if (t !== null && m.lane) update(m.lane, t);
        // light comes on at once and fades out
        m.glow = Math.max(t === null || !m.lane ? 0 : level(m.lane, t), m.glow * 0.88);
        pen.at(m.p.x, m.p.z);
        for (const pl of m.players) {
          for (const l of pl.still) beams.line(l, l.length / 3, m.color, 0.85 + 0.9 * m.glow, { alpha: 0.4 + 0.6 * m.glow, hot: m.glow > 0.5 });
          pen.dx = pl.dx;
          pen.dz = pl.dz;
          drawMusician(beams, pen, pl, m.lane, t, w, dt, m.color, m.glow, 0);
        }
      }
      singerGlow = Math.max(singerRef.current() ? 1 : 0, singerGlow * 0.9);
      const st = useStore.getState();
      const size = sizeOf(st.body);
      if (size !== singerSize) {
        // the mic stand at the singer's height
        singerSize = size;
        singer.still = Pen.place(instrument("singer", "piano").map((l) => l.map((v) => v * size)), SINGER.x, SINGER.z, 0, 0);
      }
      for (const l of singer.still) beams.line(l, l.length / 3, V.blueMid, 1.05, { alpha: 0.55 + 0.45 * singerGlow });
      pen.at(SINGER.x, SINGER.z);
      pen.dx = pen.dz = 0;
      pen.size = size;
      drawMusician(beams, pen, singer, undefined, t, w, dt, V.amber, singerGlow, singerGlow);
      pen.size = 1;
      beams.end();
      // dim with depth from wherever the view is (a big stage puts the camera further back)
      const fog = scene.fog as THREE.Fog;
      const d = camera.position.distanceTo(controls.target);
      fog.near = d - 4;
      fog.far = d + 16;
      const m = modelRef.current;
      if (m) {
        if (m !== headModel) {
          headModel = m;
          shift.position.copy(head.pivot(m)).negate();
        }
        // NECK is the singer's, drawn last; the head's true size whatever the body's
        neck.position.set(NECK[0], NECK[1] + 0.11, NECK[2] + 0.01);
        root.scale.setScalar(SCALE * size);
        neck.scale.setScalar(0.01 / size);
        root.updateMatrixWorld(true);
        head.camera.position.copy(camera.position);
        const tele = engine.latest && sameBody(engine.latest.body, st.body) ? engine.latest : null;
        const a = tele ? VoiceModel.articFromArray(tele.t.artic) : st.artic;
        head.face.update(tele, dt);
        head.update(m, m.frame(a), a, tele, st.view, dt);
      }
      controls.update();
      gl.render(scene, camera);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.domElement.removeEventListener("dblclick", reset);
      controls.dispose();
      beams.dispose();
      head.dispose();
      scene.traverse((o) => {
        const sp = o as THREE.Sprite;
        if (sp.isSprite) {
          sp.material.map?.dispose();
          sp.material.dispose();
        }
      });
      gl.dispose();
      gl.domElement.remove();
    };
  }, [performers, notes]);

  const names = ["Voce", ...performers.map((p) => (p.players > 1 ? `${p.name} (${p.players})` : p.name))].join(", ");
  if (failed) return <p className="stage-fallback">Il palco 3D non è disponibile (WebGL spento). Suonano: {names}.</p>;
  return <div ref={wrapRef} role="img" aria-label={`Palco: ${names}`} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }} />;
}
