"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useDataVersion } from "@/lib/refresh";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES, themeLabel } from "@/lib/types";
import { fmtK, relTime, stampET } from "@/lib/format";
import type { ShellCtx } from "../AppShell";
import { IconStack } from "../Icons";

// Show a short list by default; the rest is one click away rather than a wall of rows.
const HIGH_PREVIEW = 8;

export function Dashboard({ ctx }: { ctx: ShellCtx }) {
  const [kpi, setKpi] = useState<{ active: number; new24: number; closed24: number } | null>(null);
  const [tally, setTally] = useState<{ open: number; filtered: number } | null>(null);
  const [todayHigh, setTodayHigh] = useState<(VMaster & { windowDupes: number })[]>([]);
  const [highExpanded, setHighExpanded] = useState(false);
  const [batch, setBatch] = useState<any>(null);
  const version = useDataVersion();
  const [prio, setPrio] = useState<{ H: number; M: number; L: number }>({ H: 0, M: 0, L: 0 });
  const [themes, setThemes] = useState<[string, number][]>([]);
  const [trend, setTrend] = useState<{ opened: number[]; closed: number[]; days: string[] }>({ opened: [], closed: [], days: [] });

  useEffect(() => {
    (async () => {
      // Everything the dashboard needs in FIVE parallel requests. This used to be ~45
      // sequential-ish ones — 28 of them a count-per-day for the intake chart — which
      // measured 5.9s to full render. The DB answered each in ~50ms; the cost was the
      // request count, so the aggregation moved into read-model views (schema v1.4).
      const since = new Date(Date.now() - 86400000).toISOString();
      const [statsRes, themeRes, dailyRes, highRes, batchRes] = await Promise.all([
        supabase.from("v_dashboard_stats").select("*").maybeSingle(),
        supabase.from("v_theme_counts").select("*"),
        supabase.from("v_daily_activity").select("*"),
        supabase.from("v_master").select("*")
          .gte("created_at", since).eq("state", "open").eq("priority", "H")
          .order("final_rank_score", { ascending: false, nullsFirst: false }).limit(50),
        supabase.from("batches").select("*").order("started_at", { ascending: false }).limit(1),
      ]);

      const st = statsRes.data as Record<string, number> | null;
      if (st) {
        setKpi({ active: st.active, new24: st.new_24h, closed24: st.closed_24h });
        setTally({ open: st.open_total, filtered: st.filtered_out });
        setPrio({ H: st.prio_h, M: st.prio_m, L: st.prio_l });
      }

      // The view only returns themes that have issues; the bars still show all seven.
      const counts = new Map((themeRes.data ?? []).map((r: any) => [r.theme, r.n as number]));
      setThemes(Object.keys(THEME_NAMES)
        .map((k) => [k, counts.get(k) ?? 0] as [string, number])
        .sort((a, b) => b[1] - a[1]));

      setTrend({
        days: (dailyRes.data ?? []).map((r: any) =>
          new Date(`${r.day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })),
        opened: (dailyRes.data ?? []).map((r: any) => r.opened as number),
        closed: (dailyRes.data ?? []).map((r: any) => r.closed as number),
      });

      // Collapse duplicate reports to one row per cluster. The in-app bug reporter files
      // near-identical issues in bulk (12 copies of one rate-limit failure in a single day),
      // and each copy was taking its own High slot. The fetch is score-ordered, so the first
      // member seen is the best one; windowDupes = how many later rows folded into it.
      const byCluster = new Map<string | number, VMaster & { windowDupes: number }>();
      for (const r of ((highRes.data as VMaster[]) ?? [])) {
        const key = r.cluster_id ?? `solo-${r.number}`;
        const hit = byCluster.get(key);
        if (hit) hit.windowDupes += 1;
        else byCluster.set(key, { ...r, windowDupes: 0 });
      }
      setTodayHigh(Array.from(byCluster.values()));

      setBatch(batchRes.data ?? []);
    })();
  }, [version]);

  const prioTotal = prio.H + prio.M + prio.L || 1;
  const maxTheme = Math.max(1, ...themes.map((t) => t[1]));

  return (
    <section className="view">
      <div className="greet">
        <h1 className="display">Claude Code GitHub Issues Dashboard</h1>
      </div>
      <div className="view-sub">
        {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} ·{" "}
        {kpi ? `${kpi.active.toLocaleString()} active issues in anthropics/claude-code` : "loading…"}
      </div>

      <div className="grid grid-kpi">
        <Tile
          label="Active issues"
          value={kpi ? kpi.active.toLocaleString() : "—"}
          sub={tally ? `of ${tally.open.toLocaleString()} open · ${tally.filtered.toLocaleString()} filtered` : "open & eligible"}
        />
        <Tile label="New issues (24h)" value={kpi ? kpi.new24.toLocaleString() : "—"} sub="created in the last day" />
        <Tile label="Closed (24h)" value={kpi ? kpi.closed24.toLocaleString() : "—"} sub="closed in the last day" />
        {/* Batch id / kind is ops detail — it lives in Batches & ops, not here. */}
        <Tile
          label="Last update"
          small
          value={batch?.[0] ? stampET(batch[0].started_at) : "—"}
          sub={batch?.[0] && batch[0].status !== "ok" ? `last run ${batch[0].status}` : "data refreshed"}
        />
      </div>

      <div className="card card-pad">
        <div className="card-head">
          <div>
            <div className="card-title">New High priority · last 24 hours</div>
            <div className="card-sub">Filed in the last 24 hours and still open · duplicate reports collapsed into one row</div>
          </div>
        </div>
        {todayHigh.length === 0 ? (
          <div style={{ color: "var(--text-3)", fontSize: 13, padding: "10px 2px" }}>
            No High-priority issues filed in the last 24 hours.
          </div>
        ) : (
          <div className="table-card" style={{ border: "none", boxShadow: "none", borderRadius: 0 }}>
            <table className="master today-high">
              <thead>
                <tr>
                  <th>#</th><th>Title</th><th>Area</th><th>Theme</th>
                  <th style={{ textAlign: "right" }}>Reacts</th>
                  <th style={{ textAlign: "right" }} title="When the issue last saw activity — GitHub updated_at. Times are ET.">Last activity</th>
                  <th style={{ textAlign: "right" }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {(highExpanded ? todayHigh : todayHigh.slice(0, HIGH_PREVIEW)).map((r) => (
                  <tr key={r.number} onClick={() => ctx.openDrawer(r)}>
                    <td className="t-num">#{r.number}</td>
                    <td className="t-title">
                      <div className="title-flex">
                      <span className="title-text">{r.title}</span>
                      {(r.cluster_size ?? 1) > 1 && (
                        <span
                          className="pill dupes"
                          title={
                            `${(r.cluster_size ?? 1) - 1} duplicate reports of this issue` +
                            (r.windowDupes > 0 ? ` · ${r.windowDupes + 1} filed in the last 24h, collapsed into this row` : "")
                          }
                        >
                          <IconStack />{(r.cluster_size ?? 1) - 1}
                        </span>
                      )}
                      </div>
                    </td>
                    <td><span className="tag">{r.area ?? "—"}</span></td>
                    <td>{r.theme ? <span className="tag theme-t">{themeLabel(r.theme)}</span> : <span className="tag">—</span>}</td>
                    <td className="t-r">{fmtK(r.reactions_total)}</td>
                    <td className="t-r">
                      <div>{relTime(r.updated_at)}</div>
                      <div className="act-abs">{stampET(r.updated_at)}</div>
                    </td>
                    <td className="t-r">{Math.round(r.final_rank_score ?? r.retrieval_score ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {todayHigh.length > HIGH_PREVIEW && (
          <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={() => setHighExpanded((v) => !v)}>
            {highExpanded ? "Show fewer" : `Show all ${todayHigh.length} →`}
          </button>
        )}
      </div>

      <div className="grid grid-2a" style={{ marginTop: 14 }}>
        <div className="card card-pad">
          <div className="card-head"><div><div className="card-title">Intake vs. closes</div><div className="card-sub">Issues opened and closed per day · last 14 complete days (UTC)</div></div></div>
          <IntakeChart {...trend} />
        </div>
        <div className="card card-pad">
          <div className="card-head"><div><div className="card-title">Priority mix</div><div className="card-sub">LLM-classified active set · {prioTotal.toLocaleString()} issues</div></div></div>
          <PrioBar prio={prio} total={prioTotal} />
        </div>
      </div>

      <div className="card card-pad">
        <div className="card-head">
          <div><div className="card-title">Open issues by theme</div><div className="card-sub">Classified active set · click a bar to filter the master list</div></div>
          <div className="card-tools"><button className="btn btn-sm" onClick={() => ctx.goMaster(null)}>Master list</button></div>
        </div>
        <div className="theme-bars">
          {themes.map(([k, n]) => (
            <button className="theme-bar-row" key={k} onClick={() => ctx.goMaster({ theme: k })}>
              <span className="tb-name">{THEME_NAMES[k]}</span>
              <span className="tb-track"><i style={{ width: `${Math.max(2, (n / maxTheme) * 100)}%` }} /></span>
              <span className="tb-val">{n}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function Tile({ label, value, sub, ok, small }: { label: string; value: string; sub?: string; ok?: string; small?: boolean }) {
  return (
    <div className="card tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value" style={small ? { fontSize: 19 } : undefined}>{value}</span>
      {ok ? <span className="tile-ok"><span className="sync-dot" />{ok}</span> : <span className="tile-delta"><span style={{ color: "var(--text-3)" }}>{sub}</span></span>}
    </div>
  );
}

function PrioBar({ prio, total }: { prio: { H: number; M: number; L: number }; total: number }) {
  const segs = [
    { k: "High", n: prio.H, c: "var(--hi-mark)" },
    { k: "Medium", n: prio.M, c: "var(--med-mark)" },
    { k: "Low", n: prio.L, c: "var(--low-mark)" },
  ];
  let x = 0; const W = 420, gap = 2;
  return (
    <>
      <svg className="chart-svg" viewBox={`0 0 ${W} 46`} width="100%">
        {segs.map((s, i) => {
          const w = (s.n / total) * (W - gap * 2);
          const rx = i === 0 || i === segs.length - 1 ? 5 : 0;
          const el = <rect key={s.k} x={x} y={12} width={Math.max(0, w)} height={22} rx={rx} fill={s.c} />;
          x += w + gap;
          return el;
        })}
      </svg>
      <div className="legend" style={{ flexDirection: "column", gap: 7, marginTop: 14 }}>
        {segs.map((s) => (
          <div key={s.k} className="legend-it">
            <span className="legend-swatch" style={{ background: s.c }} />
            <span>{s.k}</span>
            <span className="legend-val">— {s.n.toLocaleString()} · {Math.round((s.n / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </>
  );
}

function IntakeChart({ opened, closed, days }: { opened: number[]; closed: number[]; days: string[] }) {
  if (!opened.length) return <div className="skeleton">Loading trend…</div>;
  const W = 620, H = 232, padL = 38, padR = 90, padT = 14, padB = 26;
  const pw = W - padL - padR, ph = H - padT - padB;
  const all = [...opened, ...closed];
  const lo = Math.min(...all), hi = Math.max(...all);
  const yMin = Math.max(0, lo - 20), yMax = hi + 20;
  const X = (i: number) => padL + (i * pw) / (days.length - 1);
  const Y = (v: number) => padT + ph - ((v - yMin) / (yMax - yMin || 1)) * ph;
  const ticks = [yMin, Math.round((yMin + yMax) / 2), yMax];
  const series = [{ d: opened, c: "var(--s1)", n: "Opened" }, { d: closed, c: "var(--s2)", n: "Closed" }];
  return (
    <>
      <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} width="100%">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR + 34} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={padL - 8} y={Y(t) + 3.5} textAnchor="end" className="axis-txt">{t}</text>
          </g>
        ))}
        {[0, 4, 9, 13].map((i) => (
          <text key={i} x={X(i)} y={H - 8} textAnchor={i === 0 ? "start" : "middle"} className="axis-txt">{days[i]}</text>
        ))}
        {series.map((s) => (
          <polyline key={s.n} points={s.d.map((v, i) => `${X(i)},${Y(v)}`).join(" ")} fill="none" stroke={s.c} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {(() => {
          // End labels sit at each line's last point, but the two series often finish within a
          // few px of each other — nudge them apart so the text never overlaps.
          const i = opened.length - 1;
          const raw = series.map((s) => Y(s.d[i]));
          const [a, b] = raw;
          const MIN = 13;
          const push = Math.abs(a - b) < MIN ? (MIN - Math.abs(a - b)) / 2 : 0;
          const labelY = push === 0 ? raw : a <= b ? [a - push, b + push] : [a + push, b - push];
          return series.map((s, si) => (
            <g key={s.n + "e"}>
              <circle cx={X(i)} cy={Y(s.d[i])} r={4.2} fill={s.c} stroke="var(--card)" strokeWidth={2} />
              <text x={X(i) + 10} y={labelY[si] + 4} className="axis-txt" style={{ fontSize: 11.5, fontWeight: 600, fill: "var(--text-2)" }}>{s.n} {s.d[i]}</text>
            </g>
          ));
        })()}
      </svg>
      <div className="legend">
        {series.map((s) => (
          <span key={s.n} className="legend-it"><span className="legend-line" style={{ background: s.c }} />{s.n}</span>
        ))}
      </div>
    </>
  );
}
