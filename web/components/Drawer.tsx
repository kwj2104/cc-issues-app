"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES, themeLabel } from "@/lib/types";
import { fmtK, fmtAge, relDays } from "@/lib/format";
import { PriorityPill } from "./ui";
import { IconClose, IconExternal } from "./Icons";

export function Drawer({ row, onClose }: { row: VMaster | null; onClose: () => void }) {
  const [members, setMembers] = useState<number[]>([]);
  const [body, setBody] = useState<string | null>(null);

  useEffect(() => {
    setMembers([]);
    setBody(null);
    if (!row) return;
    if (row.cluster_id && (row.cluster_size ?? 1) > 1) {
      supabase.from("v_master").select("number").eq("cluster_id", row.cluster_id).neq("number", row.number)
        .order("reactions_total", { ascending: false }).limit(6)
        .then(({ data }) => setMembers((data ?? []).map((d: any) => d.number)));
    }
    // live body from the public GitHub API (unauthenticated; light use)
    fetch(`https://api.github.com/repos/anthropics/claude-code/issues/${row.number}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setBody(j?.body ? String(j.body).slice(0, 1400) : ""))
      .catch(() => setBody(""));
  }, [row]);

  const closed = row?.state === "closed";

  return (
    <aside className={`drawer${row ? " on" : ""}`}>
      {row && (
        <>
          <div className="drawer-head">
            <div className="drawer-top">
              <a className="gh-link" href={row.html_url} target="_blank" rel="noopener noreferrer">
                #{row.number} · open on GitHub <IconExternal width={11} height={11} />
              </a>
              <button className="icon-btn drawer-close" onClick={onClose} aria-label="Close"><IconClose /></button>
            </div>
            <div className="drawer-title">{row.title}</div>
            <div className="badge-row">
              {row.priority ? <PriorityPill priority={row.priority} /> : <span className="tag">unclassified</span>}
              {closed && <span className="pill ok">Closed · {row.state_reason ?? "closed"}</span>}
              {row.type && <span className="tag">{row.type}</span>}
              {row.area && <span className="tag">{row.area}</span>}
              {row.theme && <span className="tag theme-t">{themeLabel(row.theme)}</span>}
            </div>
          </div>

          <div className="drawer-body">
            {row.summary && (
              <div className="d-sec">
                <div className="d-label">Summary</div>
                <div className="d-summary">{row.summary}</div>
              </div>
            )}

            <div className="d-sec">
              <div className="d-label">Signals</div>
              <div className="sig-grid">
                <div className="sig"><b>{fmtK(row.reactions_total)}</b><span>reactions</span></div>
                <div className="sig"><b>{fmtK(row.comments)}</b><span>comments</span></div>
                <div className="sig"><b>{fmtAge(row.age_days)}</b><span>age</span></div>
                <div className="sig"><b>{Math.max(0, (row.cluster_size ?? 1) - 1)}</b><span>duplicates</span></div>
                <div className="sig"><b>{closed ? "closed" : "active"}</b><span>{closed ? row.state_reason ?? "closed" : "status"}</span></div>
              </div>
            </div>

            {members.length > 0 && (
              <div className="d-sec">
                <div className="d-label">Duplicates</div>
                <div className="cluster-chips">
                  {members.map((m) => <span key={m} className="cchip">#{m}</span>)}
                  {(row.cluster_size ?? 1) - 1 > members.length && <span className="cchip" style={{ borderStyle: "dashed" }}>+{(row.cluster_size ?? 1) - 1 - members.length} more</span>}
                </div>
              </div>
            )}

            {body != null && body !== "" && (
              <div className="d-sec">
                <div className="d-label">Live body · fetched from GitHub</div>
                <div className="d-summary" style={{ fontSize: 13, color: "var(--text-2)", whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>{body}</div>
              </div>
            )}

            <div className="d-meta">
              <span>first seen {fmtAge(row.age_days)} ago</span>
              {closed && <span>closed {relDays(row.closed_at)} ago</span>}
              <span>rubric {row.rubric_version ?? "v2.0"}</span>
              <span>model: {row.model ?? "—"}</span>
              <span>{row.batch_id ? "classified in batch #" + row.batch_id : row.analysis_source === "seed-review" ? "imported from seed review" : "not yet classified"}</span>
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
