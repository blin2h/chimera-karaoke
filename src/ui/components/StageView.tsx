/**
 * The karaoke stage in 3D, drawn like the head: glowing lines on black (the same beams kit,
 * max-blended, fog-dimmed with depth), no solids, no lights. A platform outline with a faint
 * grid, the lead singer at the front, and each performer of the band as a line drawing of its
 * instrument where `performers()` placed it, labelled. A performer brightens and thickens while
 * its channel sounds (drums flash on each hit); the singer while the voice sings. Drag to orbit,
 * wheel to zoom, double-click to go back to the audience's view. Fills its parent, which needs a
 * definite height.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FAMILY_LABEL, type Family } from "../../audio/gm.ts";
import { V } from "../colors.ts";
import { Beams } from "../render/beams3d.ts";
import { LISTENER, SINGER, type Performer } from "../stage.ts";
import type { BandNote } from "../karaoke.ts";

const FAMILY_COLOR: Record<Family, string> = {
  drums: V.red, bass: V.blue, piano: V.white, chromatic: V.white, organ: V.white, guitar: V.amber, ethnic: V.amber,
  strings: V.pink, ensemble: V.pink, brass: V.green, reed: V.green, pipe: V.green,
  lead: V.blue, pad: V.blue, fx: V.blue, sfx: V.blue, percussive: V.red,
};
const HOME = new THREE.Vector3(LISTENER.x, LISTENER.y + 9, LISTENER.z - 1.5);
const TARGET = new THREE.Vector3(0, 0.5, -2.8);

// ---- line drawings, in metres, facing +z (the audience), standing on y = 0
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
/** a person, simply: head, body, arms */
const person = (s: number): Shape => [
  upright(0, 1.55 * s, 0, 0.15 * s, 16),
  [-0.12 * s, 0, 0, -0.08 * s, 0.75 * s, 0, 0, 1.38 * s, 0, 0.08 * s, 0.75 * s, 0, 0.12 * s, 0, 0],
  [-0.32 * s, 0.85 * s, 0.05, -0.2 * s, 1.15 * s, 0, 0, 1.3 * s, 0, 0.2 * s, 1.15 * s, 0, 0.32 * s, 0.85 * s, 0.05],
];
/** a guitar-like body outline, upright, rotated by `tilt`, neck of length `neck` */
function stringed(scale: number, neck: number, tilt: number, h: number): Shape {
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const r = ([x, y]: [number, number]): [number, number, number] => [x * c - y * s, h + x * s + y * c, 0];
  const body: number[] = [];
  for (let i = 0; i <= 32; i++) {
    const a = (2 * Math.PI * i) / 32;
    // a waisted outline: wide below, narrower above
    const y = 0.32 * scale * Math.sin(a);
    const w = (0.2 + 0.07 * Math.cos(2 * a) - 0.05 * Math.sin(a)) * scale;
    body.push(...r([w * Math.cos(a), y]));
  }
  return [body, [...r([-0.03, 0.3 * scale]), ...r([-0.03, 0.3 * scale + neck]), ...r([0.03, 0.3 * scale + neck]), ...r([0.03, 0.3 * scale])], [...r([0, -0.25 * scale]), ...r([0, 0.3 * scale + neck])]];
}

function drawing(family: Family, voice: boolean): Shape {
  if (voice) return person(0.85);
  switch (family) {
    case "drums":
      return [
        upright(0, 0.38, 0.1, 0.36), upright(0, 0.38, -0.25, 0.36), seg(-0.36, 0.38, 0.1, -0.36, 0.38, -0.25), seg(0.36, 0.38, 0.1, 0.36, 0.38, -0.25),
        ...drum(-0.45, 0.62, 0.1, 0.18, 0.18), ...drum(0.4, 0.66, 0.05, 0.2, 0.2), ...drum(0.75, 0.45, 0.3, 0.24, 0.3),
        flat(-0.8, 1.12, -0.05, 0.3), flat(0.95, 1.2, -0.2, 0.32), ...stand(-0.8, -0.05, 1.12), ...stand(0.95, -0.2, 1.2),
      ];
    case "piano":
    case "organ":
    case "chromatic": {
      const keys = Array.from({ length: 14 }, (_, k) => seg(-0.6 + k * 0.0923, 0.91, 0.22, -0.6 + k * 0.0923, 0.91, 0.06));
      return [...box(0, 0.85, 0, 1.3, 0.12, 0.45), ...keys, seg(-0.55, 0, 0, -0.55, 0.79, 0), seg(0.55, 0, 0, 0.55, 0.79, 0), ...(family === "organ" ? box(0, 1.15, -0.18, 1.3, 0.5, 0.08) : [])];
    }
    case "guitar":
    case "ethnic":
      return [...stringed(1, 0.55, -0.45, 0.9), ...stand(0.05, -0.05, 0.6)];
    case "bass":
      return [...stringed(1.05, 0.8, -0.4, 0.85), ...stand(0.05, -0.05, 0.55)];
    case "strings":
    case "ensemble":
      return [...stringed(1.6, 0.55, 0, 0.62), seg(0, 0, 0, 0, 0.12, 0), seg(-0.3, 0.55, 0.15, 0.35, 0.95, 0.15)]; // a cello, its bow
    case "brass":
    case "reed":
    case "pipe":
      // a bell on a stand: the bell's ring, its flare to the mouthpiece
      return [upright(0.35, 1.0, 0.1, 0.17), ...[0, 1.571, 3.142, 4.712].map((a) => seg(0.35 + 0.17 * Math.cos(a), 1.0 + 0.17 * Math.sin(a), 0.1, -0.35, 1.0, 0.1)), seg(-0.35, 1.0, 0.1, -0.45, 1.05, 0.1), ...stand(0, 0.1, 0.95)];
    case "percussive":
      return [...drum(-0.22, 0.55, 0, 0.17, 0.25), ...drum(0.2, 0.55, 0, 0.2, 0.25), ...stand(0, 0, 0.55)];
    default:
      // a synth on an X stand
      return [...box(0, 0.95, 0, 1.0, 0.08, 0.35), seg(-0.4, 0, 0.12, 0.4, 0.9, -0.12), seg(0.4, 0, 0.12, -0.4, 0.9, -0.12), ...Array.from({ length: 10 }, (_, k) => seg(-0.45 + k * 0.1, 1.0, 0.16, -0.45 + k * 0.1, 1.0, 0.03))];
  }
}

/** the singer: a person behind a mic stand */
const SINGER_DRAWING: Shape = [...person(1), seg(0, 0, 0.42, 0, 1.38, 0.42), seg(0, 1.38, 0.42, 0, 1.45, 0.3), upright(0, 1.47, 0.28, 0.04, 10), ...stand(0, 0.42, 0.12)];

/** a two-line label (instrument, family) on a canvas texture */
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

/** per channel, its notes and a cursor that only moves forward while the clock does */
interface Lane {
  notes: BandNote[];
  i: number;
  drums: boolean;
}

/** how lit a lane is at song time t: 1 while a note sounds, a quick flash for a drum hit */
function level(lane: Lane, t: number): number {
  const n = lane.notes;
  while (lane.i > 0 && n[lane.i - 1].end > t) lane.i--; // the clock went back (a new song or a seek)
  while (lane.i < n.length && n[lane.i].end <= t) lane.i++;
  let lit = 0;
  for (let k = lane.i; k < n.length && n[k].start <= t; k++) {
    if (n[k].end <= t) continue;
    lit = lane.drums ? Math.max(lit, Math.exp(-(t - n[k].start) / 0.12)) : 1;
    if (!lane.drums) break;
  }
  // a drum hit shorter than a frame still flashes: the last hit before t
  if (lane.drums && lane.i > 0) lit = Math.max(lit, Math.exp(-(t - n[lane.i - 1].start) / 0.12));
  return lit;
}

/** drawings are drawn larger than life, to read from the audience */
const SCALE = 1.4;

/** a drawing placed on the stage: scaled, turned to face the listener, moved to (x, z) */
function place(shape: Shape, x: number, z: number): Float32Array[] {
  const a = Math.atan2(LISTENER.x - x, LISTENER.z - z);
  const c = Math.cos(a), s = Math.sin(a);
  return shape.map((l) => {
    const out = new Float32Array(l.length);
    for (let i = 0; i < l.length; i += 3) {
      out[i] = x + SCALE * (l[i] * c + l[i + 2] * s);
      out[i + 1] = SCALE * l[i + 1];
      out[i + 2] = z + SCALE * (-l[i] * s + l[i + 2] * c);
    }
    return out;
  });
}

export function StageView(props: { performers: Performer[]; notes: BandNote[]; time: () => number | null; singerActive: () => boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef(props.time);
  timeRef.current = props.time;
  const singerRef = useRef(props.singerActive);
  singerRef.current = props.singerActive;
  const [failed, setFailed] = useState(false);
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
    // the view from the audience: back along HOME's direction until the performers and their
    // labels fit the frame, whatever the screen's shape
    const xs = [SINGER.x, ...performers.map((p) => p.x)];
    const zs = [SINGER.z, ...performers.map((p) => p.z)];
    const [x0, x1, z0] = [Math.min(...xs) - 1.4, Math.max(...xs) + 1.4, Math.min(...zs) - 1];
    const corners = [x0, x1].flatMap((x) => [0.4, z0].flatMap((z) => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 3.1 - z * 0.22, z)]));
    const dir = HOME.clone().sub(TARGET).normalize();
    const fit = (target: THREE.Vector3) => {
      for (let d = 4; d <= 30; d += 0.25) {
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
    const floor: Float32Array[] = [new Float32Array([-7, 0, 0, 7, 0, 0, 7, 0, -8, -7, 0, -8, -7, 0, 0]), new Float32Array([-7, -0.4, 0, 7, -0.4, 0]), new Float32Array([-7, 0, 0, -7, -0.4, 0]), new Float32Array([7, 0, 0, 7, -0.4, 0])];
    const grid: Float32Array[] = [];
    for (let x = -6; x <= 6; x++) grid.push(new Float32Array([x, 0, 0, x, 0, -8]));
    for (let z = -1; z >= -7; z--) grid.push(new Float32Array([-7, 0, z, 7, 0, z]));

    const singer = place(SINGER_DRAWING, SINGER.x, SINGER.z);
    const singerLabel = label("Voce", "Solista", V.amber);
    singerLabel.position.set(SINGER.x, 2.75, SINGER.z);
    scene.add(singerLabel);

    // the band
    const lanes = new Map<number, Lane>();
    for (const n of notes) {
      const l = lanes.get(n.channel) ?? { notes: [], i: 0, drums: n.channel === 9 };
      l.notes.push(n);
      lanes.set(n.channel, l);
    }
    // labels rise toward the back, and neighbours take turns a step higher, so none hides another
    const lit = performers.map((p, k) => {
      const color = FAMILY_COLOR[p.family];
      const tag = label(p.name, p.voice ? "Voce" : FAMILY_LABEL[p.family], color);
      tag.position.set(p.x, 2.4 - p.z * 0.22 + (k % 2) * 0.42, p.z);
      scene.add(tag);
      return { lines: place(drawing(p.family, p.voice), p.x, p.z), color, lane: lanes.get(p.channel), glow: 0 };
    });

    const resize = () => {
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      gl.setSize(w, h);
      beams.setResolution(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      reset();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    let raf = 0;
    let singerGlow = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const t = timeRef.current();
      beams.begin();
      for (const l of floor) beams.line(l, l.length / 3, V.blueMid, 1.05);
      for (const l of grid) beams.line(l, 2, V.blueDim, 0.6, { alpha: 0.45 });
      for (const p of lit) {
        // light comes on at once and fades out
        p.glow = Math.max(t === null || !p.lane ? 0 : level(p.lane, t), p.glow * 0.88);
        for (const l of p.lines) beams.line(l, l.length / 3, p.color, 0.85 + 0.9 * p.glow, { alpha: 0.4 + 0.6 * p.glow, hot: p.glow > 0.5 });
      }
      singerGlow = Math.max(singerRef.current() ? 1 : 0, singerGlow * 0.9);
      for (const l of singer) beams.line(l, l.length / 3, V.amber, 1.05 + 0.8 * singerGlow, { alpha: 0.55 + 0.45 * singerGlow, hot: singerGlow > 0.5 });
      beams.end();
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

  const names = ["Voce", ...performers.map((p) => p.name)].join(", ");
  if (failed) return <p className="stage-fallback">Il palco 3D non è disponibile (WebGL spento). Suonano: {names}.</p>;
  return <div ref={wrapRef} role="img" aria-label={`Palco: ${names}`} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }} />;
}
