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
  const [batchTotal, setBatchTotal] = useState<number | null>(null);
  const [lastPull, setLastPull] = useState<Batch | null>(null);
  const version = useDataVersion();

  useEffect(() => {
    supabase.from("batches").select("*").order("started_at", { ascending: false }).limit(20).then(({ data }) => setBatches((data as Batch[]) ?? []));
    // Real count — the tile used to render batches.length, which is the page size (20), not
    // the number of batches on record.
    supabase.from("batches").select("id", { count: "exact", head: true }).then(({ count }) => setBatchTotal(count ?? 0));
    // The delta sync is the only thing that pulls from GitHub; backfill/recluster batches
    // rework what we already have. Tracked separately so a run of catchup batches can't make
    // the data look fresher upstream than it is.
    supabase.from("batches").select("*").eq("kind", "interval").order("started_at", { ascending: false }).limit(1)
      .then(({ data }) => setLastPull(((data ?? [])[0] as Batch) ?? null));
    supabase.from("sync_state").select("*").then(({ data }) => {
      const m: Record<string, string> = {};
      (data ?? []).forEach((r: any) => (m[r.key] = r.value));
      setState(m);
    });
  }, [version]);

  // The delta sync is scheduled every 2h; flag it once it has missed a few windows.
  const pullAgeH = lastPull ? Math.floor((Date.now() - new Date(lastPull.started_at).getTime()) / 3600000) : 0;
  const pullStale = !!lastPull && pullAgeH >= 6;

  const qaHigh = state.qa_high_share ? Math.round(parseFloat(state.qa_high_share) * 100) : null;

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="display">Batches &amp; ops</h1>
        <div className="view-sub">Pipeline health, classification quality, and the full sync history. Every batch links to its GitHub Actions run.</div>
      </div>

      <div className="grid grid-kpi cols-3">
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
          <span className="tile-value">{batchTotal ?? "—"}</span>
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
                    <td title={b.error ?? undefined}>
                      <span className={b.status === "ok" ? "run-ok" : "run-warn"} style={{ fontWeight: 600 }}>● {b.status}</span>
                    </td>
                    <td>{b.gha_run_url ? <a href={b.gha_run_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent-strong)" }}>logs ↗</a> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="card card-pad">
          <div className="card-head"><div><div className="card-title">Pipeline config</div><div className="card-sub">Current state</div></div></div>
          <div className="kv">
            <span>Last GitHub pull</span>
            <b className={pullStale ? "run-warn" : undefined}>
              {lastPull ? `${timeET(lastPull.started_at)} · batch #${lastPull.id}` : "—"}
              {pullStale ? ` · ${pullAgeH}h ago` : ""}
            </b>
          </div>
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
