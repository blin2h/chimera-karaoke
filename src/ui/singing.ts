/**
 * Sing mode on the main thread. The lyrics become syllables with a cursor; each key sings the
 * next syllable at its pitch. A key pressed while the previous one is still down sings legato
 * (the previous syllable's coda runs straight into the next onset); a "-" in the lyrics holds
 * the vowel onto a new pitch (melisma). Releasing the sounding key while another is still down
 * glides back to that key on the same vowel. Key velocity sets the breath.
 * Demo songs are planned whole (planSong) and sent as one score.
 */
import { create } from "zustand";
import { engine } from "../audio/AudioEngine.ts";
import { g2pFor, useLang } from "./speech.ts";
import { lyricsToSyllables, type Lang, type Plan, type Syllable } from "../wasm/engine.ts";
import { planSong, planNoteOn, planNoteOff, planMelisma } from "../wasm/engine.ts";
import { EXHALE_LABEL } from "../wasm/engine.ts";
import { DEMO_SONGS } from "../wasm/engine.ts";
import type { DemoSong, Gesture } from "../wasm/types.ts";
import { karaokeSyllables, singingSpans, type BandNote, type KaraokeSong } from "./karaoke.ts";
import { playBand, type BandControl, type BandSpace } from "../audio/band.ts";
import { nearestBody, type BodyMix } from "./body.ts";

/** A note on the piano roll, on the voice clock (s); t1 is null while it is held. */
export interface RollNote {
  midi: number;
  t0: number;
  t1: number | null;
  text: string;
  demo: boolean;
}

/** What the piano roll draws, read every frame (mutated in place: no re-render per note). */
export const roll: { notes: RollNote[] } = { notes: [] };

export const DEFAULT_LYRICS: Record<Lang, string> = { en: "Hello there, I am a voice made of air.", it: "Ciao, sono una voce fatta d'aria." };
const lang = () => useLang.getState().lang;

/** sung when the lyrics are empty */
const AH: Syllable = { text: "ah", onset: [], nucleus: { ipa: "ɑ", stress: 1 }, coda: [], wordEnd: true, phraseEnd: false };

interface SingState {
  lyrics: string;
  syllables: Syllable[];
  /** the syllable the next key sings */
  cursor: number;
  /** vibrato depth on held vowels (cents) */
  vibrato: number;
  /** an imported song's other tracks play along */
  band: boolean;
  /** the demo song playing, if any */
  demo: string | null;
  /** index of the demo syllable being sung (−1: none yet) */
  demoAt: number;
  setLyrics: (text: string) => void;
  setCursor: (i: number) => void;
  setVibrato: (cents: number) => void;
  setBand: (on: boolean) => void;
}

export const useSing = create<SingState>((set, get) => ({
  lyrics: DEFAULT_LYRICS[lang()],
  syllables: lyricsToSyllables(DEFAULT_LYRICS[lang()], lang()),
  cursor: 0,
  vibrato: 35,
  band: true,
  demo: null,
  demoAt: -1,
  setLyrics: (text) => {
    stopDemo();
    set({ lyrics: text, syllables: lyricsToSyllables(text, lang()), cursor: 0 });
  },
  setCursor: (i) => set({ cursor: Math.max(0, Math.min(i, Math.max(0, get().syllables.length - 1))) }),
  setVibrato: (cents) => set({ vibrato: cents }),
  setBand: (on) => set({ band: on }),
}));

/** Load the pronouncing dictionary, then re-read the lyrics with it (the cursor stays). */
export function ensureDictionary(): void {
  const g = g2pFor(lang());
  if (g.loaded) return;
  g.load()
    .then(() => {
      const s = useSing.getState();
      const syllables = lyricsToSyllables(s.lyrics, lang());
      useSing.setState({ syllables, cursor: Math.min(s.cursor, Math.max(0, syllables.length - 1)) });
    })
    .catch(() => {
      // no dictionary: the letter-to-sound rules keep working
    });
}

// another language re-reads the lyrics (the default lyrics change with it)
useLang.subscribe(({ lang: l }, prev) => {
  if (l === prev.lang) return;
  const s = useSing.getState();
  const lyrics = s.lyrics === DEFAULT_LYRICS[prev.lang] ? DEFAULT_LYRICS[l] : s.lyrics;
  useSing.setState({ lyrics, syllables: lyricsToSyllables(lyrics, l), cursor: 0 });
  ensureDictionary();
});

// ---- live notes

interface Sounding {
  midi: number;
  /** the syllable whose vowel is sounding (a melisma keeps its parent's, for the coda) */
  syl: Syllable;
  tag: number;
  note: RollNote;
}

let sounding: Sounding | null = null;

/** How a syllable is written at the mouth: a hyphen when its word goes on. */
const written = (s: Syllable) => s.text + (s.wordEnd ? "" : "-");

/**
 * The syllable being sung now, for the words at the mouth: the demo's note under the clock, or
 * the held key's. A melisma keeps its syllable's key, so the word stays while the pitch moves.
 */
export function sungNow(): { key: unknown; text: string } | null {
  const d = demoRun;
  if (d) {
    if (d.offset === null) return null;
    const t = now() - d.offset;
    // notes follow one another without a gap, so a melisma's syllable stays put
    const k = d.times.findIndex(([a, b]) => t >= a && t < b);
    return k < 0 ? null : { key: `${d.id}:${d.parent[k]}`, text: d.shown[k] };
  }
  return sounding ? { key: sounding, text: written(sounding.syl) } : null;
}

/** The syllable whose vowel is sounding from the keys now (null when no key sings). */
export function soundingSyllable(): string | null {
  return sounding?.syl.text ?? null;
}
/** keys down, oldest first */
let keys: number[] = [];
/** gesture tags: a note uses tag (articulation, breath) and tag + 1 (pitch, vibrato) */
let nextTag = 2;
/** endings (glide, coda) that may still be playing: tag, and tag + 1 for the breath-out */
const tails: number[] = [];
/** endings whose breath-out has not been dropped by a following note */
let exhalesLive = false;

/** breath level for a key velocity (1 at the on-screen keys' default of 96) */
const breathFor = (velocity: number) => 0.62 + 0.4 * Math.min(1, Math.max(0, velocity / 96)) + 0.12 * Math.max(0, (velocity - 96) / 31);

const now = () => engine.voiceClock() ?? 0;

function addNote(midi: number, t0: number, text: string, demo = false, t1: number | null = null): RollNote {
  const n: RollNote = { midi, t0, t1, text, demo };
  roll.notes.push(n);
  // keep a minute of history
  const cut = t0 - 60;
  if (roll.notes.length > 400 || (roll.notes[0] && (roll.notes[0].t1 ?? t0) < cut)) roll.notes = roll.notes.filter((x) => (x.t1 ?? t0) >= cut).slice(-400);
  return n;
}

/** The syllable a melisma at index i continues. */
function parentOf(syls: Syllable[], i: number): Syllable {
  for (let k = i; k >= 0; k--) if (!syls[k].melisma) return syls[k];
  return AH;
}

function startNote(syl: Syllable, midi: number, velocity: number, body: BodyMix, text: string): void {
  const t = now();
  const tag = nextTag;
  nextTag += 2;
  // earlier codas may finish, but their breath-out must not open the folds on this onset
  if (exhalesLive) for (const t of tails) engine.release(t + 1);
  exhalesLive = false;
  const from = sounding;
  if (from) {
    engine.release(from.tag);
    engine.release(from.tag + 1);
    from.note.t1 = t;
  }
  const gs: Gesture[] = planNoteOn(syl, midi, { body, vibrato: useSing.getState().vibrato, tag, legatoFrom: from ? { syl: from.syl, midi: from.midi } : undefined });
  const breath = breathFor(velocity);
  for (const g of gs) if (g.targets.breath !== undefined) g.targets = { ...g.targets, breath: g.targets.breath * breath };
  engine.scheduleGestures(gs);
  sounding = { midi, syl, tag, note: addNote(midi, t, text) };
}

/** The held vowel moves to a new pitch (melisma, or back to a key still down). */
function glide(midi: number, text: string): void {
  const s = sounding!;
  const t = now();
  engine.release(s.tag + 1);
  engine.scheduleGestures(planMelisma(midi, { vibrato: useSing.getState().vibrato, tag: s.tag }));
  s.note.t1 = t;
  s.midi = midi;
  s.note = addNote(midi, t, text);
}

export function singNoteOn(midi: number, velocity: number, body: BodyMix): void {
  stopDemo();
  keys = keys.filter((k) => k !== midi).concat(midi);
  const st = useSing.getState();
  const syls = st.syllables.length ? st.syllables : [AH];
  const i = st.cursor % syls.length;
  const syl = syls[i];
  if (syl.melisma && sounding) glide(midi, syl.text);
  // a melisma with nothing held: sing its vowel again, without the onset
  else startNote(syl.melisma ? { ...parentOf(syls, i), onset: [] } : syl, midi, velocity, body, syl.text);
  useSing.setState({ cursor: (i + 1) % syls.length });
}

export function singNoteOff(midi: number, body: BodyMix): void {
  keys = keys.filter((k) => k !== midi);
  const s = sounding;
  if (!s || s.midi !== midi) return;
  if (keys.length) {
    glide(keys[keys.length - 1], "~");
    return;
  }
  engine.release(s.tag);
  engine.release(s.tag + 1);
  s.note.t1 = now();
  sounding = null;
  // a melisma comes next: this vowel carries on there, and the coda waits for the chain's end
  const st = useSing.getState();
  if (st.syllables[st.cursor]?.melisma) return;
  const gs = planNoteOff(s.syl, midi, body);
  if (!gs.length) return;
  const tag = nextTag;
  nextTag += 2;
  engine.scheduleGestures(gs.map((g) => ({ ...g, tag: g.label === EXHALE_LABEL ? tag + 1 : tag })));
  tails.push(tag);
  if (tails.length > 8) tails.shift(); // long finished by now
  exhalesLive = true;
}

// ---- demo songs

interface DemoRun {
  id: number;
  /** note start/end times in plan time (s) */
  times: [number, number][];
  midi: number[];
  text: string[];
  /** what the mouth shows per note, and the note whose syllable it is (a melisma's parent) */
  shown: string[];
  parent: number[];
  end: number;
  /** voice clock of plan time 0, once the worklet has it */
  offset: number | null;
  /** an imported song's accompaniment, started with the voice: song time 0 at plan time `at` */
  band?: { notes: BandNote[]; at: number; space?: BandSpace; control?: BandControl };
}

let demoRun: DemoRun | null = null;
/** bumped by every stop: a demo still waiting for audio or the dictionary then gives up */
let demoToken = 0;

engine.onPlanned((m) => {
  const d = demoRun;
  if (!d || m.id !== d.id) return;
  d.offset = m.t0;
  // the band joins on the context's clock: plan time 0 is voice clock m.t0, so many seconds from now
  const out = engine.bandOutput();
  if (d.band && out && engine.ctx) {
    const at = engine.ctx.currentTime + (m.t0 - (engine.voiceClock() ?? m.t0)) + d.band.at;
    d.band.control = playBand(engine.ctx, out, d.band.notes, at, d.band.space);
    d.band.control.setLevel(bandLevel);
  }
  d.times.forEach(([a, b], k) => addNote(d.midi[k], m.t0 + a, d.text[k], true, m.t0 + b - 0.02));
});

/** Sing a demo song (after `ready`, e.g. audio startup, resolves; unless stopped meanwhile). */
export async function playDemo(name: string, body: BodyMix, ready?: () => Promise<void>): Promise<void> {
  const song = DEMO_SONGS.find((s) => s.name === name);
  if (song) await runSong(song, body, ready);
}

/** Sing a song parsed from a MIDI/.kar file, in the language set in the UI: its own lyrics note
 *  by note, or the words in the lyrics box when it has none; with its other tracks when the band
 *  is on (the voice then keeps the file's timing, rests and all). */
export async function playImported(song: KaraokeSong, body: BodyMix, ready?: () => Promise<void>, space?: BandSpace): Promise<void> {
  const l = lang();
  const words = song.words;
  const timed = useSing.getState().band && song.band.length ? { times: song.times, band: song.band, space } : null;
  await runSong({ ...song, lang: l, lyrics: song.lyrics || useSing.getState().lyrics }, body, ready, words && (() => karaokeSyllables(words, (text) => lyricsToSyllables(text, l))), timed);
}

/** plan time of song time 0 when the band plays (the first note's consonants come before it) */
const BAND_LEAD = 0.35;
/** gestures the worklet takes per message (MAX_GESTURES in processor.ts) */
const MAX_SCHEDULE = 4000;

/** A melody planned on the file's own clock: one `planSong` per stretch between rests (each its
 *  own breath), placed at its time, merged into one plan. */
function planTimed(notes: { midi: number; syl: Syllable }[], times: [number, number][], body: BodyMix, vibrato: number): { plan: Plan; spans: [number, number][] } {
  const plan: Plan = { gestures: [], segments: [], end: 0 };
  for (const [a, b] of singingSpans(times)) {
    const part = notes.slice(a, b).map((n, k) => {
      const i = a + k;
      // bpm 60: a beat is a second; each note lasts to the next one's start, the last its own length
      const beats = i + 1 < b ? times[i + 1][0] - times[i][0] : Math.max(0.15, times[i][1] - times[i][0]);
      return { midi: n.midi, beats, syl: n.syl };
    });
    const p = planSong(part, { body, bpm: 60, t0: BAND_LEAD + times[a][0], vibrato });
    plan.gestures.push(...p.gestures);
    plan.segments.push(...p.segments);
    plan.end = Math.max(plan.end, p.end);
  }
  const spans = times.map(([a], i): [number, number] => [BAND_LEAD + a, BAND_LEAD + (i + 1 < times.length ? Math.min(times[i + 1][0], times[i][1] + 0.3) : times[i][1])]);
  return { plan, spans };
}

async function runSong(song: DemoSong, body: BodyMix, ready?: () => Promise<void>, syllables?: (() => Syllable[]) | null, timed?: { times: [number, number][]; band: BandNote[]; space?: BandSpace } | null): Promise<void> {
  stopSinging();
  const token = demoToken;
  await ready?.();
  const songLang = song.lang ?? "en";
  try {
    await g2pFor(songLang).load();
  } catch {
    // letter-to-sound rules
  }
  if (token !== demoToken) return;
  // read once the dictionary is in
  const syl = syllables ? syllables() : lyricsToSyllables(song.lyrics, songLang);
  if (!syl.length) return;
  const shift = song.octave[nearestBody(body)] * 12;
  const notes = song.notes.map((n, i) => ({ midi: n[0] + shift, beats: n[1], syl: syl[i % syl.length] }));
  const vibrato = useSing.getState().vibrato;
  let plan: Plan;
  let times: [number, number][];
  if (timed) {
    ({ plan, spans: times } = planTimed(notes, timed.times, body, vibrato));
  } else {
    const t0 = 0.35;
    plan = planSong(notes, { body, bpm: song.bpm, t0, vibrato });
    const beat = 60 / song.bpm;
    let t = t0;
    times = notes.map((n): [number, number] => {
      const a = t;
      t += n.beats * beat;
      return [a, t];
    });
  }
  // a long song in several messages, the later ones added to the first (each lands within one
  // audio block of it)
  const id = engine.schedule({ gestures: plan.gestures.slice(0, MAX_SCHEDULE), segments: plan.segments, end: plan.end });
  for (let k = MAX_SCHEDULE; k < plan.gestures.length; k += MAX_SCHEDULE) engine.schedule({ gestures: plan.gestures.slice(k, k + MAX_SCHEDULE), segments: [], end: plan.end }, false);
  const parent: number[] = [];
  notes.forEach((n, i) => parent.push(n.syl.melisma && i > 0 ? parent[i - 1] : i));
  const shown = parent.map((p) => written(notes[p].syl));
  const bandEnd = timed ? BAND_LEAD + timed.band.reduce((e, n) => Math.max(e, n.end), 0) : 0;
  demoRun = {
    id,
    times,
    midi: notes.map((n) => n.midi),
    text: notes.map((n) => n.syl.text),
    shown,
    parent,
    end: Math.max(plan.end, bandEnd),
    offset: null,
    band: timed ? { notes: timed.band, at: BAND_LEAD, space: timed.space } : undefined,
  };
  useSing.setState({ lyrics: song.lyrics, syllables: syl, cursor: 0, demo: song.name, demoAt: -1 });
}

/** the band's level (0–1.5), kept across songs */
let bandLevel = 0.8;
export function setBandLevel(level: number): void {
  bandLevel = level;
  demoRun?.band?.control?.setLevel(level);
}

/** The playing band's clock (song seconds), for the stage; null when no band plays. */
export function bandTime(): number | null {
  return demoRun?.band?.control?.time() ?? null;
}

/** The sung note at the playhead (an index into the song's syllables), −1 between notes. */
export function sungIndex(): number {
  return useSing.getState().demoAt;
}

function stopDemo(): void {
  demoToken++;
  const d = demoRun;
  if (!d) return;
  demoRun = null;
  d.band?.control?.stop();
  engine.stopSpeech();
  // notes not yet sung leave the roll; the one sounding ends now
  const t = now();
  roll.notes = roll.notes.filter((n) => !(n.demo && n.t0 > t));
  for (const n of roll.notes) if (n.demo && n.t1 !== null && n.t1 > t) n.t1 = t;
  useSing.setState({ demo: null, demoAt: -1 });
}

/** Called every frame while Sing mode is shown: follow the demo's progress. */
export function tickSinging(): void {
  const d = demoRun;
  if (!d || d.offset === null) return;
  const t = now() - d.offset;
  if (t > d.end + 0.4) {
    demoRun = null;
    useSing.setState({ demo: null, demoAt: -1 });
    return;
  }
  let k = -1;
  while (k + 1 < d.times.length && d.times[k + 1][0] <= t) k++;
  if (k !== useSing.getState().demoAt) useSing.setState({ demoAt: k });
}

/** Stop everything sung (leaving Sing mode, changing body): demo, notes and endings. */
export function stopSinging(): void {
  stopDemo();
  if (sounding) {
    engine.release(sounding.tag);
    engine.release(sounding.tag + 1);
    sounding.note.t1 = now();
    sounding = null;
  }
  for (const t of tails) {
    engine.release(t);
    engine.release(t + 1);
  }
  tails.length = 0;
  exhalesLive = false;
  keys = [];
}

export { DEMO_SONGS };
