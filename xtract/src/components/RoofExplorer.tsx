"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Layers, Minus, Move3D, Pause, Play, Plus, RotateCcw } from "lucide-react";
import type { Roof3D } from "@/lib/model3d";

type Mode = "facets" | "pitch" | "wireframe";
interface Controls {
  zoom: (k: number) => void;
  reset: () => void;
  top: () => void;
  mode: (m: Mode) => void;
  explode: (v: boolean) => void;
  spin: (v: boolean) => void;
  rotate: (dx: number, dy: number) => void;
  dispose: () => void;
}

const PITCH_COLORS = ["#39bcca", "#7bbaa0", "#729cda", "#ac8cd4", "#dba272"];
const pitchBand = (p: number) => Math.min(4, Math.max(0, Math.floor((p - 4) / 2)));

interface Props {
  roof: Roof3D;
  title: string;
  subtitle: string;
  stats: { area: number; facets: number; pitch: number };
  note: string;
  dark?: boolean;
}

/** Interactive 3D roof: orbit, zoom, pitch map, wireframe, explode, facet inspection. */
export function RoofExplorer({ roof, title, subtitle, stats, note, dark = true }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<Controls | null>(null);
  const [mode, setMode] = useState<Mode>("facets");
  const [selected, setSelected] = useState<Roof3D["facets"][number] | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [exploded, setExploded] = useState(false);
  const [spin, setSpin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const c = canvas.current;
    const h = host.current;
    if (!c || !h) return;
    (async () => {
      try {
        const [T, { OrbitControls }] = await Promise.all([import("three"), import("three/examples/jsm/controls/OrbitControls.js")]);
        if (cancelled) return;
        const renderer = new T.WebGLRenderer({ canvas: c, antialias: true, powerPreference: "low-power" });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = T.PCFSoftShadowMap;
        renderer.toneMapping = T.ACESFilmicToneMapping;

        const scene = new T.Scene();
        const bg = new T.Color(dark ? "#0e2335" : "#e5edf1");
        scene.background = bg;
        const roofGroup = new T.Group();
        const wallGroup = new T.Group();
        scene.add(roofGroup, wallGroup);

        // Procedural shingle texture for bump detail.
        const px = new Uint8Array(256 * 256 * 4);
        for (let y = 0; y < 256; y++)
          for (let x = 0; x < 256; x++) {
            const i = (y * 256 + x) * 4;
            const seam = y % 32 < 2 || (x + (Math.floor(y / 32) % 2) * 16) % 64 < 1;
            const v = seam ? 60 : 148 + ((x * 13 + y * 31 + x * y * 7) % 23);
            px[i] = px[i + 1] = px[i + 2] = v;
            px[i + 3] = 255;
          }
        const tex = new T.DataTexture(px, 256, 256);
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
        tex.needsUpdate = true;

        const slate = new T.Color("#3a5670");
        const meshes: import("three").Mesh<import("three").BufferGeometry, import("three").MeshStandardMaterial>[] = [];
        for (const f of roof.facets) {
          const pts = f.pts.map(([x, y, z]) => new T.Vector3(x, y, z));
          const tri = T.ShapeUtils.triangulateShape(pts.map((p) => new T.Vector2(p.x, p.z)), []).flat();
          const g = new T.BufferGeometry();
          g.setAttribute("position", new T.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
          g.setAttribute("uv", new T.Float32BufferAttribute(pts.flatMap((p) => [p.x * 0.8, p.z * 0.8]), 2));
          g.setIndex(tri);
          g.computeVertexNormals();
          const mat = new T.MeshStandardMaterial({ color: slate, roughness: 0.88, metalness: 0.1, bumpMap: tex, bumpScale: 0.015, side: T.DoubleSide, flatShading: true });
          const mesh = new T.Mesh(g, mat);
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.userData = { id: f.id };
          roofGroup.add(mesh);
          meshes.push(mesh);
          const lines = new T.LineSegments(new T.EdgesGeometry(g, 15), new T.LineBasicMaterial({ color: "#8fb3cc", transparent: true, opacity: 0.6 }));
          lines.position.y = 0.006;
          roofGroup.add(lines);
        }
        const wallMat = new T.MeshStandardMaterial({ color: "#e1e1d9", roughness: 0.95, side: T.DoubleSide });
        for (const q of roof.walls) {
          const g = new T.BufferGeometry();
          g.setAttribute("position", new T.Float32BufferAttribute(q.flat(), 3));
          g.setIndex([0, 1, 2, 0, 2, 3]);
          g.computeVertexNormals();
          const w = new T.Mesh(g, wallMat);
          w.castShadow = w.receiveShadow = true;
          wallGroup.add(w);
        }
        const floor = new T.Mesh(new T.PlaneGeometry(200, 200), new T.MeshStandardMaterial({ color: bg, roughness: 1 }));
        floor.rotation.x = -Math.PI / 2;
        floor.receiveShadow = true;
        scene.add(floor);
        const grid = new T.GridHelper(16, 32, dark ? "#2d5674" : "#b5c7d1", dark ? "#1d3f59" : "#ccd9df");
        grid.position.y = 0.003;
        scene.add(grid);
        scene.add(new T.HemisphereLight("#effaff", "#6e8191", 2.2));
        const sun = new T.DirectionalLight("#fff7e9", 3.4);
        sun.position.set(-4, 9, 5);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        Object.assign(sun.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7 });
        sun.shadow.normalBias = 0.035;
        scene.add(sun);
        const fill = new T.DirectionalLight("#a6dfff", 1.3);
        fill.position.set(5, 3, -4);
        scene.add(fill);

        const camera = new T.PerspectiveCamera(34, 1, 0.1, 100);
        const home = new T.Vector3(6.5, 9.6, 8.3);
        camera.position.copy(home);
        const orbit = new OrbitControls(camera, c);
        orbit.target.set(0, 0.6, 0);
        orbit.enableDamping = true;
        orbit.dampingFactor = 0.075;
        orbit.enablePan = false;
        orbit.minDistance = 6;
        orbit.maxDistance = 24;
        orbit.maxPolarAngle = Math.PI * 0.46;
        orbit.autoRotateSpeed = 0.5;
        orbit.update();

        let modeNow: Mode = "facets";
        let sel: number | null = null;
        let lift = 0;
        const paint = () => {
          for (const m of meshes) {
            const f = roof.facets.find((x) => x.id === m.userData.id)!;
            m.material.wireframe = modeNow === "wireframe";
            m.material.color.set(sel === f.id ? "#0caad3" : modeNow === "pitch" ? PITCH_COLORS[pitchBand(f.pitch)] : slate);
            m.material.emissive.set(sel === f.id ? "#075f78" : "#000000");
            m.material.emissiveIntensity = 0.25;
          }
        };

        const resize = () => {
          const b = h.getBoundingClientRect();
          if (!b.width || !b.height) return;
          renderer.setSize(b.width, b.height, false);
          camera.aspect = b.width / b.height;
          camera.updateProjectionMatrix();
        };
        const ro = new ResizeObserver(resize);
        ro.observe(h);
        resize();
        let inView = true;
        const io = new IntersectionObserver(([e]) => (inView = e.isIntersecting));
        io.observe(h);
        let frame = 0;
        const tick = () => {
          frame = requestAnimationFrame(tick);
          if (!inView || document.hidden) return;
          roofGroup.position.y += (lift - roofGroup.position.y) * 0.08;
          orbit.update();
          renderer.render(scene, camera);
        };
        tick();
        setReady(true);

        const ray = new T.Raycaster();
        const ptr = new T.Vector2();
        let down: { x: number; y: number } | null = null;
        const onDown = (e: PointerEvent) => {
          down = { x: e.clientX, y: e.clientY };
          orbit.autoRotate = false;
          setSpin(false);
        };
        const onUp = (e: PointerEvent) => {
          if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return void (down = null);
          down = null;
          const b = c.getBoundingClientRect();
          ptr.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
          ray.setFromCamera(ptr, camera);
          const hit = ray.intersectObjects(meshes, false)[0];
          sel = hit ? hit.object.userData.id : null;
          paint();
          setSelected(roof.facets.find((f) => f.id === sel) ?? null);
        };
        const lost = (e: Event) => {
          e.preventDefault();
          setFailed(true);
          setReady(false);
        };
        c.addEventListener("pointerdown", onDown);
        c.addEventListener("pointerup", onUp);
        c.addEventListener("webglcontextlost", lost);

        api.current = {
          zoom: (k) => {
            camera.position.sub(orbit.target).multiplyScalar(k).clampLength(6, 24).add(orbit.target);
            orbit.update();
          },
          reset: () => {
            camera.position.copy(home);
            orbit.autoRotate = false;
            sel = null;
            paint();
            setSelected(null);
            setSpin(false);
            orbit.update();
          },
          top: () => {
            camera.position.set(0, 15, 0.02);
            orbit.update();
          },
          mode: (m) => {
            modeNow = m;
            paint();
          },
          explode: (v) => (lift = v ? 1.4 : 0),
          spin: (v) => (orbit.autoRotate = v && !window.matchMedia("(prefers-reduced-motion: reduce)").matches),
          rotate: (dx, dy) => {
            const s = new T.Spherical().setFromVector3(camera.position.clone().sub(orbit.target));
            s.theta += dx;
            s.phi = Math.max(0.02, Math.min(Math.PI * 0.46, s.phi + dy));
            camera.position.copy(new T.Vector3().setFromSpherical(s).add(orbit.target));
            orbit.update();
          },
          dispose: () => {
            cancelAnimationFrame(frame);
            ro.disconnect();
            io.disconnect();
            orbit.dispose();
            c.removeEventListener("pointerdown", onDown);
            c.removeEventListener("pointerup", onUp);
            c.removeEventListener("webglcontextlost", lost);
            scene.traverse((o) => {
              const m = o as import("three").Mesh;
              m.geometry?.dispose();
              (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach((x) => x.dispose());
            });
            tex.dispose();
            renderer.dispose();
          },
        };
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      api.current?.dispose();
      api.current = null;
    };
  }, [roof, dark]);

  const onKey = (e: React.KeyboardEvent) => {
    const a = api.current;
    if (!a) return;
    const map: Record<string, () => void> = {
      ArrowLeft: () => a.rotate(-0.13, 0),
      ArrowRight: () => a.rotate(0.13, 0),
      ArrowUp: () => a.rotate(0, -0.1),
      ArrowDown: () => a.rotate(0, 0.1),
      "+": () => a.zoom(0.9),
      "=": () => a.zoom(0.9),
      "-": () => a.zoom(1.1),
      Home: () => a.reset(),
    };
    if (map[e.key]) {
      e.preventDefault();
      map[e.key]();
    }
  };

  const btn = `inline-flex h-10 min-w-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors duration-150 disabled:cursor-default disabled:opacity-50 ${
    dark ? "text-slate-200 hover:bg-white/10" : "text-slate hover:bg-panel"
  }`;
  const on = dark ? "bg-white/15 text-white" : "bg-white text-ink shadow-sm";

  return (
    <div className={`overflow-hidden rounded-3xl border ${dark ? "border-sky/15 bg-ink-2 text-white shadow-2xl shadow-black/40" : "border-line bg-white"}`}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div>
          <p className={`flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest ${dark ? "text-sky/80" : "text-brand"}`}>
            <Layers className="h-3.5 w-3.5" aria-hidden="true" /> Xtract / 3D roof model
          </p>
          <h3 className="mt-1 text-lg font-bold leading-tight">{title}</h3>
          <p className={`text-sm ${dark ? "text-slate-400" : "text-muted"}`}>{subtitle}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] font-semibold ${dark ? "bg-amber/15 text-amber" : "bg-amber-soft text-amber-800"}`}>{ready ? "LIVE 3D" : "3D MODEL"}</span>
      </div>

      <div ref={host} className="relative mt-3 aspect-[4/3] w-full">
        {!ready && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/roof-isometric.png" alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover opacity-80" />
        )}
        <canvas
          ref={canvas}
          tabIndex={0}
          role="img"
          aria-label="3D roof model. Drag to orbit, scroll or pinch to zoom, click a facet to inspect it. Arrow keys orbit, plus and minus zoom, Home resets."
          onKeyDown={onKey}
          className="absolute inset-0 h-full w-full touch-none"
          style={{ opacity: ready ? 1 : 0 }}
        />
        <div className="absolute right-3 top-3 flex flex-col gap-1 rounded-xl bg-black/30 p-1 backdrop-blur">
          <button className={btn} aria-label="Zoom in" disabled={!ready} onClick={() => api.current?.zoom(0.9)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button className={btn} aria-label="Zoom out" disabled={!ready} onClick={() => api.current?.zoom(1.1)}>
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>
          <button className={btn} aria-label="Reset view" disabled={!ready} onClick={() => api.current?.reset()}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div aria-live="polite" className="absolute bottom-3 left-3 max-w-[70%] rounded-xl bg-black/55 px-3 py-2 text-white backdrop-blur">
          {selected ? (
            <>
              <p className="font-mono text-[10px] uppercase tracking-wider text-sky">Facet {String(selected.id).padStart(2, "0")} · faces {selected.direction}</p>
              <p className="font-mono text-sm font-semibold">
                {selected.area.toLocaleString()} sqft · {selected.pitch}/12
              </p>
            </>
          ) : (
            <>
              <p className="font-mono text-[10px] uppercase tracking-wider text-sky">{roof.facets.length} roof facets</p>
              <p className="text-xs">{failed ? "3D unavailable on this device — static preview." : "Click a surface to inspect its area and pitch."}</p>
            </>
          )}
        </div>
        <p className="absolute bottom-3 right-3 hidden items-center gap-1 text-[11px] text-white/70 sm:flex">
          <Move3D className="h-3.5 w-3.5" aria-hidden="true" /> Drag to orbit
        </p>
      </div>

      <div className={`flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 ${dark ? "border-white/10" : "border-line"}`}>
        <div className={`flex rounded-lg p-0.5 ${dark ? "bg-black/20" : "bg-panel"}`} role="group" aria-label="Display mode">
          {(["facets", "pitch", "wireframe"] as const).map((m) => (
            <button
              key={m}
              aria-pressed={mode === m}
              disabled={!ready}
              onClick={() => {
                setMode(m);
                api.current?.mode(m);
              }}
              className={`${btn} ${mode === m ? on : ""}`}
            >
              {m === "facets" ? "Architectural" : m === "pitch" ? "Pitch map" : "Wireframe"}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          <button className={btn} disabled={!ready} onClick={() => api.current?.top()}>
            Top
          </button>
          <button
            className={`${btn} ${exploded ? on : ""}`}
            aria-pressed={exploded}
            disabled={!ready}
            onClick={() => {
              setExploded(!exploded);
              api.current?.explode(!exploded);
            }}
          >
            <Box className="h-3.5 w-3.5" aria-hidden="true" /> {exploded ? "Assemble" : "Explode"}
          </button>
          <button
            className={`${btn} ${spin ? on : ""}`}
            aria-pressed={spin}
            disabled={!ready}
            onClick={() => {
              setSpin(!spin);
              api.current?.spin(!spin);
            }}
          >
            {spin ? <Pause className="h-3.5 w-3.5" aria-hidden="true" /> : <Play className="h-3.5 w-3.5" aria-hidden="true" />} Orbit
          </button>
        </div>
      </div>
      {mode === "pitch" && (
        <div className="flex flex-wrap gap-3 px-5 pb-2 text-[11px]">
          {["4–5/12", "6–7/12", "8–9/12", "10–11/12", "12+/12"].map((l, i) => (
            <span key={l} className="flex items-center gap-1.5">
              <i className="h-2.5 w-2.5 rounded-sm" style={{ background: PITCH_COLORS[i] }} aria-hidden="true" />
              {l}
            </span>
          ))}
        </div>
      )}
      <dl className={`grid grid-cols-3 border-t ${dark ? "border-white/10" : "border-line"}`}>
        {[
          ["Roof area", `${stats.area.toLocaleString()}`, "sqft"],
          ["Facets", String(stats.facets), ""],
          ["Primary pitch", `${stats.pitch}/12`, ""],
        ].map(([k, v, u]) => (
          <div key={k} className={`px-5 py-3 ${dark ? "[&:not(:last-child)]:border-r [&:not(:last-child)]:border-white/10" : "[&:not(:last-child)]:border-r [&:not(:last-child)]:border-line"}`}>
            <dt className={`text-[10px] font-bold uppercase tracking-wider ${dark ? "text-slate-400" : "text-muted"}`}>{k}</dt>
            <dd className="font-mono text-lg font-semibold">
              {v}
              {u && <small className="ml-1 text-xs text-slate-400">{u}</small>}
            </dd>
          </div>
        ))}
      </dl>
      <p className={`px-5 pb-4 text-[11px] leading-5 ${dark ? "text-slate-400" : "text-muted"}`}>{note}</p>
    </div>
  );
}
