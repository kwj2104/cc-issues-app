"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES, themeLabel } from "@/lib/types";
import { fmtK, fmtAge, relDays } from "@/lib/format";
import { PriorityPill } from "./ui";
import { IconClose, IconExternal } from "./Icons";

// Illustrative 0-100 normalization of the four blend components (exact weights in pipeline
// config; population-normalized components are computed server-side at blend time).
const comps = (r: VMaster) => [
  ["LLM priority", Math.round(r.priority_score ?? 0), 0.45],
  ["Engagement rate", Math.min(100, Math.round(((r.rate_score ?? 0) / 40) * 100)), 0.25],
  ["Severity signals", Math.min(100, Math.round(((r.f_severity ?? 0) / 5) * 100)), 0.2],
  ["Cluster mass", Math.min(100, Math.round((Math.log2(Math.max(1, r.cluster_size ?? 1)) / Math.log2(140)) * 100)), 0.1],
] as const;

// Basis-keyed copy, not a per-issue string: the schema has no verify_reason column yet, so
// anything issue-specific here would be invented.
const VERIFY_COPY: Record<string, { pill: string; cls: string; text: string }> = {
  corroborated: {
    pill: "✓ corroborated",
    cls: "corr",
    text: "Confirmed and corroborated by breadth — a duplicate cluster and/or top age-band engagement back the rating.",
  },
  "class-solo": {
    pill: "◇ lead · solo",
    cls: "lead",
    text:
      "Confirmed on a single credible report of a data-loss / security / consent / billing defect with a " +
      "concrete mechanism. This lane is deliberately permissive — a wrong confirm costs a glance; a missed " +
      "silent-data-loss bug costs weeks — and its precision is policed by the weekly QA sample.",
  },
};

function Verification({ row }: { row: VMaster }) {
  const basis = row.verify_basis && VERIFY_COPY[row.verify_basis] ? VERIFY_COPY[row.verify_basis] : null;

  return (
    <div className="d-sec">
      <div className="d-label">Verification</div>
      {row.verified_high && basis ? (
        <div className={`verify-box ${row.verify_basis}`}>
          <span className={`pill ${basis.cls}`}>{basis.pill}</span>
          <div className="verify-reason">{basis.text}</div>
        </div>
      ) : row.verified_high ? (
        <div className="verify-reason" style={{ marginTop: 0 }}>
          Rating held up under a second, challenging pass. This row predates the basis being recorded, so
          which lane confirmed it isn’t stored.
        </div>
      ) : (
        <div className="verify-reason" style={{ marginTop: 0 }}>
          Single-pass rating — re-verifies automatically if its cluster grows or engagement crosses the
          next age-band decile.
        </div>
      )}
    </div>
  );
}

const TRIAGE_LABEL: Record<string, string> = {
  untriaged: "Untriaged", acknowledged: "Acknowledged", investigating: "Investigating",
  escalated: "Escalated", resolved: "Resolved", wontfix: "Won’t fix",
  "resolved-upstream-confirm": "Resolved upstream — confirm",
};

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

  const score = Math.round((row?.final_rank_score ?? row?.retrieval_score ?? 0));
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
                <div className="d-label">
                  Summary <span style={{ fontWeight: 500, letterSpacing: 0, textTransform: "none" }}>· {row.model ?? "Sonnet"}, {row.batch_id ? "batch #" + row.batch_id : "seed review"}</span>
                </div>
                <div className="d-summary">{row.summary}</div>
              </div>
            )}

            {row.rationale && (
              <div className="d-sec">
                <div className="d-label">Why it ranks here</div>
                <div className="d-rat">{row.rationale}</div>
                <div className="conf-row">
                  <span>Classifier confidence</span>
                  <div className="meter" style={{ maxWidth: 150 }}><i style={{ width: `${Math.round((row.confidence ?? 0) * 100)}%` }} /></div>
                  <b style={{ color: "var(--text-2)" }}>{Math.round((row.confidence ?? 0) * 100)}%</b>
                </div>
              </div>
            )}

            <Verification row={row} />


            <div className="d-sec">
              <div className="d-label">Score decomposition · rank {score}</div>
              {comps(row).map(([name, v, w]) => (
                <div className="comp-row" key={name}>
                  <span className="comp-name">{name} <span style={{ color: "var(--micro)" }}>× {w}</span></span>
                  <div className="comp-track"><i style={{ width: `${v}%` }} /></div>
                  <span className="comp-val">{v}</span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: "var(--micro)", marginTop: 6 }}>Deterministic components recomputed nightly · weights in pipeline config</div>
            </div>

            <div className="d-sec">
              <div className="d-label">Signals</div>
              <div className="sig-grid">
                <div className="sig"><b>{fmtK(row.reactions_total)}</b><span>reactions</span></div>
                <div className="sig"><b>{fmtK(row.comments)}</b><span>comments</span></div>
                <div className="sig"><b>{(row.f_velocity ?? 0).toFixed(1)}</b><span>velocity term</span></div>
                <div className="sig"><b>{fmtAge(row.age_days)}</b><span>age</span></div>
                <div className="sig"><b>{(row.cluster_size ?? 1) > 1 ? "×" + row.cluster_size : "1"}</b><span>cluster size</span></div>
                <div className="sig"><b>{closed ? "closed" : "active"}</b><span>{closed ? row.state_reason ?? "closed" : "status"}</span></div>
              </div>
            </div>

            {members.length > 0 && (
              <div className="d-sec">
                <div className="d-label">Cluster members</div>
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

            <div className="d-sec">
              <div className="d-label">Triage</div>
              <div className="tri-panel">
                <div className="kv"><span>Status</span><b>{TRIAGE_LABEL[row.triage_status ?? "untriaged"] ?? "Untriaged"}</b></div>
                <div className="kv"><span>Assignee</span><b>{row.assignee || "unassigned"}</b></div>
                {row.triage_notes ? <div className="kv"><span>Notes</span><b style={{ fontWeight: 400, textAlign: "right" }}>{row.triage_notes}</b></div> : null}
                {row.triaged_by ? <div className="kv"><span>Updated by</span><b>{row.triaged_by}</b></div> : null}
              </div>
            </div>

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
