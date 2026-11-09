/**
 * General MIDI: what each program number is, and the families of eight it comes in. A MIDI file
 * names its instruments only by these numbers (channel 10 is always the drum kit), so this is
 * how the karaoke stage knows who plays what.
 */

/** the 128 General MIDI Level 1 program names */
export const GM_PROGRAMS: readonly string[] = [
  "Acoustic Grand Piano", "Bright Acoustic Piano", "Electric Grand Piano", "Honky-tonk Piano", "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet",
  "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone", "Tubular Bells", "Dulcimer",
  "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ", "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
  "Acoustic Guitar (nylon)", "Acoustic Guitar (steel)", "Electric Guitar (jazz)", "Electric Guitar (clean)", "Electric Guitar (muted)", "Overdriven Guitar", "Distortion Guitar", "Guitar Harmonics",
  "Acoustic Bass", "Electric Bass (finger)", "Electric Bass (pick)", "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
  "Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings", "Pizzicato Strings", "Orchestral Harp", "Timpani",
  "String Ensemble 1", "String Ensemble 2", "Synth Strings 1", "Synth Strings 2", "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
  "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn", "Brass Section", "Synth Brass 1", "Synth Brass 2",
  "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax", "Oboe", "English Horn", "Bassoon", "Clarinet",
  "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle", "Shakuhachi", "Whistle", "Ocarina",
  "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)", "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass + lead)",
  "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)", "Pad 5 (bowed)", "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)",
  "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)", "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)",
  "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
  "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko Drum", "Melodic Tom", "Synth Drum", "Reverse Cymbal",
  "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet", "Telephone Ring", "Helicopter", "Applause", "Gunshot",
];

export type Family =
  | "piano" | "chromatic" | "organ" | "guitar" | "bass" | "strings" | "ensemble" | "brass"
  | "reed" | "pipe" | "lead" | "pad" | "fx" | "ethnic" | "percussive" | "sfx" | "drums";

const FAMILIES: Family[] = ["piano", "chromatic", "organ", "guitar", "bass", "strings", "ensemble", "brass", "reed", "pipe", "lead", "pad", "fx", "ethnic", "percussive", "sfx"];

/** the family's name on the stage (Italian, as the player's first language) */
export const FAMILY_LABEL: Record<Family, string> = {
  piano: "Pianoforte", chromatic: "Percussioni intonate", organ: "Organo", guitar: "Chitarra", bass: "Basso", strings: "Archi", ensemble: "Ensemble",
  brass: "Ottoni", reed: "Ance", pipe: "Flauti", lead: "Synth solista", pad: "Synth pad", fx: "Effetti synth", ethnic: "Etnici",
  percussive: "Percussioni", sfx: "Effetti", drums: "Batteria",
};

export const DRUM_CHANNEL = 9;

/** The family a channel's program belongs to (the drum kit on channel 10). */
export function familyOf(channel: number, program: number): Family {
  return channel === DRUM_CHANNEL ? "drums" : FAMILIES[Math.min(15, Math.max(0, Math.floor(program / 8)))];
}

/** The instrument's name: the General MIDI program's, or the kit's. */
export function instrumentName(channel: number, program: number): string {
  return channel === DRUM_CHANNEL ? "Drum Kit" : (GM_PROGRAMS[program] ?? `Program ${program}`);
}

/** Programs that are voices, not instruments: a choir ("aah", "ooh"), a synth or lead voice. */
export function isVoiceProgram(program: number): boolean {
  return program === 52 || program === 53 || program === 54 || program === 85 || program === 91;
}
