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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.from("v_new_high").select("*").limit(200).then(({ data }) => {
      setRows((data as Row[]) ?? []);
      setLoading(false);
      onCount((data ?? []).length);
    });
  }, [onCount]);

  const groups = Array.from(new Set(rows.map((r) => r.batch_id)));

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="display">New &amp; Notable</h1>
        <div className="view-sub">Issues that passed <b>verified High</b>, grouped by sync batch — newest first.</div>
      </div>
      <div className="toolbar">
        <span className="toolbar-meta">{rows.length} verified-High across {new Set(rows.map((r) => r.batch_id)).size} batches</span>
      </div>

      {loading && <div className="card card-pad skeleton">Loading verified-High queue…</div>}
      {!loading && rows.length === 0 && (
        <div className="card card-pad" style={{ textAlign: "center", color: "var(--text-3)" }}>
          No open verified-High issues yet — they appear here as the sync classifies new arrivals.
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
              <span className="rule" />
              <span>{items.length} verified High</span>
            </div>
            {items.map((i) => (
              <div className="card nn-card" key={i.number} onClick={() => ctx.openDrawer(i)} style={{ cursor: "pointer" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-start" }}>
                  <PriorityPill priority={i.priority} verified={i.verified_high} />
                </div>
                <div className="nn-main">
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
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}
