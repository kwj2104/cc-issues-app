"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES } from "@/lib/types";
import { fmtAge, timeET } from "@/lib/format";
import { PriorityPill } from "../ui";
import type { ShellCtx } from "../AppShell";

type Row = VMaster & { batch_started_at: string };

export function Notable({ ctx, onCount }: { ctx: ShellCtx; onCount: (n: number) => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [acked, setAcked] = useState<Set<number>>(new Set());
  const [unackOnly, setUnackOnly] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from("v_new_high").select("*").limit(200).then(({ data }) => {
      setRows((data as Row[]) ?? []);
      setLoading(false);
      onCount((data ?? []).length);
    });
  }, [onCount]);

  const visible = rows.filter((r) => !unackOnly || !acked.has(r.number));
  const groups = Array.from(new Set(visible.map((r) => r.batch_id)));

  const ack = (n: number) => {
    setAcked((s) => new Set(s).add(n));
    ctx.toast(`#${n} acknowledged — triage write lands in Phase 4`);
  };

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="display">New &amp; Notable</h1>
        <div className="view-sub">Issues that passed <b>verified High</b>, grouped by sync batch. Acknowledge to clear them from the queue.</div>
      </div>
      <div className="toolbar">
        <span className={`chip-toggle${unackOnly ? " on" : ""}`} onClick={() => setUnackOnly((v) => !v)}>Unacknowledged only</span>
        <span className="toolbar-meta">{rows.filter((r) => !acked.has(r.number)).length} unacknowledged across {new Set(rows.map((r) => r.batch_id)).size} batches</span>
      </div>

      {loading && <div className="card card-pad skeleton">Loading verified-High queue…</div>}
      {!loading && visible.length === 0 && (
        <div className="card card-pad" style={{ textAlign: "center", color: "var(--text-3)" }}>
          Queue clear — every verified-High issue is acknowledged.
        </div>
      )}

      {groups.map((bid) => {
        const items = visible.filter((r) => r.batch_id === bid);
        if (!items.length) return null;
        return (
          <div className="batch-group" key={bid}>
            <div className="batch-head">
              <b>Batch #{bid}</b>
              <span>{timeET(items[0].batch_started_at)}</span>
              <span className="rule" />
              <span>{items.length} verified High</span>
            </div>
            {items.map((i) => (
              <div className={`card nn-card${acked.has(i.number) ? " acked" : ""}`} key={i.number}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
                  <PriorityPill priority={i.priority} verified={i.verified_high} />
                </div>
                <div className="nn-main" onClick={() => ctx.openDrawer(i)} style={{ cursor: "pointer" }}>
                  <div className="nn-title">{i.title}</div>
                  <div className="nn-meta">
                    <span className="t-num mono">#{i.number}</span>
                    {i.theme && <span className="tag theme-t">{THEME_NAMES[i.theme] ?? i.theme}</span>}
                    {i.area && <span className="tag">{i.area}</span>}
                    {i.verify_basis === "class-solo" && <span className="tag">solo report</span>}
                    <span>{(i.cluster_size ?? 1) > 1 ? `cluster ×${i.cluster_size}` : "singleton"}</span>
                    <span>{fmtAge(i.age_days)} ago</span>
                  </div>
                </div>
                <div className="nn-score"><b>{Math.round(i.final_rank_score ?? i.retrieval_score ?? 0)}</b><span>rank score</span></div>
                <button className="btn ack-btn" onClick={() => ack(i.number)}>{acked.has(i.number) ? "Acknowledged ✓" : "Acknowledge"}</button>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}
