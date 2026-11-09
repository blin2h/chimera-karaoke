/**
 * The MIDI/.kar reader behind Sing's "Load MIDI / .kar" button. The files are built from bytes in
 * the test itself — an original scrap of melody — so no song file ever enters the repo.
 */
import { describe, expect, test } from "bun:test";
import { karaokeSyllables, parseKaraoke, singingSpans } from "../src/ui/karaoke.ts";
import type { Syllable } from "../src/wasm/types.ts";

const be = (n: number, w = 2): number[] => Array.from({ length: w }, (_, i) => (n >> (8 * (w - 1 - i))) & 0xff);
const vlq = (n: number): number[] => {
  const out = [n & 0x7f];
  let v = n >> 7;
  while (v) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
};
const chars = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const ev = (delta: number, ...msg: number[]): number[] => [...vlq(delta), ...msg];
const meta = (type: number, data: number[]): number[] => [0xff, type, ...vlq(data.length), ...data];
const chunk = (id: string, data: number[]): number[] => [...chars(id), ...be(data.length, 4), ...data];
const midi = (format: number, tracks: number[][]): Uint8Array =>
  new Uint8Array([...chunk("MThd", [...be(format), ...be(tracks.length), ...be(480)]), ...tracks.flatMap((t) => chunk("MTrk", t))]);

type AbsEvent = [tick: number, bytes: number[]];
/** events at absolute ticks, sorted stably, with an end-of-track mark */
const at = (events: AbsEvent[]): number[] => {
  let t = 0;
  let out: number[] = [];
  for (const [tick, msg] of events.sort((a, b) => a[0] - b[0])) {
    out = [...out, ...ev(Math.max(0, tick - t)), ...msg];
    t = tick;
  }
  return [...out, ...ev(0, 0xff, 0x2f, 0x00)];
};
const tempo = (usPerQuarter: number): number[] => meta(0x51, be(usPerQuarter, 3));
const lyric = (s: string): number[] => meta(0x05, chars(s));
/** a note's on/off events at absolute ticks */
const note = (pitch: number, from: number, len: number, channel = 0): AbsEvent[] => [
  [from, [0x90 | channel, pitch, 100]],
  [from + len, [0x80 | channel, pitch, 0]],
];

/** A karaoke-style file: conductor, melody with lyrics (one event per note), thick accompaniment. */
const karFile = (): Uint8Array =>
  midi(1, [
    at([[0, tempo(500000)]]), // 120 bpm
    at([
      [0, meta(0x03, chars("Melody"))],
      [0, lyric("Ce-")],
      ...note(60, 0, 480),
      [480, lyric("li-")],
      ...note(64, 480, 480),
      [960, lyric("a ")],
      ...note(67, 960, 480),
      ...note(60, 960, 480), // a doubling an octave down: dropped
      ...note(36, 960, 240, 9), // the drum channel: dropped
      [1440, lyric("/")], // line break
      [1920, lyric("nel ")],
      ...note(72, 1920, 240),
      [2400, lyric("mar")],
      ...note(74, 2400, 240),
    ]),
    at([
      [0, meta(0x03, chars("Accomp."))],
      ...[48, 50, 52, 53, 55, 57, 59, 60].flatMap((p, i) => note(p, i * 240, 200)),
    ]),
  ]);

describe("parseKaraoke", () => {
  test("sings the melody track with its lyrics, onsets and all", () => {
    const song = parseKaraoke(karFile(), "prova.kar");
    expect(song.name).toBe("prova");
    expect(song.bpm).toBe(120);
    // the "/" before "nel" starts a new line: a breath after "Ce-li-a"
    expect(song.lyrics).toBe("Ce-li-a, nel mar.");
    expect(song.words?.map((w) => w.parts)).toEqual([["Ce", "li", "a"], ["nel"], ["mar"]]);
    expect(song.notes.map((n) => n[0])).toEqual([60, 64, 67, 72, 74]);
    // steps of one beat, the rest after beat three squeezed to note + release, the last its own length
    const beats = song.notes.map((n) => n[1]);
    [1, 1, 1.7, 1, 0.5].forEach((v, i) => expect(beats[i]).toBeCloseTo(v, 6));
    expect(song.octave).toEqual({ male: -1, female: 0, child: 0 });
  });

  test("a file without lyrics sings with empty lyrics (the lyrics box is used then)", () => {
    const song = parseKaraoke(midi(0, [at([...note(60, 0, 480), ...note(64, 480, 480)])]), "nobody.mid");
    expect(song.lyrics).toBe("");
    expect(song.words).toBeNull();
    expect(song.notes.map((n) => n[0])).toEqual([60, 64]);
  });

  test("a Soft Karaoke file: text events on a track of their own, shown ahead of the notes", () => {
    const text = (s: string): number[] => meta(0x01, chars(s));
    const latin = (s: string): number[] => meta(0x01, [...s].map((c) => c.charCodeAt(0))); // Latin-1: "à" is one byte, not UTF-8
    const early = 96; // the words run a 16th ahead of the music
    const song = parseKaraoke(
      midi(1, [
        at([[0, tempo(500000)]]),
        // the words: headers, then one event per syllable, "\" for a new paragraph
        at([[0, text("@KMIDI KARAOKE FILE")], [0, text("@Ttitolo")], [960 - early, text("\\Lu")], [1440 - early, text("na ")], [1920 - early, text("cit")], [2400 - early, latin("tà")]]),
        // an accompaniment with more notes, a few on the beats
        at([...[48, 50, 52, 53, 55, 57, 59, 60, 62, 64].flatMap((p, i) => note(p, i * 240, 200, 1))]),
        // the melody, legato (each note held into the next), an intro note first, and a note held
        // over from the last syllable
        at([...note(65, 0, 480), ...note(67, 960, 520), ...note(69, 1440, 520), ...note(71, 1920, 520), ...note(72, 2400, 300), ...note(74, 2700, 300)]),
      ]),
    );
    expect(song.notes.map((n) => n[0])).toEqual([67, 69, 71, 72, 74]);
    expect(song.words).toEqual([
      { parts: ["Lu", "na"], slots: [true, true], phraseEnd: false },
      { parts: ["cit", "tà"], slots: [true, true, false], phraseEnd: true },
    ]);
  });

  test("one syllable per note: a word read whole when that fits, else piece by piece; a held note repeats the vowel", () => {
    const syl = (text: string): Syllable => ({ text, onset: [], nucleus: { ipa: "a", stress: 1 }, coda: [], wordEnd: false, phraseEnd: false });
    const read = (t: string): Syllable[] => (t === "Luna" ? [syl("Lu"), syl("na")] : t.split("-").map(syl));
    const out = karaokeSyllables(
      [
        { parts: ["Lu", "na"], slots: [true, true], phraseEnd: false },
        { parts: ["cit", "tà"], slots: [true, true, false], phraseEnd: true },
      ],
      read,
    );
    expect(out.map((s) => s.text)).toEqual(["Lu", "na", "cit", "tà", "~"]);
    expect(out.map((s) => s.wordEnd)).toEqual([false, true, false, true, true]);
    expect(out[4].melisma).toBe(true);
    expect(out[4].phraseEnd).toBe(true);
  });

  test("the band: the other tracks, with their programs, volumes and real times", () => {
    const song = parseKaraoke(
      midi(1, [
        // 120 bpm, then 60 from beat 2: a beat lasts 0.5 s, then 1 s
        at([[0, tempo(500000)], [960, tempo(1000000)]]),
        at([[0, lyric("La ")], ...note(60, 0, 480), [960, lyric("la")], ...note(62, 960, 480)]),
        at([[0, [0xc1, 33]], [0, [0xb1, 7, 64]], ...note(40, 0, 960, 1), ...note(43, 960, 480, 1)]), // a bass at half volume
        at([...note(36, 480, 60, 9)]), // a kick
      ]),
    );
    // the voice's notes in seconds, through the tempo change
    expect(song.times).toEqual([[0, 0.5], [1, 2]]);
    // the melody track is the voice, not the band
    expect(song.band.map((n) => [n.channel, n.midi, n.program, n.start, n.end])).toEqual([
      [1, 40, 33, 0, 1],
      [9, 36, 0, 0.5, 0.5625],
      [1, 43, 33, 1, 2],
    ]);
    expect(song.band[0].volume).toBeCloseTo(64 / 127, 6);
    expect(song.band[0].velocity).toBeCloseTo(100 / 127, 6);
  });

  test("a rest splits the singing into stretches", () => {
    expect(singingSpans([[0, 0.5], [0.5, 1], [1.1, 1.5], [3, 4], [4, 5]])).toEqual([[0, 3], [3, 5]]);
    expect(singingSpans([])).toEqual([]);
  });

  test("the file's own tempo sets the bpm", () => {
    const song = parseKaraoke(midi(0, [at([[0, tempo(400000)], ...note(60, 0, 480)])]));
    expect(song.bpm).toBe(150); // 60 s / 0.4 s per quarter
  });

  test("nothing like a MIDI file, or an unsupported kind, says so", () => {
    expect(() => parseKaraoke(new Uint8Array(4))).toThrow(/too short/);
    expect(() => parseKaraoke(new Uint8Array(chars("ABCDEFGHABCDEFGH")))).toThrow(/MThd/);
    expect(() => parseKaraoke(midi(2, [at([])]))).toThrow(/type 2/);
    expect(() => parseKaraoke(midi(1, [at([]), at([])]))).toThrow(/no notes/);
  });
});
