/** The karaoke stage: who plays (General MIDI programs), and where a band would put them. */
import { expect, test } from "bun:test";
import { footprint, performers, SINGER } from "../src/ui/stage.ts";
import type { BandNote } from "../src/ui/karaoke.ts";

const n = (channel: number, program: number, start = 0): BandNote => ({ midi: 60, channel, program, velocity: 1, volume: 1, start, end: start + 1 });

test("each channel is a performer named by its program, placed by family", () => {
  const cast = performers([n(0, 0), n(1, 33), n(9, 0), n(2, 25), n(3, 52), n(1, 33, 1), n(4, 0)]);
  expect(cast.map((p) => [p.channel, p.name, p.family, p.voice])).toEqual([
    [0, "Acoustic Grand Piano", "piano", false],
    [1, "Electric Bass (finger)", "bass", false],
    [2, "Acoustic Guitar (steel)", "guitar", false],
    [3, "Choir Aahs", "ensemble", true],
    [4, "Acoustic Grand Piano", "piano", false],
    [9, "Drum Kit", "drums", false],
  ]);
  const at = (ch: number) => cast.find((p) => p.channel === ch)!;
  // keys stage left, guitar stage right, drums at the back in the middle, the choir behind the singer
  expect(at(0).x).toBeLessThan(0);
  expect(at(2).x).toBeGreaterThan(0);
  expect(at(9).x).toBe(0);
  expect(at(9).z).toBeLessThan(at(0).z);
  expect(at(3).z).toBeLessThan(SINGER.z);
  // a second piano steps aside rather than standing on the first
  expect([at(4).x, at(4).z]).not.toEqual([at(0).x, at(0).z]);
  // the most-used program names the channel
  expect(performers([n(5, 40), n(5, 40, 1), n(5, 41, 2)])[0].name).toBe("Violin");
});

test("a big orchestra (sections, several of a family) has nobody standing on anybody", () => {
  // strings, choirs and brass sections, three pianos, two drum kits' worth of percussion, winds
  const programs = [48, 49, 52, 53, 0, 0, 0, 61, 56, 65, 73, 40, 42, 33, 25, 50];
  const cast = performers([...programs.map((p, ch) => n(ch >= 9 ? ch + 1 : ch, p)), n(9, 0)]);
  expect(cast.length).toBe(17);
  const rects = cast.map((p) => {
    const f = footprint(p);
    return { x0: p.x - f.half, x1: p.x + f.half, z0: p.z - f.back, z1: p.z + f.front };
  });
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    expect(a.z1).toBeLessThanOrEqual(0); // behind the front edge
    expect(a.x1 < SINGER.x - 0.9 || a.x0 > SINGER.x + 0.9 || a.z1 < SINGER.z - 0.7).toBe(true); // the singer kept clear
    for (let j = 0; j < i; j++) {
      const b = rects[j];
      expect(a.x1 <= b.x0 || b.x1 <= a.x0 || a.z1 <= b.z0 || b.z1 <= a.z0).toBe(true);
    }
  }
});
