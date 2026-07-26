"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useDataVersion } from "@/lib/refresh";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES, themeLabel } from "@/lib/types";
import { relDays, timeET } from "@/lib/format";
import { PriorityPill } from "../ui";
import type { ShellCtx } from "../AppShell";

type Row = VMaster & { batch_started_at: string };

// Batches group by *when the classifier first looked at an issue*, not by when the issue was
// filed — so an issue opened months ago lands in today's batch. Why it landed there depends on
// the batch kind, and that is the difference between "this changed today" and "we finally got
// to it", so the header says which.
const BATCH_KIND_NOTE: Record<string, string> = {
  interval: "changed since the last sync",
  backfill: "backlog catch-up — classified for the first time",
  recluster: "nightly recluster",
  seed: "seed review import",
};

export function Notable({ ctx }: { ctx: ShellCtx }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [kinds, setKinds] = useState<Record<number, string>>({});
  const version = useDataVersion();

  useEffect(() => {
    supabase.from("v_new_high").select("*").limit(200).then(({ data }) => {
      setRows((data as Row[]) ?? []);
      setLoading(false);
    });
    // v_new_high carries the batch's start time but not its kind; fetch it so each group can
    // say why its issues are there.
    supabase.from("batches").select("id, kind").order("id", { ascending: false }).limit(80)
      .then(({ data }) => setKinds(Object.fromEntries((data ?? []).map((b: any) => [b.id, b.kind]))));
  }, [version]);

  const groups = Array.from(new Set(rows.map((r) => r.batch_id)));

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="display">New &amp; Notable</h1>
      </div>
      <div className="toolbar">
        <span className="toolbar-meta">
          {rows.length} issue{rows.length === 1 ? "" : "s"} across{" "}
          {new Set(rows.map((r) => r.batch_id)).size} batches
        </span>
      </div>

      {loading && <div className="card card-pad skeleton">Loading queue…</div>}
      {!loading && rows.length === 0 && (
        <div className="card card-pad" style={{ textAlign: "center", color: "var(--text-3)" }}>
          Nothing here yet — issues appear as the sync classifies new arrivals.
        </div>
      )}

      {groups.map((bid) => {
        const items = rows.filter((r) => r.batch_id === bid);
        if (!items.length) return null;

        return (
          <div className="batch-group" key={bid}>
            <div className="batch-head">
              <b>Batch #{bid}</b>
              <span>{timeET(items[0].batch_started_at)}</span>
              {kinds[bid as number] && <span>· {BATCH_KIND_NOTE[kinds[bid as number]] ?? kinds[bid as number]}</span>}
              <span className="rule" />
              <span>{items.length} issue{items.length === 1 ? "" : "s"}</span>
            </div>

            {items.map((i) => <NotableCard key={i.number} row={i} ctx={ctx} />)}
          </div>
        );
      })}
    </section>
  );
}

function NotableCard({ row: i, ctx }: { row: Row; ctx: ShellCtx }) {
  return (
    <div className="card nn-card" onClick={() => ctx.openDrawer(i)} style={{ cursor: "pointer" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
        <PriorityPill priority={i.priority} />
      </div>
      <div className="nn-main">
        <div className="nn-title">{i.title}</div>
        <div className="nn-meta">
          <span className="t-num mono">#{i.number}</span>
          {i.theme && <span className="tag theme-t">{themeLabel(i.theme)}</span>}
          {i.area && <span className="tag">{i.area}</span>}
          <span>{(i.cluster_size ?? 1) > 1 ? `${(i.cluster_size ?? 1) - 1} duplicates` : "no duplicates"}</span>
          {/* Both off created_at/updated_at and the live clock. age_days is a stored feature
              recomputed nightly, so pairing it with a live relDays() drew "opened 29d ago ·
              updated 30d ago" — an issue updated before it was filed. */}
          <span>opened {relDays(i.created_at)} ago</span>
          <span>updated {relDays(i.updated_at)} ago</span>
        </div>
      </div>
      <div className="nn-score"><b>{Math.round(i.final_rank_score ?? i.retrieval_score ?? 0)}</b><span>rank score</span></div>
    </div>
  );
}
