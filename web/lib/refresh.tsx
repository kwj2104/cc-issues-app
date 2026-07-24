"use client";

// Live-data refresh. The pipeline writes a `batches` row when a sync starts and updates it
// when the sync finishes, so the newest batch's (id, status) is a cheap, exact signal that
// the data underneath the app has changed. Everything that reads Supabase takes
// `useDataVersion()` as an effect dependency, so one bump refetches the whole app —
// no reload, no stale numbers sitting on an open tab.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";

const POLL_MS = 60_000;

export interface RefreshState {
  /** Bumps whenever a new batch starts or the running batch finishes. */
  version: number;
  latestBatchId: number | null;
  /** True while the pipeline has a batch in flight. */
  syncing: boolean;
}

const Ctx = createContext<RefreshState>({ version: 0, latestBatchId: null, syncing: false });

export const useRefresh = () => useContext(Ctx);
export const useDataVersion = () => useContext(Ctx).version;

export function RefreshProvider({
  children,
  onBatch,
}: {
  children: React.ReactNode;
  /** Called when a change is detected (not on first load). */
  onBatch?: (batch: { id: number; status: string }) => void;
}) {
  const [state, setState] = useState<RefreshState>({ version: 0, latestBatchId: null, syncing: false });
  const seen = useRef<string | null>(null);
  const cb = useRef(onBatch);
  cb.current = onBatch;

  const check = useCallback(async () => {
    const { data, error } = await supabase
      .from("batches")
      .select("id, status")
      .order("id", { ascending: false })
      .limit(1);
    const b = data?.[0];
    if (error || !b) return;

    const key = `${b.id}:${b.status}`;
    const first = seen.current === null;
    if (seen.current === key) return;
    seen.current = key;

    setState((s) => ({
      version: first ? s.version : s.version + 1,
      latestBatchId: b.id,
      syncing: b.status === "running",
    }));
    if (!first) cb.current?.(b);
  }, []);

  useEffect(() => {
    check();
    const timer = window.setInterval(check, POLL_MS);
    // Catch up immediately when the tab comes back rather than waiting out the interval.
    const onFocus = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}
