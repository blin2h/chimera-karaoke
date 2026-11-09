/**
 * The karaoke player (`?karaoke`, CHIMERA v2): open a folder of MIDI / .kar files from your
 * computer and the voice sings them, its head in 3D, over the file's band placed on a concert
 * stage (each instrument where a band would stand, and heard from there). The lyrics run below,
 * the syllable being sung lit. Files are read in the browser and never leave the computer.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { PRESETS, presetOf } from "../body.ts";
import { useLang } from "../speech.ts";
import { parseKaraoke, type KaraokeSong } from "../karaoke.ts";
import { performers, LISTENER, type Performer } from "../stage.ts";
import { playImported, stopSinging, tickSinging, useSing, setBandLevel, bandTime } from "../singing.ts";
import { engine } from "../../audio/AudioEngine.ts";
import { FAMILY_LABEL } from "../../audio/gm.ts";
import { AnatomyView3D } from "./AnatomyView3D.tsx";
import { StageView } from "./StageView.tsx";
import { Screen } from "./Screen.tsx";
import type { Syllable } from "../../wasm/types.ts";

const SONG_FILE = /\.(kar|midi?)$/i;
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(Math.max(0, t) % 60)).padStart(2, "0")}`;
const title = (f: File) => f.name.replace(SONG_FILE, "").replace(/[_]+/g, " ");

interface Loaded {
  file: File;
  song: KaraokeSong;
  cast: Performer[];
}

export function KaraokePage() {
  const [files, setFiles] = useState<File[]>([]);
  const [filter, setFilter] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const demo = useSing((s) => s.demo);
  const band = useSing((s) => s.band);
  const setBand = useSing((s) => s.setBand);
  const lang = useLang((s) => s.lang);
  const setLang = useLang((s) => s.setLang);
  const body = useStore((s) => s.body);
  const setBody = useStore((s) => s.setBody);
  const volume = useStore((s) => s.volume);
  const setVolume = useStore((s) => s.setVolume);
  const start = useStore((s) => s.start);
  const [bandLevel, setLevel] = useState(0.8);
  const playing = demo !== null && loaded !== null && demo === loaded.song.name;

  // the lyrics' highlight and the clock follow the voice every frame
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      tickSinging();
      if (now - last > 250) {
        last = now;
        setTick((n) => n + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      stopSinging();
    };
  }, []);

  const addFiles = (list: FileList | File[] | null) => {
    const songs = [...(list ?? [])].filter((f) => SONG_FILE.test(f.name));
    if (!songs.length) return;
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...songs.filter((f) => !seen.has(f.name + f.size))].sort((a, b) => title(a).localeCompare(title(b), "it"));
    });
  };

  const play = async (file: File) => {
    try {
      const song = parseKaraoke(await file.arrayBuffer(), file.name);
      const cast = performers(song.band);
      setLoaded({ file, song, cast });
      setError(null);
      const positions = new Map(cast.map((p) => [p.channel, { x: p.x, z: p.z }]));
      await playImported(song, body, start, { positions, listener: LISTENER });
    } catch (e) {
      setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.name.toLowerCase().includes(q)) : files;
  }, [files, filter]);
  const index = loaded ? files.indexOf(loaded.file) : -1;
  const t = bandTime();
  const length = loaded ? Math.max(loaded.song.times.at(-1)?.[1] ?? 0, loaded.song.band.at(-1)?.end ?? 0) : 0;

  return (
    <div
      className="karaoke"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        addFiles(e.dataTransfer.files);
      }}
    >
      <header className="karaoke-top">
        <span className="wordmark">Chimera</span>
        <span className="karaoke-title">{loaded ? title(loaded.file) : "Karaoke"}</span>
        <div className="karaoke-tools" role="group" aria-label="Song settings">
          <ChipGroup label="Lingua del testo" value={lang} options={[["it", "IT"], ["en", "EN"]]} onChange={(v) => setLang(v as "it" | "en")} />
          <ChipGroup
            label="Voce"
            value={presetOf(body) ?? ""}
            options={[["male", "Uomo"], ["female", "Donna"], ["child", "Bambino"]]}
            onChange={(v) => setBody(PRESETS[v as keyof typeof PRESETS])}
          />
          <button type="button" className={`chip${band ? " on" : ""}`} aria-pressed={band} onClick={() => setBand(!band)} title="Suona anche gli strumenti del file (dal prossimo brano)">
            Strumenti
          </button>
          <Level label="Voce" value={volume} max={1.2} onChange={setVolume} />
          <Level
            label="Base"
            value={bandLevel}
            max={1.5}
            onChange={(v) => {
              setLevel(v);
              setBandLevel(v);
            }}
          />
        </div>
      </header>

      <main className="karaoke-main">
        <Screen className="karaoke-list" title="Brani" sub={files.length ? `${files.length}` : undefined}>
          <div className="karaoke-open">
            <label className="chip">
              <input type="file" hidden {...{ webkitdirectory: "" }} multiple onChange={(e) => addFiles(e.currentTarget.files)} />
              Apri cartella
            </label>
            <label className="chip">
              <input type="file" hidden multiple accept=".kar,.mid,.midi,audio/midi" onChange={(e) => addFiles(e.currentTarget.files)} />
              Aggiungi file
            </label>
          </div>
          {files.length > 0 && <input className="karaoke-filter" type="search" placeholder="Cerca" aria-label="Cerca un brano" value={filter} onChange={(e) => setFilter(e.target.value)} />}
          {files.length === 0 ? (
            <p className="karaoke-hint">Apri la cartella con i tuoi .kar e .mid, o trascinali qui. I file restano sul tuo computer.</p>
          ) : (
            <ol className="karaoke-songs">
              {shown.map((f) => (
                <li key={f.name + f.size}>
                  <button type="button" className={loaded?.file === f ? "now" : ""} onClick={() => void play(f)}>
                    {title(f)}
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Screen>

        <Screen className="karaoke-stage" focus title="Palco" sub={loaded ? cast(loaded.cast) : undefined}>
          {loaded ? (
            <StageView performers={loaded.cast} notes={loaded.song.band} time={bandTime} singerActive={() => (engine.latest?.t.outRms ?? 0) > 0.01} />
          ) : (
            <p className="karaoke-hint">Scegli un brano: la band sale sul palco, ogni strumento al suo posto.</p>
          )}
        </Screen>

        <Screen className="karaoke-head" title="Voce" sub={presetOf(body) ? { male: "Uomo", female: "Donna", child: "Bambino" }[presetOf(body)!] : undefined}>
          <AnatomyView3D readouts={false} />
        </Screen>
      </main>

      <footer className="karaoke-bottom">
        <Lyrics />
        <div className="karaoke-transport">
          <button type="button" className="primary large" disabled={!loaded && !files.length} onClick={() => (playing ? stopSinging() : void play(loaded?.file ?? files[0]))}>
            {playing ? "Stop" : "Canta"}
          </button>
          <button type="button" className="ghost" disabled={index < 0 || index + 1 >= files.length} onClick={() => void play(files[index + 1])}>
            Prossimo
          </button>
          <span className="karaoke-time">{playing && t !== null ? `${clock(t)} / ${clock(length)}` : loaded ? clock(length) : ""}</span>
          {error && (
            <span className="karaoke-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}

/** "Batteria, Basso, Pianoforte…": the stage's families, once each */
const cast = (ps: Performer[]) => [...new Set(ps.map((p) => (p.voice ? "Coro" : FAMILY_LABEL[p.family])))].join(" · ");

function ChipGroup(props: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="karaoke-chips" role="group" aria-label={props.label}>
      {props.options.map(([v, text]) => (
        <button key={v} type="button" className={`chip${props.value === v ? " on" : ""}`} aria-pressed={props.value === v} onClick={() => props.onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Level(props: { label: string; value: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="karaoke-level">
      <span>{props.label}</span>
      <input type="range" min={0} max={props.max} step={0.01} value={props.value} aria-label={`Volume ${props.label.toLowerCase()}`} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

/** The lyrics as lines (a breath ends one), the current line and the next, the sung syllable lit. */
function Lyrics() {
  const syllables = useSing((s) => s.syllables);
  const at = useSing((s) => s.demoAt);
  const demo = useSing((s) => s.demo);
  const lines = useMemo(() => toLines(syllables), [syllables]);
  if (!demo) return <div className="karaoke-lyrics" aria-live="off" />;
  const li = Math.max(0, lines.findIndex((l) => at >= l.from && at < l.from + l.syl.length));
  return (
    <div className="karaoke-lyrics" aria-live="off">
      {lines.slice(li, li + 2).map((l, k) => (
        <p key={l.from} className={k === 0 ? "line now" : "line next"}>
          {l.syl.map((s, i) => {
            const n = l.from + i;
            if (s.melisma) return null;
            return (
              <span key={n} className={n === at ? "on" : n < at ? "sung" : ""}>
                {s.text}
                {s.wordEnd ? " " : ""}
              </span>
            );
          })}
        </p>
      ))}
    </div>
  );
}

function toLines(syl: Syllable[]): { from: number; syl: Syllable[] }[] {
  const out: { from: number; syl: Syllable[] }[] = [];
  let from = 0;
  syl.forEach((s, i) => {
    if (s.phraseEnd || i === syl.length - 1) {
      out.push({ from, syl: syl.slice(from, i + 1) });
      from = i + 1;
    }
  });
  return out;
}
