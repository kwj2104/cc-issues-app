"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useDataVersion } from "@/lib/refresh";
import type { Batch } from "@/lib/types";
import { timeET } from "@/lib/format";

const dur = (b: Batch) => {
  if (!b.finished_at) return "—";
  const s = (new Date(b.finished_at).getTime() - new Date(b.started_at).getTime()) / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};

export function Ops() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [state, setState] = useState<Record<string, string>>({});
  const [vhigh, setVhigh] = useState<number | null>(null);
  const version = useDataVersion();

  useEffect(() => {
    supabase.from("batches").select("*").order("started_at", { ascending: false }).limit(20).then(({ data }) => setBatches((data as Batch[]) ?? []));
    supabase.from("v_new_high").select("number", { count: "exact", head: true }).then(({ count }) => setVhigh(count ?? 0));
    supabase.from("sync_state").select("*").then(({ data }) => {
      const m: Record<string, string> = {};
      (data ?? []).forEach((r: any) => (m[r.key] = r.value));
      setState(m);
    });
  }, [version]);

  const qaArea = state.qa_area_agreement ? Math.round(parseFloat(state.qa_area_agreement) * 100) : null;
  const qaHigh = state.qa_high_share ? Math.round(parseFloat(state.qa_high_share) * 100) : null;

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="display">Batches &amp; ops</h1>
        <div className="view-sub">Pipeline health, classification quality, and the full sync history. Every batch links to its GitHub Actions run.</div>
      </div>

      <div className="card card-pad explain-card">
        <div className="explain-figure">
          <span className="explain-value">{vhigh ?? "—"}</span>
          <span className="explain-cap">Verified High · open</span>
        </div>
        <div className="explain-body">
          <div className="card-title">What &ldquo;Verified High&rdquo; means</div>
          <p>
            Every issue gets a priority from the classifier. Anything it calls <b>High</b> then has to
            survive a <b>second, adversarial pass</b>: a fresh model run is handed the issue plus hard
            numbers — how much engagement it has drawn compared with issues of the same age, how many
            near-duplicate reports exist, how long since anyone touched it, and whether the newest
            release already shipped a fix — and is asked to argue the rating <i>down</i>.
          </p>
          <p>
            It throws out cosmetic complaints, anything with a workable workaround, and anything
            already stale against the current release. It keeps issues it cannot talk down. A serious
            enough class of problem — data loss, security, consent failures, billing — can pass on a
            single report, but only when that report carries a concrete mechanism and a reproduction.
          </p>
          <p className="explain-foot">
            So the count above is <b>&ldquo;how many open issues survived being argued against&rdquo;</b> — a
            read-first queue, not a severity score. The full list lives in <b>New &amp; Notable</b>.
          </p>
        </div>
      </div>

      <div className="grid grid-kpi">
        <div className="card tile">
          <span className="tile-label">Area agreement</span>
          <span className="tile-value">{qaArea != null ? qaArea + "%" : "—"}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
            <div className="meter"><i style={{ width: `${qaArea ?? 0}%` }} /></div>
            <span style={{ fontSize: 11, color: "var(--micro)" }}>floor 85</span>
          </div>
        </div>
        <div className="card tile">
          <span className="tile-label">High share (weekly QA)</span>
          <span className="tile-value">{qaHigh != null ? qaHigh + "%" : "—"}</span>
          <span className="tile-delta">{qaHigh != null ? <span className={`pill ${qaHigh >= 15 && qaHigh <= 25 ? "ok" : "hi"}`} style={{ fontSize: 10.5 }}>{qaHigh >= 15 && qaHigh <= 25 ? "in 15–25% band" : "out of band"}</span> : <span style={{ color: "var(--text-3)" }}>first sample Sunday</span>}</span>
        </div>
        <div className="card tile">
          <span className="tile-label">Latest release seen</span>
          <span className="tile-value" style={{ fontSize: 20 }}>{state.latest_release_tag || "—"}</span>
          <span className="tile-delta"><span style={{ color: "var(--text-3)" }}>{state.latest_release_date ? new Date(state.latest_release_date).toLocaleDateString() : "staleness reference"}</span></span>
        </div>
        <div className="card tile">
          <span className="tile-label">Batches recorded</span>
          <span className="tile-value">{batches.length}</span>
          <span className="tile-ok"><span className="sync-dot" style={{ animation: "none" }} />cron every 2h</span>
        </div>
      </div>

      <div className="grid grid-2a">
        <div className="card card-pad">
          <div className="card-head"><div><div className="card-title">Latest batches</div><div className="card-sub">Most recent 20 syncs · times ET · every batch links to its Actions run</div></div></div>
          <div style={{ overflowX: "auto" }}>
            <table className="chart-table ops-table">
              <thead><tr><th>Batch</th><th>Kind</th><th>Time</th><th>Duration</th><th>New</th><th>Classified</th><th>New High</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td style={{ fontWeight: 600 }}>#{b.id}</td>
                    <td>{b.kind}</td>
                    <td>{timeET(b.started_at)}</td>
                    <td>{dur(b)}</td>
                    <td>{b.new_count}</td>
                    <td>{b.classified_count}</td>
                    <td>{b.new_high_count > 0 ? <span className="pill hi">{b.new_high_count}</span> : "0"}</td>
                    <td><span className={b.status === "ok" ? "run-ok" : "run-warn"} style={{ fontWeight: 600 }}>● {b.status}</span></td>
                    <td>{b.gha_run_url ? <a href={b.gha_run_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-strong)" }}>logs ↗</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card card-pad">
          <div className="card-head"><div><div className="card-title">Pipeline config</div><div className="card-sub">Current state</div></div></div>
          <div className="kv"><span>Cursor (updated_at)</span><b className="mono" style={{ fontSize: 11 }}>{state.since_cursor?.slice(0, 19) ?? "—"}</b></div>
          <div className="kv"><span>Cadence</span><b>every 2h · GH Actions</b></div>
          <div className="kv"><span>Classifier</span><b>Sonnet · headless</b></div>
          <div className="kv"><span>Rubric</span><b className="mono">{state.rubric_version ?? "v2.0"}</b></div>
          <div className="kv"><span>Schema</span><b className="mono">v{state.schema_version ?? "1.2"}</b></div>
          <div className="kv"><span>Verify pass</span><b>v1.2 · veto + credibility</b></div>
          <div className="kv"><span>Blend weights</span><b className="mono">.45 / .25 / .20 / .10</b></div>
          <div className="kv"><span>Latest release</span><b>{state.latest_release_tag ?? "—"}</b></div>
        </div>
      </div>
    </section>
  );
}
