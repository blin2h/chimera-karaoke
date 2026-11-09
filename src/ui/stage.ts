/**
 * The karaoke stage: who plays in an imported song, and where they stand. Each channel of the
 * band is a performer playing its most-used General MIDI program, placed by family the way a
 * band sets up: drums at the back in the middle, bass beside them, keys stage left, guitars stage
 * right, strings in an arc, winds behind. The same positions place each one's sound (spatial
 * audio) and its marker on the 3D stage.
 *
 * Coordinates (m): x across the stage, + to the audience's right; z toward the audience, the
 * front edge at 0; y up. The singer stands front and centre; the listener sits out front.
 */
import { familyOf, instrumentName, isVoiceProgram, type Family } from "../audio/gm.ts";
import type { BandNote } from "./karaoke.ts";

export interface Performer {
  channel: number;
  program: number;
  family: Family;
  name: string;
  /** a choir or synth voice: a singer on the stage, not an instrument */
  voice: boolean;
  /** notes played */
  notes: number;
  /** how many musicians: a section (strings, a choir, brass) is several, anything else one */
  players: number;
  x: number;
  z: number;
}

/** where the lead singer stands */
export const SINGER = { x: 0, z: -1.2 } as const;
/** where the audience listens from (the spatial audio's listener) */
export const LISTENER = { x: 0, y: 1.6, z: 7 } as const;

/** each family's spot, and the direction its next player steps when the spot is taken */
const SPOTS: Record<Family, { x: number; z: number; dx: number; dz: number }> = {
  drums: { x: 0, z: -5.2, dx: 1.8, dz: 0 },
  bass: { x: -2.6, z: -4.4, dx: -1.4, dz: 0.3 },
  piano: { x: -4.6, z: -2.6, dx: -0.6, dz: -1.3 },
  chromatic: { x: -4.4, z: -4.2, dx: -1.2, dz: 0 },
  organ: { x: -5.4, z: -3.6, dx: 0.4, dz: -1.2 },
  guitar: { x: 3.8, z: -2.6, dx: 1.2, dz: -0.8 },
  ethnic: { x: 5.2, z: -2.0, dx: 0.4, dz: -1.2 },
  strings: { x: -3.2, z: -1.4, dx: -1.2, dz: -0.6 },
  ensemble: { x: -1.8, z: -3.2, dx: -1.2, dz: -0.4 },
  brass: { x: 2.6, z: -4.4, dx: 1.3, dz: 0 },
  reed: { x: 3.4, z: -3.6, dx: 1.2, dz: 0.2 },
  pipe: { x: 4.6, z: -4.6, dx: 1.0, dz: 0.3 },
  lead: { x: 5.6, z: -3.4, dx: 0, dz: -1.2 },
  pad: { x: -5.8, z: -5.2, dx: 1.2, dz: 0 },
  fx: { x: 5.8, z: -5.4, dx: -1.2, dz: 0 },
  percussive: { x: 1.6, z: -5.8, dx: 1.2, dz: 0 },
  sfx: { x: -1.6, z: -6.0, dx: -1.2, dz: 0 },
};
/** voices (choirs, synth voices) stand behind the singer, left and right */
const VOICE_SPOTS = [
  { x: -1.7, z: -2.8 },
  { x: 1.7, z: -2.8 },
  { x: -3.0, z: -2.0 },
  { x: 3.0, z: -2.0 },
];

/** the stage drawings are larger than life, to read from the audience (drawing units → m) */
export const SCALE = 1.4;
/** section players stand this far apart (drawing units), three to a row, each row further back */
export const SPREAD = 0.8;
export const ROW = 3;
export const ROW_DEPTH = 0.75;

/** General MIDI programs that are a section of players, and how many to draw */
const SECTION: Record<number, number> = { 44: 4, 45: 4, 48: 6, 49: 6, 50: 5, 51: 5, 52: 4, 53: 4, 54: 2, 61: 3 };

/** the floor a performer takes (m), around its spot: across, in front, behind */
export function footprint(p: { family: Family; players: number; voice: boolean }): { half: number; front: number; back: number } {
  const kit = !p.voice && p.family === "drums";
  const keys = !p.voice && (p.family === "piano" || p.family === "organ" || p.family === "chromatic");
  // half the width of one player and instrument: a guitar's or bass's neck reaches far to the side,
  // a bow less so
  const strung = !p.voice && (p.family === "guitar" || p.family === "bass" || p.family === "ethnic");
  const bowed = !p.voice && (p.family === "strings" || p.family === "ensemble");
  const one = kit ? 1.05 : keys ? 0.75 : strung ? 0.95 : bowed ? 0.6 : 0.45;
  const rows = Math.ceil(p.players / ROW);
  return {
    half: (((Math.min(ROW, p.players) - 1) / 2) * SPREAD + one) * SCALE,
    front: 0.5 * SCALE,
    back: ((rows - 1) * ROW_DEPTH + (kit ? 0.9 : 0.6)) * SCALE,
  };
}

/** the lead singer and the mic keep this clear (x across, z from front to back) */
const SINGER_ZONE = { x0: SINGER.x - 0.9, x1: SINGER.x + 0.9, z0: SINGER.z - 0.7, z1: 0 };
/** room left between two performers (m) */
const GAP = 0.15;

/**
 * The nearest free place to (x, z) for a footprint, among rects already taken: rings of growing
 * radius around the spot, behind the front edge. ponytail: greedy, first come first placed; a
 * big orchestra spreads outward rather than packing optimally.
 */
function freeSpot(x: number, z: number, f: ReturnType<typeof footprint>, taken: { x0: number; x1: number; z0: number; z1: number }[]): { x: number; z: number } {
  const clear = (cx: number, cz: number) => {
    const r = { x0: cx - f.half, x1: cx + f.half, z0: cz - f.back, z1: cz + f.front };
    return r.z1 <= -0.1 && taken.every((o) => r.x1 + GAP <= o.x0 || o.x1 + GAP <= r.x0 || r.z1 + GAP <= o.z0 || o.z1 + GAP <= r.z0);
  };
  for (let rad = 0; rad < 20; rad += 0.35) {
    const n = rad === 0 ? 1 : Math.ceil((2 * Math.PI * rad) / 0.35);
    // the side of the spot facing away from the singer first, then round
    const a0 = Math.atan2(x - SINGER.x, z - SINGER.z);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * ((2 * Math.PI) / n);
      const cx = x + rad * Math.sin(a), cz = Math.min(z + rad * Math.cos(a), -0.1 - f.front);
      if (clear(cx, cz)) return { x: cx, z: cz };
    }
  }
  return { x, z };
}

/** placed first (they anchor the band): drums, bass, keys, voices; then the rest by channel */
const FIRST: Partial<Record<Family, number>> = { drums: 0, bass: 1, piano: 2, organ: 3, chromatic: 4 };

/** The band's performers, one per channel, in channel order, none standing on another. */
export function performers(band: BandNote[]): Performer[] {
  const byChannel = new Map<number, { programs: Map<number, number>; notes: number }>();
  for (const n of band) {
    const c = byChannel.get(n.channel) ?? { programs: new Map(), notes: 0 };
    c.programs.set(n.program, (c.programs.get(n.program) ?? 0) + 1);
    c.notes++;
    byChannel.set(n.channel, c);
  }
  const cast: Performer[] = [...byChannel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([channel, c]) => {
      const program = [...c.programs.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const family = familyOf(channel, program);
      const voice = channel !== 9 && isVoiceProgram(program);
      return { channel, program, family, name: instrumentName(channel, program), voice, notes: c.notes, players: SECTION[program] ?? 1, x: 0, z: 0 };
    });
  const rank = (p: Performer) => (p.voice ? 5 : (FIRST[p.family] ?? 6));
  const taken = [SINGER_ZONE];
  const used = new Map<Family, number>();
  let voices = 0;
  for (const p of [...cast].sort((a, b) => rank(a) - rank(b) || a.channel - b.channel)) {
    let want: { x: number; z: number };
    if (p.voice) want = VOICE_SPOTS[voices++ % VOICE_SPOTS.length];
    else {
      const s = SPOTS[p.family];
      const k = used.get(p.family) ?? 0;
      used.set(p.family, k + 1);
      want = { x: s.x + s.dx * k, z: s.z + s.dz * k };
    }
    const f = footprint(p);
    ({ x: p.x, z: p.z } = freeSpot(want.x, want.z, f, taken));
    taken.push({ x0: p.x - f.half, x1: p.x + f.half, z0: p.z - f.back, z1: p.z + f.front });
  }
  return cast;
}
