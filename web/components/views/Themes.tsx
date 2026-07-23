"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { VMaster } from "@/lib/types";
import { THEME_NAMES } from "@/lib/types";
import { PriorityPill } from "../ui";
import type { ShellCtx } from "../AppShell";

export function Themes({ ctx }: { ctx: ShellCtx }) {
  const [data, setData] = useState<{ key: string; count: number; top: VMaster[] }[]>([]);

  useEffect(() => {
    (async () => {
      const out = await Promise.all(
        Object.keys(THEME_NAMES).map(async (k) => {
          const { count } = await supabase.from("v_master").select("number", { count: "exact", head: true }).eq("is_active", true).eq("theme", k);
          const { data: top } = await supabase.from("v_master").select("*").eq("is_active", true).eq("theme", k).order("retrieval_score", { ascending: false, nullsFirst: false }).limit(3);
          return { key: k, count: count ?? 0, top: (top as VMaster[]) ?? [] };
        })
      );
      setData(out.sort((a, b) => b.count - a.count));
    })();
  }, []);

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
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div className="meter" style={{ background: "var(--card-2)" }}><i style={{ width: `${(t.count / max) * 100}%` }} /></div>
            </div>
            <div className="tc-issues">
              {t.top.length === 0 && <div style={{ color: "var(--text-3)", fontSize: 12.5 }}>No classified issues yet.</div>}
              {t.top.map((i) => (
                <div className="tc-row" key={i.number} onClick={() => ctx.openDrawer(i)}>
                  <span className="t-num">#{i.number}</span>
                  <span className="tc-t">{i.title}</span>
                  <PriorityPill priority={i.priority} verified={i.verified_high} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
