"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useDataVersion } from "@/lib/refresh";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES, themeLabel } from "@/lib/types";
import { fmtK, fmtAge, relDays } from "@/lib/format";
import { PriorityPill } from "../ui";
import { IconSearch } from "../Icons";
import type { ShellCtx, MasterPreset } from "../AppShell";

const PAGE = 50;

// Quiet severe: high-severity issues almost nobody has reacted to. The default sort is
// engagement-weighted by design, which is exactly what buries the silent data-loss / consent /
// billing class — this predicate is the counterweight that keeps them reachable. It does not
// change the ranking, it just filters to the rows the ranking hides.
const QUIET_MAX_REACTIONS = 10; // "near-zero" — tune against real data

// Sort key → (column, default direction). Priority sorts on priority_rank (H=1, M=2, L=3) so
// it groups High → Medium → Low: ordering on the letter itself reads H, L, M, and ordering on
// priority_score — a 0-100 LLM score — floats a strong Medium above a weak High.
const SORTS = {
  sc: { col: "retrieval_score", dir: -1, label: "Retrieval score" },
  rank: { col: "final_rank_score", dir: -1, label: "Blended rank score" },
  prio: { col: "priority_rank", dir: 1, label: "Priority" },
  new: { col: "created_at", dir: -1, label: "Most recent" },
  upd: { col: "updated_at", dir: -1, label: "Recently updated" },
  re: { col: "reactions_total", dir: -1, label: "Reactions" },
  vel: { col: "f_velocity", dir: -1, label: "Velocity" },
  age: { col: "age_days", dir: -1, label: "Age" },
  cl: { col: "cluster_size", dir: -1, label: "Cluster size" },
} as const;
type SortKey = keyof typeof SORTS;

// Offered in the toolbar dropdown; the numeric column headers reach the rest.
const SORT_MENU: SortKey[] = ["sc", "prio", "new", "upd", "rank"];

// "Desc/Asc" is meaningless for a rank column where 1 is best — say what the order does.
const dirLabel = (key: SortKey, dir: 1 | -1): string => {
  if (key === "prio") return dir === 1 ? "High first" : "Low first";
  if (key === "new" || key === "upd") return dir === -1 ? "Newest first" : "Oldest first";
  if (key === "age") return dir === -1 ? "Oldest first" : "Newest first";
  return dir === -1 ? "Highest first" : "Lowest first";
};

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
  const [quiet, setQuiet] = useState(!!preset?.quiet);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "new", dir: SORTS.new.dir });
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<VMaster[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const version = useDataVersion();

  useEffect(() => {
    setTheme(preset?.theme ?? "");
    setPrio(preset?.priority ?? "");
    setQuiet(!!preset?.quiet);
    setPage(0);
  }, [preset]);

  // reset to first page whenever a filter/sort changes
  useEffect(() => setPage(0), [q, type, theme, prio, tri, stateF, quiet, sort]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    let query = supabase.from("v_master").select("*", { count: "exact" });

    if (stateF === "active") query = query.eq("is_active", true);
    else if (stateF === "closed") query = query.eq("state", "closed");
    // Quiet severe is an extra predicate only — it never touches the sort.
    if (quiet) {
      query = query.eq("is_active", true).eq("priority", "H").lt("reactions_total", QUIET_MAX_REACTIONS);
    }
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
    query = query.order(SORTS[sort.key].col, { ascending: sort.dir === 1, nullsFirst: false });
    // Priority has only four distinct values, so rank inside the band by blended score
    // rather than letting the row-number tiebreak decide what a PM reads first.
    if (sort.key === "prio") query = query.order("final_rank_score", { ascending: false, nullsFirst: false });
    // Stable tiebreak so paging can't drop or repeat rows when the sort column ties.
    query = query.order("number", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);

    query.then(({ data, count, error }) => {
      if (cancelled) return;
      if (error) console.error(error);
      setRows((data as VMaster[]) ?? []);
      setTotal(count ?? 0);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [q, type, theme, prio, tri, stateF, quiet, sort, page, version]);

  const clickSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: SORTS[key].dir }));

  // The dropdown always shows the active sort, even when it was set by a column header.
  const menuKeys = SORT_MENU.includes(sort.key) ? SORT_MENU : [...SORT_MENU, sort.key];

  const scopeLabel = quiet
    ? `quiet-severe · High + <${QUIET_MAX_REACTIONS} 👍`
    : stateF === "active" ? "active" : stateF === "closed" ? "closed · index keeps history" : "indexed (open + closed)";
  const pages = Math.ceil(total / PAGE);

  const arr = (key: SortKey) => (sort.key === key ? (sort.dir === -1 ? " ▼" : " ▲") : "");
  const themeOptions = useMemo(() => Object.entries(THEME_NAMES), []);

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="display">Master list</h1>
        <div className="view-sub">
          Every active issue, newest first by default. Sort by <b>Retrieval score</b> to rank by the
          deterministic signal — engagement velocity × severity × duplicate mass.
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
          {/* "none" is a real classifier verdict (fits none of the seven), not missing data. */}
          <option value="none">Other</option>
        </select>
        <select className="sel" value={prio} onChange={(e) => setPrio(e.target.value)}>
          <option value="">Priority · all</option>
          <option value="H">High</option><option value="M">Medium</option><option value="L">Low</option>
        </select>
        <button
          className={`chip-toggle${quiet ? " on" : ""}`}
          aria-pressed={quiet}
          title={`High priority with fewer than ${QUIET_MAX_REACTIONS} reactions — severe issues the engagement-weighted ranking buries`}
          onClick={() => setQuiet((v) => !v)}
        >
          ◇ Quiet severe
        </button>
        <select className="sel" value={tri} onChange={(e) => setTri(e.target.value)}>
          <option value="">Triage · all</option>
          {TRIAGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select className="sel" value={stateF} onChange={(e) => setStateF(e.target.value)}>
          <option value="active">State · active</option>
          <option value="closed">Closed</option>
          <option value="">All indexed</option>
        </select>
        <div className="sort-group">
          <select
            className="sel"
            value={sort.key}
            onChange={(e) => {
              const key = e.target.value as SortKey;
              setSort({ key, dir: SORTS[key].dir });
            }}
          >
            {menuKeys.map((k) => (
              <option key={k} value={k}>Sort · {SORTS[k].label}</option>
            ))}
          </select>
          <button
            className="btn btn-sm"
            title="Reverse sort direction"
            onClick={() => setSort((s) => ({ ...s, dir: (s.dir * -1) as 1 | -1 }))}
          >
            ⇅ {dirLabel(sort.key, sort.dir)}
          </button>
        </div>
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
              <th className="sortable" style={{ textAlign: "right" }} onClick={() => clickSort("upd")} title="Time since the issue last saw activity (GitHub updated_at — comment, edit, or label change)">Last activity{arr("upd")}</th>
              <th className="sortable" style={{ textAlign: "right" }} onClick={() => clickSort("cl")}>Cluster{arr("cl")}</th>
              <th>Triage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const closed = r.state === "closed";
              const score = Math.round(r.retrieval_score ?? 0);
              // Full theme name, not the old first-word abbreviation — "Lost" and "Ignored"
              // carry nothing on their own, and the names are short enough to show whole.
              const themeTag = themeLabel(r.theme);
              return (
                <tr key={r.number} className={closed ? "closed" : undefined} onClick={() => ctx.openDrawer(r)}>
                  <td className="t-num">#{r.number}</td>
                  <td className="t-title">
                    {r.title}
                    {closed ? <span className="tag">{closeTag(r)}</span> : themeTag ? <span className="tag theme-t">{themeTag}</span> : null}
                  </td>
                  <td><span className="tag">{r.type ?? "—"}</span></td>
                  <td><span className="tag">{r.area ?? "—"}</span></td>
                  <td>{r.priority ? <PriorityPill priority={r.priority} /> : <span className="tag">unclassified</span>}</td>
                  <td>
                    <div className="score-cell">
                      <span className="score-bar"><i style={{ width: `${Math.min(100, score)}%` }} /></span>
                      <span className="score-n">{score}</span>
                    </div>
                  </td>
                  <td className="t-r">{fmtK(r.reactions_total)}</td>
                  <td className="t-r">{(r.f_velocity ?? 0).toFixed(1)}</td>
                  <td className="t-r">{fmtAge(r.age_days)}</td>
                  <td className="t-r">{relDays(r.updated_at)}</td>
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
              <tr><td className="empty-row" colSpan={12}>No issues match these filters.</td></tr>
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
