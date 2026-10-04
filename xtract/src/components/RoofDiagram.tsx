import { EDGE_HEX } from "@/lib/edges";
import type { Pt, RoofMeasurements } from "@/lib/types";

export type DiagramMode = "lengths" | "pitch" | "area" | "scan";

interface Props {
  m: RoofMeasurements;
  mode: DiagramMode;
  className?: string;
  title?: string;
}

const PAD = 14;

/** Plan-view roof diagram drawn from the measurement engine's output. */
export function RoofDiagram({ m, mode, className, title }: Props) {
  const pts = m.facets.flatMap((f) => f.polygon);
  const minX = Math.min(...pts.map((p) => p[0]));
  const maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const maxY = Math.max(...pts.map((p) => p[1]));
  const w = maxX - minX + PAD * 2;
  const h = maxY - minY + PAD * 2;
  // SVG y grows downward; plan y grows north.
  const tx = (p: Pt): [number, number] => [p[0] - minX + PAD, maxY - p[1] + PAD];
  const poly = (ps: Pt[]) => ps.map((p) => tx(p).map((n) => n.toFixed(1)).join(",")).join(" ");
  const fs = Math.max(w, h) / 34;
  const maxPitch = Math.max(...m.facets.map((f) => f.pitch), 1);
  const dark = mode === "scan";

  const facetFill = (pitch: number) => {
    if (mode === "pitch") return `rgba(3,105,161,${0.12 + 0.5 * (pitch / maxPitch)})`;
    if (mode === "area") return "#fef3c7";
    if (dark) return "rgba(148,163,184,0.16)";
    return "#f1f5f9";
  };

  return (
    <svg viewBox={`0 0 ${w.toFixed(1)} ${h.toFixed(1)}`} className={className} role="img" aria-label={title ?? "Roof diagram"}>
      {title ? <title>{title}</title> : null}
      {m.facets.map((f) => (
        <polygon
          key={f.id}
          points={poly(f.polygon)}
          fill={facetFill(f.pitch)}
          stroke={dark ? "rgba(148,163,184,0.45)" : mode === "lengths" ? "#cbd5e1" : "#0f172a"}
          strokeWidth={fs * 0.06}
          strokeLinejoin="round"
          className={dark ? "fade-pop" : undefined}
          style={dark ? ({ "--delay": `${200 + f.id * 90}ms` } as React.CSSProperties) : undefined}
        />
      ))}

      {(mode === "lengths" || mode === "scan") &&
        m.edges.map((e, i) => {
          const [ax, ay] = tx(e.a);
          const [bx, by] = tx(e.b);
          const l = Math.hypot(bx - ax, by - ay);
          return (
            <line
              key={i}
              x1={ax}
              y1={ay}
              x2={bx}
              y2={by}
              stroke={EDGE_HEX[e.type]}
              strokeWidth={fs * (dark ? 0.2 : 0.17)}
              strokeLinecap="round"
              className={dark ? "draw-edge" : undefined}
              style={dark ? ({ "--len": l.toFixed(1), "--delay": `${1100 + i * 70}ms` } as React.CSSProperties) : undefined}
            />
          );
        })}

      {mode === "lengths" &&
        m.edges.map((e, i) => {
          const [ax, ay] = tx(e.a);
          const [bx, by] = tx(e.b);
          if (Math.hypot(bx - ax, by - ay) < fs * 2.2) return null;
          const cx = (ax + bx) / 2;
          const cy = (ay + by) / 2;
          const s = String(Math.round(e.lengthFt));
          const bw = fs * (0.62 * s.length + 0.5);
          return (
            <g key={`l${i}`}>
              <rect x={cx - bw / 2} y={cy - fs * 0.62} width={bw} height={fs * 1.24} rx={fs * 0.3} fill="#fff" stroke={EDGE_HEX[e.type]} strokeWidth={fs * 0.05} />
              <text x={cx} y={cy + fs * 0.36} textAnchor="middle" fontSize={fs} fontWeight={700} fill={EDGE_HEX[e.type]} fontFamily="var(--font-mono)">
                {s}
              </text>
            </g>
          );
        })}

      {(mode === "pitch" || mode === "area") &&
        m.facets.map((f) => {
          const [lx, ly] = tx(f.label);
          return (
            <text key={`f${f.id}`} x={lx} y={ly + fs * 0.4} textAnchor="middle" fontSize={fs * 1.05} fontWeight={700} fill="#0f172a" fontFamily="var(--font-mono)">
              {mode === "pitch" ? `${f.pitch}/12` : Math.round(f.areaSqFt).toLocaleString()}
            </text>
          );
        })}

      {/* North arrow */}
      <g transform={`translate(${w - PAD * 0.9} ${PAD * 1.1})`} opacity={dark ? 0.7 : 1}>
        <path d={`M0 ${-fs * 0.9} L${fs * 0.4} ${fs * 0.4} L0 ${fs * 0.1} L${-fs * 0.4} ${fs * 0.4} Z`} fill={dark ? "#e2e8f0" : "#0f172a"} />
        <text y={fs * 1.6} textAnchor="middle" fontSize={fs * 0.8} fontWeight={700} fill={dark ? "#e2e8f0" : "#0f172a"}>
          N
        </text>
      </g>
    </svg>
  );
}
