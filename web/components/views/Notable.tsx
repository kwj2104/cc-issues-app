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

// The verify pass confirms on two different grounds, and they mean different things to whoever
// works the queue: breadth-backed confirms are ready to escalate, single-report confirms of a
// severe class are leads to investigate (the lane is deliberately permissive, so some are false
// positives by design). Splitting them here is what keeps that distinction from being lost.
const LANES = [
  {
    basis: "corroborated",
    title: "Corroborated",
    blurb: "breadth-backed — duplicate cluster and/or top age-band engagement · escalate directly",
  },
  {
    basis: "class-solo",
    title: "Leads · solo report",
    blurb: "one credible report of a data-loss / security / consent / billing defect · investigate before escalating",
  },
] as const;

// No per-issue verify reason exists in the schema yet, so this is lane-level copy, not a
// fabricated per-issue string.
const SOLO_NOTE = "Single credible report — kept because for this class corroboration often never arrives.";

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

export function Notable({ ctx, onCount }: { ctx: ShellCtx; onCount: (n: number) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [kinds, setKinds] = useState<Record<number, string>>({});
  const version = useDataVersion();

  useEffect(() => {
    supabase.from("v_new_high").select("*").limit(200).then(({ data }) => {
      setRows((data as Row[]) ?? []);
      setLoading(false);
      onCount((data ?? []).length);
    });
    // v_new_high carries the batch's start time but not its kind; fetch it so each group can
    // say why its issues are there.
    supabase.from("batches").select("id, kind").order("id", { ascending: false }).limit(80)
      .then(({ data }) => setKinds(Object.fromEntries((data ?? []).map((b: any) => [b.id, b.kind]))));
  }, [onCount, version]);

  const groups = Array.from(new Set(rows.map((r) => r.batch_id)));
  const totals = {
    corr: rows.filter((r) => r.verify_basis === "corroborated").length,
    solo: rows.filter((r) => r.verify_basis === "class-solo").length,
  };

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="display">New &amp; Notable</h1>
        <div className="view-sub">
          High-priority issues whose rating <b>held up under a second, challenging pass</b>, split into two
          lanes: <b>corroborated</b> (breadth backs it — escalate) and <b>leads</b> (one credible report of a
          severe class — investigate first). The check itself is explained in <b>Batches &amp; ops</b>.
          <br />
          Grouped by the batch that <b>classified</b> it, which is not when it was filed — a catch-up batch
          works through the unclassified backlog, so its issues can be months old.
        </div>
      </div>
      <div className="toolbar">
        <span className="toolbar-meta">
          {totals.corr} corroborated · {totals.solo} lead{totals.solo === 1 ? "" : "s"} across{" "}
          {new Set(rows.map((r) => r.batch_id)).size} batches
        </span>
      </div>

      {loading && <div className="card card-pad skeleton">Loading queue…</div>}
      {!loading && rows.length === 0 && (
        <div className="card card-pad" style={{ textAlign: "center", color: "var(--text-3)" }}>
          Nothing here yet — corroborated confirms and solo-report leads appear as the sync classifies
          new arrivals.
        </div>
      )}

      {groups.map((bid) => {
        const items = rows.filter((r) => r.batch_id === bid);
        if (!items.length) return null;

        const lanes = LANES.map((l) => ({ ...l, items: items.filter((i) => i.verify_basis === l.basis) }));
        const placed = lanes.reduce((n, l) => n + l.items.length, 0);
        // Older rows predate verify_basis — fall back to the flat list rather than hiding them.
        const unlaned = items.filter((i) => i.verify_basis !== "corroborated" && i.verify_basis !== "class-solo");
        const corrN = lanes[0].items.length;
        const soloN = lanes[1].items.length;

        return (
          <div className="batch-group" key={bid}>
            <div className="batch-head">
              <b>Batch #{bid}</b>
              <span>{timeET(items[0].batch_started_at)}</span>
              {kinds[bid as number] && <span>· {BATCH_KIND_NOTE[kinds[bid as number]] ?? kinds[bid as number]}</span>}
              <span className="rule" />
              <span>
                {placed === 0
                  ? `${items.length} verified High`
                  : `${corrN} corroborated · ${soloN} lead${soloN === 1 ? "" : "s"}`}
              </span>
            </div>

            {lanes.map((lane) =>
              lane.items.length === 0 ? null : (
                <div key={lane.basis}>
                  <div className="nn-lane-h">
                    <b style={{ color: "var(--text-2)" }}>{lane.title}</b>
                    <span>· {lane.blurb}</span>
                  </div>
                  {lane.items.map((i) => (
                    <NotableCard key={i.number} row={i} ctx={ctx} note={lane.basis === "class-solo" ? SOLO_NOTE : null} />
                  ))}
                </div>
              )
            )}

            {unlaned.map((i) => <NotableCard key={i.number} row={i} ctx={ctx} note={null} />)}
          </div>
        );
      })}
    </section>
  );
}

function NotableCard({ row: i, ctx, note }: { row: Row; ctx: ShellCtx; note: string | null }) {
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
          <span>{(i.cluster_size ?? 1) > 1 ? `cluster ×${i.cluster_size}` : "singleton"}</span>
          {/* Both off created_at/updated_at and the live clock. age_days is a stored feature
              recomputed nightly, so pairing it with a live relDays() drew "opened 29d ago ·
              updated 30d ago" — an issue updated before it was filed. */}
          <span>opened {relDays(i.created_at)} ago</span>
          <span>updated {relDays(i.updated_at)} ago</span>
        </div>
        {note && <div className="nn-vr">{note}</div>}
      </div>
      <div className="nn-score"><b>{Math.round(i.final_rank_score ?? i.retrieval_score ?? 0)}</b><span>rank score</span></div>
    </div>
  );
}
