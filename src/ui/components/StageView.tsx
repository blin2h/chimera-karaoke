/**
 * The karaoke stage in 3D: a platform, the lead singer at the front, and one low-poly prop per
 * performer of the band where `performers()` placed it, each labelled with its instrument. A
 * performer glows while its channel sounds (drums flash on each hit); the singer glows while the
 * voice sings. Drag to orbit, wheel to zoom, double-click to go back to the audience's view.
 * Fills its parent, which needs a definite height.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FAMILY_LABEL, type Family } from "../../audio/gm.ts";
import { V } from "../colors.ts";
import { LISTENER, SINGER, type Performer } from "../stage.ts";
import type { BandNote } from "../karaoke.ts";

const FAMILY_COLOR: Record<Family, string> = {
  drums: V.red, bass: V.blue, piano: V.white, chromatic: V.white, organ: V.white, guitar: V.amber, ethnic: V.amber,
  strings: V.pink, ensemble: V.pink, brass: V.green, reed: V.green, pipe: V.green,
  lead: V.blueMid, pad: V.blueMid, fx: V.blueMid, sfx: V.blueMid, percussive: V.blueMid,
};
const HOME = new THREE.Vector3(LISTENER.x, LISTENER.y + 9, LISTENER.z - 1.5);
const TARGET = new THREE.Vector3(0, 0.5, -2.8);

const mat = (color: string) => new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.35), emissive: color, emissiveIntensity: 0.15, roughness: 0.6 });

function mesh(geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rx = 0, rz = 0): THREE.Mesh {
  const o = new THREE.Mesh(geo, m);
  o.position.set(x, y, z);
  o.rotation.set(rx, 0, rz);
  return o;
}

/** a small stylized figure: body, head */
function figure(m: THREE.Material, scale = 1): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CapsuleGeometry(0.22, 0.8, 4, 10), m, 0, 0.62, 0), mesh(new THREE.SphereGeometry(0.17, 14, 10), m, 0, 1.36, 0));
  g.scale.setScalar(scale);
  return g;
}

/** the prop a family plays on */
function prop(family: Family, voice: boolean, m: THREE.Material): THREE.Group {
  if (voice) return figure(m, 0.85);
  const g = new THREE.Group();
  const cyl = (r: number, h: number) => new THREE.CylinderGeometry(r, r, h, 18);
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  switch (family) {
    case "drums":
      g.add(mesh(cyl(0.38, 0.32), m, 0, 0.4, 0, Math.PI / 2), mesh(cyl(0.2, 0.2), m, -0.45, 0.75, 0.15), mesh(cyl(0.22, 0.22), m, 0.45, 0.75, 0.15), mesh(cyl(0.3, 0.02), m, -0.75, 1.15, -0.1), mesh(cyl(0.32, 0.02), m, 0.8, 1.2, -0.1));
      break;
    case "piano": case "chromatic": case "organ":
      g.add(mesh(box(1.3, 0.12, 0.45), m, 0, 0.85, 0), mesh(box(0.08, 0.8, 0.3), m, -0.55, 0.4, 0), mesh(box(0.08, 0.8, 0.3), m, 0.55, 0.4, 0));
      break;
    case "guitar": case "bass": case "ethnic":
      g.add(mesh(box(0.38, 0.48, 0.08), m, 0, 0.75, 0, 0, 0.35), mesh(box(0.06, family === "bass" ? 0.95 : 0.75, 0.04), m, 0.22, 1.3, 0, 0, 0.35));
      break;
    case "strings": case "ensemble":
      g.add(mesh(new THREE.CapsuleGeometry(0.2, 0.7, 4, 10), m, 0, 0.7, 0), mesh(box(0.04, 0.6, 0.04), m, 0, 1.35, 0));
      break;
    case "brass": case "reed": case "pipe":
      g.add(mesh(new THREE.ConeGeometry(0.2, 0.8, 16, 1, true), m, 0, 1, 0, Math.PI / 2.4), mesh(cyl(0.03, 0.9), m, 0, 0.45, 0));
      break;
    default:
      g.add(mesh(cyl(0.3, 0.7), m, 0, 0.35, 0), mesh(box(0.5, 0.15, 0.4), m, 0, 0.78, 0));
  }
  return g;
}

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
    wrap.appendChild(gl.domElement);
    gl.domElement.style.display = "block";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#02070b");
    scene.fog = new THREE.Fog("#02070b", 12, 26);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 60);
    camera.position.copy(HOME);
    const controls = new OrbitControls(camera, gl.domElement);
    controls.target.copy(TARGET);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2 - 0.06; // not under the floor
    controls.minDistance = 3;
    controls.maxDistance = 32;
    controls.update();
    // the view from the audience: back along HOME's direction until the whole stage (floor and
    // labels) fits the frame, whatever the screen's shape
    const xs = [SINGER.x, ...performers.map((p) => p.x)];
    const zs = [SINGER.z, ...performers.map((p) => p.z)];
    const [x0, x1, z0] = [Math.min(...xs) - 1.4, Math.max(...xs) + 1.4, Math.min(...zs) - 1];
    const corners = [x0, x1].flatMap((x) => [0.4, z0].flatMap((z) => [new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 2.6 - z * 0.22, z)]));
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

    // the platform, its front edge at z = 0, and the lights
    const floorGeo = new THREE.BoxGeometry(14, 0.4, 8);
    const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ color: "#071722", roughness: 0.9 }));
    floor.position.set(0, -0.2, -4);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(floorGeo), new THREE.LineBasicMaterial({ color: V.blueDim }));
    edge.position.copy(floor.position);
    scene.add(floor, edge, new THREE.AmbientLight("#9fd8ff", 0.35));
    for (const x of [-4, 0, 4]) {
      const spot = new THREE.SpotLight("#ffffff", 30, 16, Math.PI / 7, 0.6);
      spot.position.set(x, 7, 2);
      spot.target.position.set(x * 0.6, 0, -3);
      scene.add(spot, spot.target);
    }

    // the singer, with a mic stand
    const singerMat = mat(V.amber);
    const singer = figure(singerMat);
    singer.add(mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.3, 8), singerMat, 0, 0.65, 0.35), mesh(new THREE.SphereGeometry(0.06, 10, 8), singerMat, 0, 1.32, 0.35));
    singer.position.set(SINGER.x, 0, SINGER.z);
    const singerLabel = label("Voce", "Solista", V.amber);
    singerLabel.position.set(SINGER.x, 1.75, SINGER.z);
    scene.add(singer, singerLabel);

    // the band
    const lanes = new Map<number, Lane>();
    for (const n of notes) {
      const l = lanes.get(n.channel) ?? { notes: [], i: 0, drums: n.channel === 9 };
      l.notes.push(n);
      lanes.set(n.channel, l);
    }
    // labels rise toward the back, and neighbours take turns a step higher, so none hides another
    const lit = performers.map((p, k) => {
      const m = mat(FAMILY_COLOR[p.family]);
      const g = prop(p.family, p.voice, m);
      g.position.set(p.x, 0, p.z);
      g.lookAt(LISTENER.x, 0, LISTENER.z);
      const tag = label(p.name, p.voice ? "Voce" : FAMILY_LABEL[p.family], FAMILY_COLOR[p.family]);
      tag.position.set(p.x, 1.9 - p.z * 0.22 + (k % 2) * 0.42, p.z);
      scene.add(g, tag);
      return { m, g, lane: lanes.get(p.channel), glow: 0 };
    });

    const resize = () => {
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      gl.setSize(w, h);
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
      for (const p of lit) {
        const target = t === null || !p.lane ? 0 : level(p.lane, t);
        // light comes on at once and fades out
        p.glow = Math.max(target, p.glow * 0.88);
        p.m.emissiveIntensity = 0.15 + 1.6 * p.glow;
        p.g.scale.setScalar(1 + 0.06 * p.glow);
      }
      singerGlow = Math.max(singerRef.current() ? 1 : 0, singerGlow * 0.9);
      singerMat.emissiveIntensity = 0.2 + 1.4 * singerGlow;
      controls.update();
      gl.render(scene, camera);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.domElement.removeEventListener("dblclick", reset);
      controls.dispose();
      scene.traverse((o) => {
        const x = o as THREE.Mesh;
        x.geometry?.dispose();
        for (const m of Array.isArray(x.material) ? x.material : x.material ? [x.material] : []) {
          (m as THREE.SpriteMaterial).map?.dispose();
          m.dispose();
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
