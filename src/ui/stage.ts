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
  { x: -1.6, z: -2.4 },
  { x: 1.6, z: -2.4 },
  { x: -3.0, z: -2.0 },
  { x: 3.0, z: -2.0 },
];

/** General MIDI programs that are a section of players, and how many to draw */
const SECTION: Record<number, number> = { 44: 4, 45: 4, 48: 6, 49: 6, 50: 5, 51: 5, 52: 4, 53: 4, 54: 2, 61: 3 };

/** The band's performers, one per channel, in channel order. */
export function performers(band: BandNote[]): Performer[] {
  const byChannel = new Map<number, { programs: Map<number, number>; notes: number }>();
  for (const n of band) {
    const c = byChannel.get(n.channel) ?? { programs: new Map(), notes: 0 };
    c.programs.set(n.program, (c.programs.get(n.program) ?? 0) + 1);
    c.notes++;
    byChannel.set(n.channel, c);
  }
  const taken = new Map<Family, number>();
  let voices = 0;
  return [...byChannel.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([channel, c]) => {
      const program = [...c.programs.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const family = familyOf(channel, program);
      const voice = channel !== 9 && isVoiceProgram(program);
      let x: number;
      let z: number;
      if (voice) {
        const s = VOICE_SPOTS[voices++ % VOICE_SPOTS.length];
        ({ x, z } = s);
      } else {
        const s = SPOTS[family];
        const k = taken.get(family) ?? 0;
        taken.set(family, k + 1);
        x = s.x + s.dx * k;
        z = s.z + s.dz * k;
      }
      return { channel, program, family, name: instrumentName(channel, program), voice, notes: c.notes, players: SECTION[program] ?? 1, x, z };
    });
}
