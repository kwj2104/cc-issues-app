"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { RefreshProvider, useDataVersion } from "@/lib/refresh";
import type { VMaster } from "@/lib/types";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { Drawer } from "./Drawer";
import { Dashboard } from "./views/Dashboard";
import { MasterList } from "./views/MasterList";
import { Notable } from "./views/Notable";
import { Themes } from "./views/Themes";
import { Ops } from "./views/Ops";

export type ViewKey = "dash" | "notable" | "master" | "themes" | "ops";
export type MasterPreset = { priority?: string; theme?: string; quiet?: boolean } | null;

const TITLES: Record<ViewKey, string> = {
  dash: "Dashboard",
  notable: "New & Notable",
  master: "Master list",
  themes: "Themes",
  ops: "Batches & ops",
};

export interface ShellCtx {
  openDrawer: (row: VMaster) => void;
  toast: (msg: string) => void;
  goMaster: (preset: MasterPreset) => void;
}

export function AppShell() {
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout((toast as any)._h);
    (toast as any)._h = window.setTimeout(() => setToastMsg(null), 4000);
  }, []);

  const onBatch = useCallback(
    (b: { id: number; status: string }) =>
      toast(b.status === "running" ? `Sync batch #${b.id} running…` : `Batch #${b.id} synced — data refreshed`),
    [toast]
  );

  return (
    <RefreshProvider onBatch={onBatch}>
      <Shell toast={toast} toastMsg={toastMsg} />
    </RefreshProvider>
  );
}

function Shell({ toast, toastMsg }: { toast: (m: string) => void; toastMsg: string | null }) {
  const [view, setView] = useState<ViewKey>("dash");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [drawerRow, setDrawerRow] = useState<VMaster | null>(null);
  const [preset, setPreset] = useState<MasterPreset>(null);
  const [navOpen, setNavOpen] = useState(false);
  const version = useDataVersion();

  useEffect(() => {
    const t = (localStorage.getItem("cc-theme") as "light" | "dark") || "light";
    setTheme(t);
  }, []);

  const applyTheme = (t: "light" | "dark") => {
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("cc-theme", t);
  };

  const openDrawer = useCallback((row: VMaster) => setDrawerRow(row), []);
  const goMaster = useCallback((p: MasterPreset) => {
    setPreset(p);
    setView("master");
    setNavOpen(false);
    document.querySelector("main")?.scrollTo(0, 0);
  }, []);

  const nav = (v: ViewKey) => {
    setView(v);
    if (v !== "master") setPreset(null);
    setNavOpen(false);
    document.querySelector("main")?.scrollTo(0, 0);
  };

  const ctx: ShellCtx = { openDrawer, toast, goMaster };

  return (
    <>
      <Sidebar
        active={view}
        theme={theme}
        open={navOpen}
        onNav={nav}
        onTheme={applyTheme}
      />
      <div className={`nav-backdrop${navOpen ? " on" : ""}`} onClick={() => setNavOpen(false)} />
      <div className="app">
        <Topbar title={TITLES[view]} onMenu={() => setNavOpen((o) => !o)} />
        <main>
          <div className="content">
            {view === "dash" && <Dashboard ctx={ctx} />}
            {view === "notable" && <Notable ctx={ctx} />}
            {view === "master" && <MasterList ctx={ctx} preset={preset} />}
            {view === "themes" && <Themes ctx={ctx} />}
            {view === "ops" && <Ops />}
          </div>
        </main>
      </div>

      <div className={`backdrop${drawerRow ? " on" : ""}`} onClick={() => setDrawerRow(null)} />
      <Drawer row={drawerRow} onClose={() => setDrawerRow(null)} />

      <div className={`toast${toastMsg ? " on" : ""}`}>{toastMsg}</div>
    </>
  );
}
