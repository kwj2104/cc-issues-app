"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES } from "@/lib/types";
import { fmtK, fmtAge, relDays } from "@/lib/format";
import { PriorityPill } from "../ui";
import { IconSearch } from "../Icons";
import type { ShellCtx, MasterPreset } from "../AppShell";

const PAGE = 50;
const SORTS = { sc: "retrieval_score", re: "reactions_total", vel: "f_velocity", age: "age_days", cl: "cluster_size" } as const;
type SortKey = keyof typeof SORTS;

const TYPES = ["Bug", "Feature Request", "Question/Support", "Docs", "Other/Meta"];
const TRIAGE = [
  ["untriaged", "Untriaged"], ["acknowledged", "Acknowledged"], ["investigating", "Investigating"],
  ["escalated", "Escalated"], ["resolved", "Resolved"], ["wontfix", "Won’t fix"],
];

const closeTag = (r: VMaster) =>
  r.state_reason === "completed" ? "fixed — completed"
  : r.state_reason === "duplicate" ? "duplicate"
  : r.state_reason === "not_planned" ? "not planned"
  : "closed";

export function MasterList({ ctx, preset }: { ctx: ShellCtx; preset: MasterPreset }) {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [theme, setTheme] = useState(preset?.theme ?? "");
  const [prio, setPrio] = useState(preset?.priority ?? "");
  const [tri, setTri] = useState("");
  const [stateF, setStateF] = useState("active");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "sc", dir: -1 });
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<VMaster[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setTheme(preset?.theme ?? "");
    setPrio(preset?.priority ?? "");
    setPage(0);
  }, [preset]);

  // reset to first page whenever a filter/sort changes
  useEffect(() => setPage(0), [q, type, theme, prio, tri, stateF, sort]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    let query = supabase.from("v_master").select("*", { count: "exact" });

    if (stateF === "active") query = query.eq("is_active", true);
    else if (stateF === "closed") query = query.eq("state", "closed");
    if (type) query = query.eq("type", type);
    if (theme) query = query.eq("theme", theme);
    if (prio) query = query.eq("priority", prio);
    if (tri) query = query.eq("triage_status", tri);
    if (q.trim()) {
      const clean = q.trim().replace(/^#/, "");
      query = /^\d+$/.test(clean)
        ? query.or(`number.eq.${clean},title.ilike.%${clean}%`)
        : query.ilike("title", `%${clean}%`);
    }
    query = query
      .order(SORTS[sort.key], { ascending: sort.dir === 1, nullsFirst: false })
      .range(page * PAGE, page * PAGE + PAGE - 1);

    query.then(({ data, count, error }) => {
      if (cancelled) return;
      if (error) console.error(error);
      setRows((data as VMaster[]) ?? []);
      setTotal(count ?? 0);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [q, type, theme, prio, tri, stateF, sort, page]);

  const clickSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));

  const scopeLabel = stateF === "active" ? "active" : stateF === "closed" ? "closed · index keeps history" : "indexed (open + closed)";
  const pages = Math.ceil(total / PAGE);

  const arr = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? " ▼" : " ▲") : "");
  const themeOptions = useMemo(() => Object.entries(THEME_NAMES), []);

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="display">Master list</h1>
        <div className="view-sub">
          Every active issue, ranked by the deterministic retrieval score — engagement velocity × severity × duplicate mass.
        </div>
      </div>

      <div className="toolbar">
        <div className="search">
          <IconSearch />
          <input placeholder="Search title or #number…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="sel" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Type · all</option>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="sel" value={theme} onChange={(e) => setTheme(e.target.value)}>
          <option value="">Theme · all</option>
          {themeOptions.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
        </select>
        <select className="sel" value={prio} onChange={(e) => setPrio(e.target.value)}>
          <option value="">Priority · all</option>
          <option value="H">High</option><option value="M">Medium</option><option value="L">Low</option>
        </select>
        <select className="sel" value={tri} onChange={(e) => setTri(e.target.value)}>
          <option value="">Triage · all</option>
          {TRIAGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="sel" value={stateF} onChange={(e) => setStateF(e.target.value)}>
          <option value="active">State · active</option>
          <option value="closed">Closed</option>
          <option value="">All indexed</option>
        </select>
        <span className="toolbar-meta">
          {loading ? "loading…" : `${total.toLocaleString()} ${scopeLabel} · page ${page + 1}/${Math.max(1, pages)}`}
        </span>
      </div>

      <div className="card table-card">
        <table className="master">
          <thead>
            <tr>
              <th>#</th><th>Title</th><th>Type</th><th>Area</th><th>Priority</th>
              <th className="sortable" style={{ textAlign: "right" }} onClick={() => clickSort("sc")}>Score{arr("sc")}</th>
              <th className="sortable" style={{ textAlign: "right" }} onClick={() => clickSort("re")}>Reacts{arr("re")}</th>
              <th className="sortable" style={{ textAlign: "right" }} onClick={() => clickSort("vel")}>Vel{arr("vel")}</th>
              <th className="sortable" style={{ textAlign: "right" }} onClick={() => clickSort("age")}>Age{arr("age")}</th>
              <th className="sortable" style={{ textAlign: "right" }} onClick={() => clickSort("cl")}>Cluster{arr("cl")}</th>
              <th>Triage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const closed = r.state === "closed";
              const score = Math.round(r.retrieval_score ?? 0);
              const themeShort = r.theme ? THEME_NAMES[r.theme]?.split(" ")[0].replace("&", "") : null;
              return (
                <tr key={r.number} className={closed ? "closed" : undefined} onClick={() => ctx.openDrawer(r)}>
                  <td className="t-num">#{r.number}</td>
                  <td className="t-title">
                    {r.title}
                    {closed ? <span className="tag">{closeTag(r)}</span> : themeShort ? <span className="tag theme-t">{themeShort}</span> : null}
                  </td>
                  <td><span className="tag">{r.type ?? "—"}</span></td>
                  <td><span className="tag">{r.area ?? "—"}</span></td>
                  <td>{r.priority ? <PriorityPill priority={r.priority} verified={r.verified_high} compact /> : <span className="tag">unclassified</span>}</td>
                  <td>
                    <div className="score-cell">
                      <span className="score-bar"><i style={{ width: `${Math.min(100, score)}%` }} /></span>
                      <span className="score-n">{score}</span>
                    </div>
                  </td>
                  <td className="t-r">{fmtK(r.reactions_total)}</td>
                  <td className="t-r">{(r.f_velocity ?? 0).toFixed(1)}</td>
                  <td className="t-r">{fmtAge(r.age_days)}</td>
                  <td className="t-r">{(r.cluster_size ?? 1) > 1 ? "×" + r.cluster_size : "—"}</td>
                  <td>
                    {closed ? (
                      <span className="tri-chip"><span className="tri-dot" style={{ background: r.state_reason === "completed" ? "var(--good)" : "var(--micro)" }} />Closed {relDays(r.closed_at)} ago</span>
                    ) : (
                      <span className={`tri-chip ${triClass(r.triage_status)}`}><span className="tri-dot" />{triLabel(r.triage_status)}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && rows.length === 0 && (
              <tr><td className="empty-row" colSpan={11}>No issues match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="toolbar" style={{ marginTop: 14, justifyContent: "flex-end" }}>
          <button className="btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>← Prev</button>
          <button className="btn" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
        </div>
      )}
    </section>
  );
}

function triLabel(s: string | null) {
  return { untriaged: "Untriaged", acknowledged: "Ack’d", investigating: "Investigating", escalated: "Escalated",
    resolved: "Resolved", wontfix: "Won’t fix", "resolved-upstream-confirm": "Confirm upstream" }[s ?? "untriaged"] ?? "Untriaged";
}
function triClass(s: string | null) {
  return { acknowledged: "tri-ack", investigating: "tri-inv", escalated: "tri-esc" }[s ?? ""] ?? "";
}
