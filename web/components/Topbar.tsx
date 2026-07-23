"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { timeET } from "@/lib/format";

export function Topbar({ title }: { title: string }) {
  const [pill, setPill] = useState<string>("Loading sync status…");

  useEffect(() => {
    supabase
      .from("batches")
      .select("id, started_at, status")
      .in("kind", ["interval", "recluster"])
      .order("started_at", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        const b = data?.[0];
        if (b) setPill(`Synced ${timeET(b.started_at)} · batch #${b.id}`);
        else setPill("No syncs yet");
      });
  }, []);

  return (
    <div className="topbar">
      <span className="topbar-title">{title}</span>
      <div className="topbar-right">
        <div className="sync-pill">
          <span className="sync-dot" />
          {pill}
        </div>
      </div>
    </div>
  );
}
