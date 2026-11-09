/**
 * A small General MIDI band in Web Audio for an imported song's accompaniment: one filtered
 * oscillator per note, shaped by its program's family (piano, organ, strings…), and a kit
 * synthesized from noise and sine sweeps on channel 10. Notes are scheduled a little ahead as the
 * song plays, so a long file never creates all its nodes at once.
 * ponytail: oscillator timbres, not samples; a SoundFont player if they ever need to sound real.
 */
import type { BandNote } from "../ui/karaoke.ts";

interface Timbre {
  wave: OscillatorType;
  /** seconds */
  attack: number;
  /** time to fall toward `sustain` (s) */
  decay: number;
  /** level held while the key is down, 0–1 (0: percussive) */
  sustain: number;
  release: number;
  /** lowpass cutoff (Hz) */
  cutoff: number;
  level: number;
}

const t = (wave: OscillatorType, attack: number, decay: number, sustain: number, release: number, cutoff: number, level = 1): Timbre => ({ wave, attack, decay, sustain, release, cutoff, level });

/** one timbre per General MIDI family of eight programs */
const FAMILIES: Timbre[] = [
  t("triangle", 0.004, 1.4, 0, 0.2, 4000), // piano
  t("sine", 0.002, 0.6, 0, 0.3, 6000), // chromatic percussion
  t("square", 0.01, 0.1, 1, 0.06, 2200, 0.6), // organ
  t("sawtooth", 0.004, 1.2, 0, 0.15, 2600, 0.8), // guitar
  t("triangle", 0.006, 0.4, 0.7, 0.08, 900, 1.4), // bass
  t("sawtooth", 0.12, 0.3, 0.85, 0.35, 2400, 0.7), // strings
  t("sawtooth", 0.15, 0.3, 0.85, 0.4, 2000, 0.7), // ensemble
  t("sawtooth", 0.04, 0.2, 0.8, 0.12, 1800, 0.8), // brass
  t("square", 0.04, 0.2, 0.8, 0.1, 2400, 0.6), // reed
  t("triangle", 0.05, 0.2, 0.85, 0.15, 3000, 0.9), // pipe
  t("sawtooth", 0.01, 0.2, 0.8, 0.1, 3000, 0.6), // synth lead
  t("sawtooth", 0.3, 0.5, 0.8, 0.6, 1600, 0.6), // synth pad
  t("triangle", 0.1, 0.5, 0.6, 0.5, 2500, 0.6), // synth effects
  t("sawtooth", 0.004, 0.9, 0, 0.2, 2800, 0.8), // ethnic
  t("sine", 0.002, 0.4, 0, 0.1, 5000), // percussive
  t("triangle", 0.05, 0.5, 0.5, 0.3, 2000, 0.4), // sound effects
];

export const timbre = (program: number): Timbre => FAMILIES[Math.min(15, Math.max(0, Math.floor(program / 8)))];

/** overall level of one note at full velocity and volume: headroom for a dozen at once */
const NOTE = 0.1;

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();
function noise(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseBuffers.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuffers.set(ctx, b);
  }
  return b;
}

/** a decaying envelope from `peak` at t0 */
function hit(ctx: BaseAudioContext, peak: number, t0: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, t0);
  g.gain.setTargetAtTime(0, t0, decay / 4);
  return g;
}

function noiseHit(ctx: BaseAudioContext, out: AudioNode, t0: number, peak: number, type: BiquadFilterType, freq: number, decay: number): void {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  src.connect(f).connect(hit(ctx, peak, t0, decay)).connect(out);
  src.start(t0, Math.random() * 0.5);
  src.stop(t0 + decay * 1.5);
}

function toneHit(ctx: BaseAudioContext, out: AudioNode, t0: number, peak: number, from: number, to: number, decay: number): void {
  const osc = ctx.createOscillator();
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(to, t0 + decay * 0.4);
  osc.connect(hit(ctx, peak, t0, decay)).connect(out);
  osc.start(t0);
  osc.stop(t0 + decay * 1.5);
}

/** General MIDI percussion key → a synthesized drum */
function drum(ctx: BaseAudioContext, out: AudioNode, n: BandNote, t0: number): void {
  const v = NOTE * 2.5 * n.velocity * n.volume;
  const k = n.midi;
  if (k === 35 || k === 36) toneHit(ctx, out, t0, v * 1.6, 130, 45, 0.35); // kick
  else if (k === 38 || k === 40 || k === 37 || k === 39) {
    noiseHit(ctx, out, t0, v * 0.8, "highpass", 1500, 0.18); // snare, rim, clap
    toneHit(ctx, out, t0, v * 0.5, 220, 160, 0.1);
  } else if (k === 42 || k === 44) noiseHit(ctx, out, t0, v * 0.4, "highpass", 7000, 0.06); // closed hat
  else if (k === 46) noiseHit(ctx, out, t0, v * 0.4, "highpass", 7000, 0.35); // open hat
  else if (k === 49 || k === 52 || k === 55 || k === 57) noiseHit(ctx, out, t0, v * 0.45, "highpass", 5000, 1.2); // crash
  else if (k === 51 || k === 53 || k === 59) noiseHit(ctx, out, t0, v * 0.3, "bandpass", 6000, 0.6); // ride
  else if (k >= 41 && k <= 50) toneHit(ctx, out, t0, v, 80 + (k - 41) * 18, 60 + (k - 41) * 12, 0.3); // toms
  else noiseHit(ctx, out, t0, v * 0.3, "bandpass", 3000, 0.1); // shakers, cowbell, the rest
}

function note(ctx: BaseAudioContext, out: AudioNode, n: BandNote, at: number): void {
  const t0 = at + n.start;
  if (n.channel === 9) return drum(ctx, out, n, t0);
  const tb = timbre(n.program);
  const t1 = Math.max(at + n.end, t0 + tb.attack);
  const peak = NOTE * tb.level * n.velocity * n.volume;
  const osc = ctx.createOscillator();
  osc.type = tb.wave;
  osc.frequency.value = 440 * 2 ** ((n.midi - 69) / 12);
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = tb.cutoff;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + tb.attack);
  g.gain.setTargetAtTime(peak * tb.sustain, t0 + tb.attack, tb.decay / 4);
  g.gain.setTargetAtTime(0, t1, tb.release / 4);
  osc.connect(f).connect(g).connect(out);
  osc.start(t0);
  osc.stop(t1 + tb.release * 2);
}

/** A band playing: its clock in song seconds (negative before it starts), its level, its stop. */
export interface BandControl {
  time(): number;
  setLevel(level: number): void;
  stop(): void;
}

/** where each channel sits on the stage (m; see src/ui/stage.ts), and where the audience listens */
export interface BandSpace {
  positions: Map<number, { x: number; z: number }>;
  listener: { x: number; y: number; z: number };
}

/** Play `notes` (song seconds) with song time 0 at context time `at`; with `space`, each channel
 *  sounds from its place on the stage (HRTF panning), the listener out front. */
export function playBand(ctx: AudioContext, out: AudioNode, notes: BandNote[], at: number, space?: BandSpace): BandControl {
  const bus = ctx.createGain();
  bus.gain.value = 0.8;
  bus.connect(out);
  const channels = new Map<number, AudioNode>();
  if (space) {
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = space.listener.x;
      l.positionY.value = space.listener.y;
      l.positionZ.value = space.listener.z;
      l.forwardX.value = 0;
      l.forwardY.value = 0;
      l.forwardZ.value = -1;
    } else l.setPosition(space.listener.x, space.listener.y, space.listener.z);
  }
  // a channel's way to the bus: through its panner when it has a place
  const route = (channel: number): AudioNode => {
    let node = channels.get(channel);
    if (!node) {
      const pos = space?.positions.get(channel);
      if (pos) {
        const p = new PannerNode(ctx, { panningModel: "HRTF", distanceModel: "inverse", refDistance: 4, rolloffFactor: 0.6, positionX: pos.x, positionY: 1.2, positionZ: pos.z });
        p.connect(bus);
        node = p;
      } else node = bus;
      channels.set(channel, node);
    }
    return node;
  };
  let i = 0;
  const pump = () => {
    const horizon = ctx.currentTime + 0.6;
    while (i < notes.length && at + notes[i].start < horizon) {
      const n = notes[i++];
      if (at + n.end > ctx.currentTime) note(ctx, route(n.channel), n, at);
    }
    if (i >= notes.length) clearInterval(timer);
  };
  const timer = setInterval(pump, 150);
  pump();
  return {
    time: () => ctx.currentTime - at,
    setLevel: (level) => bus.gain.setTargetAtTime(level, ctx.currentTime, 0.05),
    stop: () => {
      clearInterval(timer);
      bus.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
      setTimeout(() => bus.disconnect(), 400);
    },
  };
}
