"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { THEME_NAMES } from "@/lib/types";
import { timeET } from "@/lib/format";
import type { ShellCtx } from "../AppShell";
import { Starburst } from "../Icons";

const css = (v: string) => (typeof window !== "undefined" ? getComputedStyle(document.documentElement).getPropertyValue(v).trim() : "");

async function count(build: (q: any) => any): Promise<number> {
  const { count } = await build(supabase.from("v_master").select("number", { count: "exact", head: true }));
  return count ?? 0;
}

export function Dashboard({ ctx }: { ctx: ShellCtx }) {
  const [kpi, setKpi] = useState({ active: 0, new24: 0, vhigh: 0 });
  const [batch, setBatch] = useState<any>(null);
  const [prio, setPrio] = useState<{ H: number; M: number; L: number }>({ H: 0, M: 0, L: 0 });
  const [themes, setThemes] = useState<[string, number][]>([]);
  const [trend, setTrend] = useState<{ opened: number[]; closed: number[]; days: string[] }>({ opened: [], closed: [], days: [] });

  useEffect(() => {
    (async () => {
      const active = await count((q) => q.eq("is_active", true));
      const since = new Date(Date.now() - 86400000).toISOString();
      const { count: new24 } = await supabase.from("issues").select("number", { count: "exact", head: true }).gte("created_at", since);
      const { count: vhigh } = await supabase.from("v_new_high").select("number", { count: "exact", head: true });
      setKpi({ active, new24: new24 ?? 0, vhigh: vhigh ?? 0 });

      const { data: b } = await supabase.from("batches").select("*").in("kind", ["interval", "recluster"]).order("started_at", { ascending: false }).limit(5);
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

      // 14-day intake vs closes (per-day count queries)
      const days: string[] = [], opened: number[] = [], closed: number[] = [];
      const dayStart = (d: Date) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return x; };
      const jobs: PromiseLike<void>[] = [];
      for (let i = 13; i >= 0; i--) {
        const d0 = dayStart(new Date(Date.now() - i * 86400000));
        const d1 = new Date(d0.getTime() + 86400000);
        const idx = 13 - i;
        days[idx] = d0.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
        jobs.push(
          supabase.from("issues").select("number", { count: "exact", head: true }).gte("created_at", d0.toISOString()).lt("created_at", d1.toISOString()).then(({ count }) => { opened[idx] = count ?? 0; }),
          supabase.from("issues").select("number", { count: "exact", head: true }).gte("closed_at", d0.toISOString()).lt("closed_at", d1.toISOString()).then(({ count }) => { closed[idx] = count ?? 0; })
        );
      }
      await Promise.all(jobs);
      setTrend({ opened, closed, days });
    })();
  }, []);

  const prioTotal = prio.H + prio.M + prio.L || 1;
  const maxTheme = Math.max(1, ...themes.map((t) => t[1]));

  return (
    <section className="view">
      <div className="greet">
        <Starburst />
        <h1 className="display">Claude Code backlog</h1>
      </div>
      <div className="view-sub">
        {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} ·{" "}
        {kpi.active.toLocaleString()} active issues in anthropics/claude-code · pipeline healthy
      </div>

      <div className="grid grid-kpi">
        <Tile label="Active issues" value={kpi.active.toLocaleString()} sub="open & eligible" />
        <Tile label="New issues (24h)" value={kpi.new24.toLocaleString()} sub="created in the last day" />
        <Tile label="Verified High · open" value={String(kpi.vhigh)} sub="passed the adversarial pass" />
        <Tile
          label="Last sync"
          value={batch?.[0] ? timeET(batch[0].started_at) : "—"}
          ok={batch?.[0] ? `batch #${batch[0].id} · ${batch[0].status}` : undefined}
        />
      </div>

      <div className="grid grid-2a">
        <div className="card card-pad">
          <div className="card-head"><div><div className="card-title">Intake vs. closes</div><div className="card-sub">Issues opened and closed per day · last 14 days</div></div></div>
          <IntakeChart {...trend} />
        </div>
        <div className="card card-pad">
          <div className="card-head"><div><div className="card-title">Priority mix</div><div className="card-sub">LLM-classified active set · {prioTotal.toLocaleString()} issues</div></div></div>
          <PrioBar prio={prio} total={prioTotal} />
        </div>
      </div>

      <div className="grid grid-2b">
        <div className="card card-pad">
          <div className="card-head"><div><div className="card-title">Latest batches</div><div className="card-sub">Scheduled sync · every 2 hours</div></div>
            <div className="card-tools"><button className="btn" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => ctx.goMaster(null)}>Master list</button></div>
          </div>
          {(batch ?? []).map((b: any) => (
            <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "8.5px 2px", borderBottom: "1px solid var(--hairline)", fontSize: 12.5 }}>
              <span className="sync-dot" style={{ animation: "none", background: b.status === "ok" ? "var(--good)" : "var(--med-mark)" }} />
              <b style={{ fontVariantNumeric: "tabular-nums" }}>#{b.id}</b>
              <span style={{ color: "var(--text-3)" }}>{timeET(b.started_at)}</span>
              <span style={{ color: "var(--text-3)", marginLeft: "auto" }}>{b.kind === "recluster" ? "nightly recluster" : `${b.new_count} new · ${b.classified_count} classified`}</span>
              {b.new_high_count > 0 ? <span className="pill hi">{b.new_high_count} High</span> : <span style={{ color: "var(--micro)" }}>—</span>}
            </div>
          ))}
        </div>
        <div className="card card-pad">
          <div className="card-head"><div><div className="card-title">Open issues by theme</div><div className="card-sub">Classified active set</div></div></div>
          <svg className="chart-svg" viewBox={`0 0 560 ${themes.length * 30 + 6}`} width="100%">
            {themes.map(([k, n], i) => {
              const y = i * 30 + 8, bw = Math.max(6, (n / maxTheme) * (560 - 168 - 54));
              return (
                <g key={k}>
                  <text x={158} y={y + 11} textAnchor="end" className="axis-txt" style={{ fontSize: 12, fill: "var(--text-2)" }}>{THEME_NAMES[k]}</text>
                  <rect x={168} y={y} width={bw} height={14} rx={4} fill="var(--s1)" style={{ cursor: "pointer" }} onClick={() => ctx.goMaster({ theme: k })} />
                  <text x={168 + bw + 8} y={y + 11} className="axis-txt" style={{ fontSize: 11.5, fontWeight: 600, fill: "var(--text-2)" }}>{n}</text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      <div className="ask-bar">
        <Starburst className="spark-ic" />
        <input placeholder="Ask about this backlog…  e.g. “what changed in consent-enforcement this week?”" disabled />
        <span className="ask-model">Sonnet</span>
        <button className="ask-send" onClick={() => ctx.toast("Backlog Q&A ships in v2")} aria-label="Send">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ width: 15, height: 15 }}><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
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
        {series.map((s) => {
          const i = s.d.length - 1;
          return (
            <g key={s.n + "e"}>
              <circle cx={X(i)} cy={Y(s.d[i])} r={4.2} fill={s.c} stroke="var(--card)" strokeWidth={2} />
              <text x={X(i) + 10} y={Y(s.d[i]) + 4} className="axis-txt" style={{ fontSize: 11.5, fontWeight: 600, fill: "var(--text-2)" }}>{s.n} {s.d[i]}</text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        {series.map((s) => (
          <span key={s.n} className="legend-it"><span className="legend-line" style={{ background: s.c }} />{s.n}</span>
        ))}
      </div>
    </>
  );
}
