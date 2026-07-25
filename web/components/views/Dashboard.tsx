"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useDataVersion } from "@/lib/refresh";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES, themeLabel } from "@/lib/types";
import { fmtK, timeET } from "@/lib/format";
import type { ShellCtx } from "../AppShell";
import { Starburst } from "../Icons";

// Mirrors pipeline/config.yaml → eligibility.exclude_labels. An issue can carry more than
// one, so these counts overlap and deliberately are not presented as a sum.
const EXCLUDE_LABELS = ["stale", "duplicate", "invalid", "question", "autoclose"];

async function count(build: (q: any) => any): Promise<number> {
  const { count } = await build(supabase.from("v_master").select("number", { count: "exact", head: true }));
  return count ?? 0;
}

export function Dashboard({ ctx }: { ctx: ShellCtx }) {
  const [kpi, setKpi] = useState({ active: 0, new24: 0, closed24: 0 });
  const [tally, setTally] = useState<{ open: number; filtered: number; reasons: [string, number][] } | null>(null);
  const [todayHigh, setTodayHigh] = useState<VMaster[]>([]);
  const [todayCoverage, setTodayCoverage] = useState<{ opened: number; classified: number } | null>(null);
  const [batch, setBatch] = useState<any>(null);
  const version = useDataVersion();
  const [prio, setPrio] = useState<{ H: number; M: number; L: number }>({ H: 0, M: 0, L: 0 });
  const [themes, setThemes] = useState<[string, number][]>([]);
  const [trend, setTrend] = useState<{ opened: number[]; closed: number[]; days: string[] }>({ opened: [], closed: [], days: [] });

  useEffect(() => {
    (async () => {
      const active = await count((q) => q.eq("is_active", true));
      const since = new Date(Date.now() - 86400000).toISOString();
      const { count: new24 } = await supabase.from("issues").select("number", { count: "exact", head: true }).gte("created_at", since);
      const { count: closed24 } = await supabase.from("issues").select("number", { count: "exact", head: true }).gte("closed_at", since);
      setKpi({ active, new24: new24 ?? 0, closed24: closed24 ?? 0 });

      // Today's new High-priority arrivals. `todayStart` is UTC midnight so it matches the
      // intake chart's day buckets; the header says UTC so it can't be misread as local.
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const todaySince = todayStart.toISOString();
      const { data: th } = await supabase
        .from("v_master")
        .select("*")
        .gte("created_at", todaySince)
        .eq("state", "open")
        .eq("priority", "H")
        .order("final_rank_score", { ascending: false, nullsFirst: false })
        .limit(12);
      setTodayHigh((th as VMaster[]) ?? []);
      // Coverage: most of today's arrivals are still unclassified while the backlog drains,
      // so the table is a floor, not a complete list. Say that rather than imply completeness.
      const openedToday = await count((q) => q.gte("created_at", todaySince).eq("state", "open"));
      const classifiedToday = await count((q) => q.gte("created_at", todaySince).eq("state", "open").not("priority", "is", null));
      setTodayCoverage({ opened: openedToday, classified: classifiedToday });

      // The active count is open-minus-filtered, and the gap is ~3.4k issues. Query the
      // whole equation so the dashboard can show its own arithmetic instead of leaving
      // "active" to be misread as the repo's open count.
      const openTotal = await count((q) => q.eq("state", "open"));
      const filtered = await count((q) => q.eq("state", "open").eq("eligible", false));
      const reasons = await Promise.all(
        EXCLUDE_LABELS.map(async (lbl) =>
          [lbl, await count((q) => q.eq("state", "open").eq("eligible", false).contains("labels", [lbl]))] as [string, number]
        )
      );
      setTally({ open: openTotal, filtered, reasons: reasons.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]) });

      // Any kind — a catchup backfill changes classifications, so it is a data update too.
      const { data: b } = await supabase.from("batches").select("*").order("started_at", { ascending: false }).limit(1);
      setBatch(b ?? []);

      const [H, M, L] = await Promise.all([
        count((q) => q.eq("is_active", true).eq("priority", "H")),
        count((q) => q.eq("is_active", true).eq("priority", "M")),
        count((q) => q.eq("is_active", true).eq("priority", "L")),
      ]);
      setPrio({ H, M, L });

      const themeCounts = await Promise.all(
        Object.keys(THEME_NAMES).map(async (k) => [k, await count((q) => q.eq("is_active", true).eq("theme", k))] as [string, number])
      );
      setThemes(themeCounts.sort((a, b) => b[1] - a[1]));

      // 14 complete UTC days, ending yesterday. The current day is deliberately excluded: it is
      // always partial, and in the hours right after UTC midnight it is ~empty, which drew a
      // cliff to zero that read as "intake collapsed". Today's numbers are the 24h KPI tiles.
      const days: string[] = [], opened: number[] = [], closed: number[] = [];
      const dayStart = (d: Date) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };
      const jobs: PromiseLike<void>[] = [];
      for (let i = 14; i >= 1; i--) {
        const d0 = dayStart(new Date(Date.now() - i * 86400000));
        const d1 = new Date(d0.getTime() + 86400000);
        const idx = 14 - i; // i=14 → 0 (oldest) … i=1 → 13 (yesterday)
        days[idx] = d0.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
        jobs.push(
          supabase.from("issues").select("number", { count: "exact", head: true }).gte("created_at", d0.toISOString()).lt("created_at", d1.toISOString()).then(({ count }) => { opened[idx] = count ?? 0; }),
          supabase.from("issues").select("number", { count: "exact", head: true }).gte("closed_at", d0.toISOString()).lt("closed_at", d1.toISOString()).then(({ count }) => { closed[idx] = count ?? 0; })
        );
      }
      await Promise.all(jobs);
      setTrend({ opened, closed, days });
    })();
  }, [version]);

  const prioTotal = prio.H + prio.M + prio.L || 1;
  const maxTheme = Math.max(1, ...themes.map((t) => t[1]));

  return (
    <section className="view">
      <div className="greet">
        <Starburst />
        <h1 className="display">Claude Code GitHub Issues Dashboard</h1>
      </div>
      <div className="view-sub">
        {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} ·{" "}
        {kpi.active.toLocaleString()} active issues in anthropics/claude-code · pipeline healthy
      </div>

      <div className="grid grid-kpi">
        <Tile
          label="Active issues"
          value={kpi.active.toLocaleString()}
          sub={tally ? `of ${tally.open.toLocaleString()} open · ${tally.filtered.toLocaleString()} filtered` : "open & eligible"}
        />
        <Tile label="New issues (24h)" value={kpi.new24.toLocaleString()} sub="created in the last day" />
        <Tile label="Closed (24h)" value={kpi.closed24.toLocaleString()} sub="closed in the last day" />
        {/* Batch id / kind is ops detail — it lives in Batches & ops, not here. */}
        <Tile
          label="Last update"
          value={batch?.[0] ? timeET(batch[0].started_at) : "—"}
          sub={batch?.[0] && batch[0].status !== "ok" ? `last run ${batch[0].status}` : "data refreshed"}
        />
      </div>

      {tally && (
        <div className="card card-pad tally">
          <div className="tally-head">How the active count adds up</div>
          <div className="tally-row">
            <span className="tally-op" aria-hidden />
            <span className="tally-n">{tally.open.toLocaleString()}</span>
            <span className="tally-lbl">open in anthropics/claude-code</span>
          </div>
          <div className="tally-row">
            <span className="tally-op" aria-hidden>−</span>
            <span className="tally-n">{tally.filtered.toLocaleString()}</span>
            <span className="tally-lbl">
              filtered out
              {tally.reasons.length > 0 && (
                <span className="tally-why">
                  {tally.reasons.map(([lbl, n]) => `${lbl} ${n.toLocaleString()}`).join(" · ")}
                  <span className="tally-note"> — labels overlap, so these don’t sum</span>
                </span>
              )}
            </span>
          </div>
          <div className="tally-row tally-total">
            <span className="tally-op" aria-hidden>=</span>
            <span className="tally-n">{kpi.active.toLocaleString()}</span>
            <span className="tally-lbl">active — what this dashboard ranks</span>
          </div>
        </div>
      )}

      <div className="card card-pad">
        <div className="card-head">
          <div>
            <div className="card-title">New High priority · opened today</div>
            <div className="card-sub">
              Filed since 00:00 UTC and still open
              {todayCoverage && (
                <> · {todayCoverage.classified.toLocaleString()} of {todayCoverage.opened.toLocaleString()} today’s
                arrivals classified so far{todayCoverage.classified < todayCoverage.opened
                  ? " — the rest are still in the classify queue, so this list can grow"
                  : ""}</>
              )}
            </div>
          </div>
        </div>
        {todayHigh.length === 0 ? (
          <div style={{ color: "var(--text-3)", fontSize: 13, padding: "10px 2px" }}>
            No High-priority issues opened today yet.
          </div>
        ) : (
          <div className="table-card" style={{ border: "none", boxShadow: "none", borderRadius: 0 }}>
            <table className="master today-high">
              <thead>
                <tr>
                  <th>#</th><th>Title</th><th>Area</th><th>Theme</th>
                  <th style={{ textAlign: "right" }}>Reacts</th>
                  <th style={{ textAlign: "right" }}>Score</th>
                </tr>
              </thead>
              <tbody>
                {todayHigh.map((r) => (
                  <tr key={r.number} onClick={() => ctx.openDrawer(r)}>
                    <td className="t-num">#{r.number}</td>
                    <td className="t-title">{r.title}</td>
                    <td><span className="tag">{r.area ?? "—"}</span></td>
                    <td>{r.theme ? <span className="tag theme-t">{themeLabel(r.theme)}</span> : <span className="tag">—</span>}</td>
                    <td className="t-r">{fmtK(r.reactions_total)}</td>
                    <td className="t-r">{Math.round(r.final_rank_score ?? r.retrieval_score ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

function Tile({ label, value, sub, ok }: { label: string; value: string; sub?: string; ok?: string }) {
  return (
    <div className="card tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
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
