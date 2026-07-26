"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useDataVersion } from "@/lib/refresh";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES } from "@/lib/types";
import { PriorityPill } from "../ui";
import type { ShellCtx } from "../AppShell";

export function Themes({ ctx }: { ctx: ShellCtx }) {
  const [data, setData] = useState<{ key: string; count: number; top: VMaster[] }[]>([]);
  const version = useDataVersion();

  useEffect(() => {
    (async () => {
      // Two requests, not two per theme. The counts and the top-3-per-theme both come from
      // read-model views (schema v1.4) instead of 7 count queries + 7 top-N queries.
      const [countRes, topRes] = await Promise.all([
        supabase.from("v_theme_counts").select("*"),
        supabase.from("v_theme_top").select("*"),
      ]);
      const counts = new Map((countRes.data ?? []).map((r: any) => [r.theme, r.n as number]));
      const tops = new Map<string, VMaster[]>();
      for (const r of ((topRes.data as VMaster[]) ?? [])) {
        if (!r.theme) continue;
        (tops.get(r.theme) ?? tops.set(r.theme, []).get(r.theme)!).push(r);
      }
      setData(Object.keys(THEME_NAMES)
        .map((k) => ({ key: k, count: counts.get(k) ?? 0, top: tops.get(k) ?? [] }))
        .sort((a, b) => b.count - a.count));
    })();
  }, [version]);

  const max = Math.max(1, ...data.map((d) => d.count));

  return (
    <section className="view">
      <div className="view-head">
        <h1 className="display">Themes</h1>
        <div className="view-sub">The seven cross-cutting themes from the July review, tracked live over the classified active set.</div>
      </div>
      <div className="theme-grid">
        {data.map((t) => (
          <div className="card card-pad theme-card" key={t.key}>
            <h3>{THEME_NAMES[t.key]}</h3>
            <div className="tc-meta"><b style={{ color: "var(--text)" }}>{t.count} open</b><span>classified active set</span></div>
            <div className="meter" style={{ background: "var(--card-2)" }}><i style={{ width: `${(t.count / max) * 100}%` }} /></div>
            <div className="tc-issues">
              {t.top.length === 0 && <div style={{ color: "var(--text-3)", fontSize: 12.5 }}>No classified issues yet.</div>}
              {t.top.map((i) => (
                <div className="tc-row" key={i.number} onClick={() => ctx.openDrawer(i)}>
                  <span className="t-num">#{i.number}</span>
                  <span className="tc-t">{i.title}</span>
                  <PriorityPill priority={i.priority} />
                </div>
              ))}
            </div>
            <button className="btn btn-sm tc-all" onClick={() => ctx.goMaster({ theme: t.key })}>
              View all {t.count} →
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
