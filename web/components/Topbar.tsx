"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRefresh } from "@/lib/refresh";
import { batchKind, timeET } from "@/lib/format";
import { IconMenu } from "./Icons";

export function Topbar({ title, onMenu }: { title: string; onMenu: () => void }) {
  const [pill, setPill] = useState<string>("Loading sync status…");
  const { version, syncing } = useRefresh();

  useEffect(() => {
    // No kind filter: every batch kind writes data the app renders, and this must agree with
    // the refresh provider (which watches the newest batch of any kind) or the toast announces
    // a batch the topbar never shows.
    supabase
      .from("batches")
      .select("id, kind, started_at, status")
      .order("started_at", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        const b = data?.[0];
        if (b) setPill(`Updated ${timeET(b.started_at)} · batch #${b.id}`);
        else setPill("No batches yet");
      });
  }, [version]);

  return (
    <div className="topbar">
      <button className="menu-btn" onClick={onMenu} aria-label="Toggle navigation">
        <IconMenu />
      </button>
      <span className="topbar-title">{title}</span>
      <div className="topbar-right">
        <div className="sync-pill">
          <span className="sync-dot" style={syncing ? undefined : { animation: "none" }} />
          <span className="sync-pill-text">{syncing ? "Sync running…" : pill}</span>
        </div>
      </div>
    </div>
  );
}
