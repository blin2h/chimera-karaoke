/**
 * A dependency-free reader for MIDI and karaoke (.kar) files, so Sing can play a melody from the
 * user's computer: the melody track becomes a demo song, with the file's own lyrics when it has
 * them, else the words in the lyrics box. Nothing is uploaded or stored.
 *
 * Lyrics come as lyric meta events (0x05) or, in the classic Soft Karaoke .kar, as text events
 * (0x01) on a track of their own, "@" lines being headers. Either way: one event per syllable,
 * a space where a word ends, "/" and "\" before a new line or paragraph. They are matched to the
 * melody by time: the melody is the track whose notes start where the syllables do, each
 * syllable goes to the note it starts on, and a note with none holds the syllable before it.
 */

import type { Syllable } from "../wasm/types.ts";

/** A word as sung: its syllables (lyric pieces) and, per note, whether a new piece starts there
 *  (true) or the previous one is held (false, a melisma). */
export interface KarWord {
  parts: string[];
  slots: boolean[];
  /** a line, paragraph or punctuation ends the phrase here: a breath follows */
  phraseEnd: boolean;
}

/** An accompaniment note: the file's other tracks, played by the band (times in seconds). */
export interface BandNote {
  midi: number;
  /** 9 is the drum kit */
  channel: number;
  /** General MIDI program (0–127) in effect when the note starts */
  program: number;
  /** key velocity and channel volume, each 0–1 */
  velocity: number;
  volume: number;
  start: number;
  end: number;
}

/** What `parseKaraoke` returns: a `DemoSong` without a language (the singer's is used). */
export interface KaraokeSong {
  name: string;
  bpm: number;
  /** the words for the lyrics box ("" when the file has none) */
  lyrics: string;
  /** [midi, beats] per note, onsets as in the file (long gaps squeezed to a short release) */
  notes: [number, number][];
  /** the file's lyrics matched to `notes`, word by word (null: the file has none) */
  words: KarWord[] | null;
  /** each sung note's start and end in the file (s), rests and all: what the band plays to */
  times: [number, number][];
  /** the other tracks' notes, by start time */
  band: BandNote[];
  octave: { male: number; female: number; child: number };
}

interface RawNote {
  midi: number;
  channel: number;
  start: number;
  end: number;
  velocity: number;
}

interface RawTrack {
  name: string;
  notes: RawNote[];
  /** lyric meta events, in file order (tick, text) */
  lyrics: [number, string][];
  /** text meta events other than "@" headers (a Soft Karaoke file's lyrics) */
  texts: [number, string][];
  /** program changes and channel volumes: (tick, channel, value) */
  programs: [number, number, number][];
  volumes: [number, number, number][];
}

interface TempoChange {
  tick: number;
  /** seconds per quarter from this tick on */
  spq: number;
}

const decoder = new TextDecoder();
const strict = new TextDecoder("utf-8", { fatal: true });
const latin = new TextDecoder("windows-1252");
/** text in UTF-8 if it is valid, else in the Windows Latin-1 most .kar files were written in */
function decodeText(data: Uint8Array): string {
  try {
    return strict.decode(data);
  } catch {
    return latin.decode(data);
  }
}

class MidiError extends Error {}

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function readVlq(bytes: Uint8Array, p: { i: number }): number {
  let v = 0;
  let b: number;
  do {
    if (p.i >= bytes.length) throw new MidiError("truncated MIDI file");
    b = bytes[p.i++];
    v = (v << 7) | (b & 0x7f);
  } while (b & 0x80);
  return v;
}

function readChunk(bytes: Uint8Array, p: { i: number }, id: string): Uint8Array {
  if (p.i + 8 > bytes.length || decoder.decode(bytes.subarray(p.i, p.i + 4)) !== id) throw new MidiError(`expected a ${id} chunk`);
  const len = view(bytes).getUint32(p.i + 4);
  const start = p.i + 8;
  if (start + len > bytes.length) throw new MidiError("truncated MIDI file");
  p.i = start + len;
  return bytes.subarray(start, start + len);
}

/** One MTrk chunk: notes paired by channel and pitch, lyrics, track name. */
function readTrack(bytes: Uint8Array, tempos: TempoChange[]): RawTrack {
  const p = { i: 0 };
  let tick = 0;
  let running = 0;
  const track: RawTrack = { name: "", notes: [], lyrics: [], texts: [], programs: [], volumes: [] };
  const open = new Map<number, [number, number]>(); // key: channel * 128 + pitch → onset tick, velocity
  while (p.i < bytes.length) {
    tick += readVlq(bytes, p);
    let status = bytes[p.i];
    if (status < 0x80) {
      if (!running) throw new MidiError("MIDI data byte without a status");
      status = running;
    } else {
      p.i++;
      if (status < 0xf0) running = status;
    }
    if (status === 0xff) {
      const type = bytes[p.i++];
      const len = readVlq(bytes, p);
      const data = bytes.subarray(p.i, p.i + len);
      p.i += len;
      if (type === 0x51 && len === 3) tempos.push({ tick, spq: ((data[0] << 16) | (data[1] << 8) | data[2]) / 1e6 });
      else if (type === 0x05) track.lyrics.push([tick, decodeText(data)]);
      else if (type === 0x01 && data[0] !== 0x40) track.texts.push([tick, decodeText(data)]);
      else if (type === 0x03 && !track.name) track.name = decoder.decode(data).trim();
      else if (type === 0x2f) break;
    } else if (status === 0xf0 || status === 0xf7) {
      p.i += readVlq(bytes, p); // skip the sysex payload
    } else {
      const kind = status & 0xf0;
      const channel = status & 0x0f;
      const two = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
      if (p.i + two > bytes.length) break;
      const d1 = bytes[p.i++];
      const d2 = two === 2 ? bytes[p.i++] : 0;
      if (kind === 0x90 && d2 > 0) open.set(channel * 128 + d1, [tick, d2]);
      else if (kind === 0x80 || kind === 0x90) {
        const key = channel * 128 + d1;
        const on = open.get(key);
        if (on !== undefined) {
          open.delete(key);
          track.notes.push({ midi: d1, channel, start: on[0], end: tick, velocity: on[1] });
        }
      } else if (kind === 0xc0) track.programs.push([tick, channel, d1]);
      else if (kind === 0xb0 && d1 === 7) track.volumes.push([tick, channel, d2]);
    }
  }
  // notes never released end at the track's last tick
  for (const [key, [start, velocity]] of open) track.notes.push({ midi: key % 128, channel: Math.floor(key / 128), start, end: tick, velocity });
  return track;
}

/** The melody track: the one with the most notes starting where a syllable does (from `tol`
 *  ticks before it to `lead` after: karaoke text is shown a little ahead of its note), the
 *  sparser on a tie; with no lyrics, the one with the most notes. */
function pickMelody(tracks: RawTrack[], ticks: number[], tol: number, lead: number): RawTrack {
  const withNotes = tracks.filter((t) => t.notes.some((n) => n.channel !== 9)); // channel 10 is drums
  if (!withNotes.length) throw new MidiError("no notes to sing in this file");
  let best = withNotes[0];
  let bestScore = -Infinity;
  for (const t of withNotes) {
    const starts = new Set(t.notes.filter((n) => n.channel !== 9).map((n) => n.start));
    let hits = 0;
    for (const tick of ticks) {
      for (let d = -tol; d <= lead; d++) {
        if (starts.has(tick + d)) {
          hits++;
          break;
        }
      }
    }
    const score = ticks.length ? hits * 1e6 - starts.size : starts.size;
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return best;
}

/** The syllable events (lyric events, else a Soft Karaoke file's text events), a lone "/" or
 *  space carried onto the next syllable. */
function syllableEvents(tracks: RawTrack[]): [number, string][] {
  const most = (key: "lyrics" | "texts") => tracks.reduce((a, t) => (t[key].length > a.length ? t[key] : a), [] as [number, string][]);
  const lyrics = most("lyrics");
  const texts = most("texts");
  const events = lyrics.length >= 4 || texts.length < 4 ? lyrics : texts;
  const out: [number, string][] = [];
  let pending = "";
  for (const [tick, raw] of events) {
    const s = raw.replace(/[\r\n]+/g, "/");
    if (!/[\p{L}\p{N}]/u.test(s)) {
      pending += s;
      continue;
    }
    out.push([tick, pending + s]);
    pending = "";
  }
  if (pending && out.length) out[out.length - 1][1] += pending;
  return out;
}

/** separators: where a word, or a line, ends */
const clean = (s: string) => s.replace(/[\s/\\]+/g, "").replace(/^-+|-+$/g, "");
/** a line or paragraph starts with this piece, or ends after it */
const startsLine = (s: string) => /^\s*[/\\]/.test(s);
const endsLine = (s: string) => /[/\\]\s*$/.test(s);
const punctuated = (s: string) => /[.,;:!?]$/.test(clean(s));

/** Pieces per note (null: the note holds the syllable before it) → words. */
function toWords(pieces: (string | null)[]): KarWord[] {
  const words: KarWord[] = [];
  let prev = "";
  for (const p of pieces) {
    const w = words[words.length - 1];
    if (p === null) {
      w?.slots.push(false);
      continue;
    }
    const newWord = !w || /^[\s/\\]/.test(p) || /[\s/\\]$/.test(prev) || punctuated(prev);
    if (newWord) {
      if (w && (startsLine(p) || endsLine(prev) || punctuated(prev))) w.phraseEnd = true;
      words.push({ parts: [clean(p)], slots: [true], phraseEnd: false });
    } else {
      w.parts.push(clean(p));
      w.slots.push(true);
    }
    prev = p;
  }
  if (words.length) words[words.length - 1].phraseEnd = true;
  return words;
}

/** One voice out of a track that may double the melody: of notes starting together (within
 *  `tol` ticks) keep the highest; a note that starts while another still sounds (legato) cuts it. */
function monophonize(notes: RawNote[], tol: number): RawNote[] {
  const kept: RawNote[] = [];
  for (const n of [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi)) {
    if (n.end <= n.start) continue;
    const last = kept[kept.length - 1];
    if (!last || n.start >= last.end) kept.push(n);
    else if (n.start - last.start > tol) {
      last.end = n.start;
      kept.push(n);
    } else if (n.midi > last.midi) kept[kept.length - 1] = { ...n, end: Math.max(n.end, last.end) };
    else last.end = Math.max(last.end, n.end);
  }
  return kept;
}

export function parseKaraoke(data: ArrayBuffer | Uint8Array, fileName?: string): KaraokeSong {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 14) throw new MidiError("too short to be a MIDI file");
  const p = { i: 0 };
  const head = readChunk(bytes, p, "MThd");
  if (head.length < 6) throw new MidiError("short MIDI header");
  const hv = view(head);
  const format = hv.getUint16(0);
  const ntrks = hv.getUint16(2);
  const division = hv.getUint16(4);
  if (format > 1) throw new MidiError("MIDI type 2 (a collection of tracks, not a song) is not supported");
  if (division & 0x8000) throw new MidiError("SMPTE-timed MIDI files are not supported");
  if (!division) throw new MidiError("zero time division in the MIDI header");

  const tempos: TempoChange[] = [];
  const tracks: RawTrack[] = [];
  for (let t = 0; t < ntrks && p.i < bytes.length; t++) tracks.push(readTrack(readChunk(bytes, p, "MTrk"), tempos));

  // the tempo in effect at the start: the last of the changes at the earliest tick (120 bpm if none)
  tempos.sort((a, b) => a.tick - b.tick);
  let spq0 = 0.5;
  if (tempos.length && tempos[0].tick === 0) {
    spq0 = tempos[0].spq;
    for (const t of tempos) {
      if (t.tick !== 0) break;
      spq0 = t.spq;
    }
  }
  const bpm = Math.min(300, Math.max(30, 60 / spq0));
  // ticks → seconds through every tempo change
  const marks: { tick: number; sec: number; spq: number }[] = [{ tick: 0, sec: 0, spq: 0.5 }];
  for (const t of tempos) {
    const m = marks[marks.length - 1];
    marks.push({ tick: t.tick, sec: m.sec + ((t.tick - m.tick) / division) * m.spq, spq: t.spq });
  }
  const seconds = (tick: number): number => {
    let m = marks[0];
    for (const x of marks) if (x.tick <= tick) m = x;
    return m.sec + ((tick - m.tick) / division) * m.spq;
  };

  const events = syllableEvents(tracks);
  const tol = Math.round(division / 8); // a 32nd note
  const lead = Math.round(division / 4); // a 16th
  const melody = pickMelody(tracks, events.map(([t]) => t), tol, lead);
  let notes = monophonize(melody.notes.filter((n) => n.channel !== 9), tol);
  if (!notes.length) throw new MidiError("no notes to sing in this file");

  // each syllable, in order, to the next free note starting from a 32nd before it to a beat
  // after (the text runs ahead of the music); with none that close, it joins the syllable before
  let words: KarWord[] | null = null;
  if (events.length) {
    const pieces: (string | null)[] = notes.map(() => null);
    let k = 0;
    let last = -1;
    for (const [tick, text] of events) {
      while (k < notes.length && notes[k].start < tick - tol) k++;
      if (k < notes.length && notes[k].start <= tick + division) {
        pieces[k] = text;
        last = k++;
      } else if (last >= 0) pieces[last] += text;
      else if (k < notes.length) pieces[(last = k++)] = text;
    }
    // notes before the first syllable are an intro; a note without one holds the syllable before
    // only when it follows straight on (within a beat), else it belongs to another part: left out
    const keep = pieces.map((p) => p !== null);
    let prev = -1;
    notes.forEach((n, i) => {
      if (keep[i]) prev = i;
      else if (prev >= 0 && n.start - notes[prev].end <= division) {
        keep[i] = true;
        prev = i;
      }
    });
    words = toWords(pieces.filter((_, i) => keep[i]));
    notes = notes.filter((_, i) => keep[i]);
  }

  // onsets as in the file, in beats (quarters, straight from the ticks); a gap longer than the
  // note's own length is kept only as a short release
  const release = 0.35 * (bpm / 60); // the release the singer leaves, in beats
  const beats: number[] = notes.map((n, i) => {
    const dur = (n.end - n.start) / division;
    if (i === notes.length - 1) return Math.min(Math.max(dur, 0.25), 4);
    const step = (notes[i + 1].start - n.start) / division;
    return Math.max(0.1, Math.min(step, dur + release));
  });
  const midis = notes.map((n) => n.midi).sort((a, b) => a - b);
  const median = midis[Math.floor(midis.length / 2)];
  const female = Math.round((62 - median) / 12) || 0; // into the adult female register, as the demos are
  // the band: every other track, each note with the channel's program and volume at its start
  const setting = (key: "programs" | "volumes", fallback: number) => {
    const all = tracks.flatMap((t) => t[key]).sort((a, b) => a[0] - b[0]);
    return (channel: number, tick: number): number => {
      let v = fallback;
      for (const [at, ch, x] of all) {
        if (at > tick) break;
        if (ch === channel) v = x;
      }
      return v;
    };
  };
  const program = setting("programs", 0);
  const volume = setting("volumes", 100);
  const band: BandNote[] = tracks
    .filter((t) => t !== melody)
    .flatMap((t) => t.notes)
    .filter((n) => n.end > n.start)
    .map((n) => ({ midi: n.midi, channel: n.channel, program: program(n.channel, n.start), velocity: n.velocity / 127, volume: volume(n.channel, n.start) / 127, start: seconds(n.start), end: seconds(n.end) }))
    .sort((a, b) => a.start - b.start);

  return {
    name: (fileName ?? "Imported song").replace(/\.(mid|midi|kar)$/i, ""),
    bpm,
    lyrics: words ? words.map((w) => w.parts.join("-") + (w.phraseEnd ? "," : "")).join(" ").replace(/,$/, ".") : "",
    notes: notes.map((n, i) => [n.midi, beats[i]]),
    words,
    times: notes.map((n) => [seconds(n.start), seconds(n.end)]),
    band,
    octave: { male: female - 1, female, child: female },
  };
}

/**
 * One syllable per note of an imported song. A word is read whole (its stress and vowels from
 * the dictionary) when that gives as many syllables as the file has pieces for it, else piece
 * by piece; still off, it is cut or held to fit. A note without a piece holds the vowel before.
 */
export function karaokeSyllables(words: KarWord[], read: (text: string) => Syllable[]): Syllable[] {
  const out: Syllable[] = [];
  for (const w of words) {
    const n = w.parts.length;
    let syl = read(w.parts.join(""));
    if (syl.length !== n) syl = read(w.parts.join("-"));
    if (!syl.length) syl = [{ text: w.parts.join(""), onset: [], nucleus: { ipa: "a", stress: 1 }, coda: [], wordEnd: true, phraseEnd: false }];
    syl = syl.slice(0, n).map((s, i) => ({ ...s, wordEnd: i === n - 1, phraseEnd: false }));
    let k = 0;
    for (const isNew of w.slots) {
      const prev = out[out.length - 1];
      if (isNew && k < syl.length) out.push(syl[k++]);
      else if (prev) out.push({ text: "~", onset: [], nucleus: prev.nucleus, coda: [], melisma: true, wordEnd: prev.wordEnd, phraseEnd: false });
      else out.push(syl[0]);
    }
    out[out.length - 1].wordEnd = true;
    out[out.length - 1].phraseEnd = w.phraseEnd;
  }
  return out;
}

/** a gap this long between sung notes is a rest: the singer breathes and starts a new stretch */
const REST = 0.25;

/** The stretches of notes sung without a rest, as [first, end) indices into `times` (s). */
export function singingSpans(times: [number, number][]): [number, number][] {
  const spans: [number, number][] = [];
  let a = 0;
  for (let i = 1; i <= times.length; i++) {
    if (i === times.length || times[i][0] - times[i - 1][1] > REST) {
      spans.push([a, i]);
      a = i;
    }
  }
  return times.length ? spans : [];
}
