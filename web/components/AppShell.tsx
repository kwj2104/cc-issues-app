"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
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
export type MasterPreset = { priority?: string; theme?: string } | null;

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
  const [view, setView] = useState<ViewKey>("dash");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [drawerRow, setDrawerRow] = useState<VMaster | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [newHigh, setNewHigh] = useState<number>(0);
  const [preset, setPreset] = useState<MasterPreset>(null);

  useEffect(() => {
    const t = (localStorage.getItem("cc-theme") as "light" | "dark") || "light";
    setTheme(t);
  }, []);

  useEffect(() => {
    supabase
      .from("v_new_high")
      .select("number", { count: "exact", head: true })
      .then(({ count }) => setNewHigh(count ?? 0));
  }, []);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout((toast as any)._h);
    (toast as any)._h = window.setTimeout(() => setToastMsg(null), 2600);
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
    document.querySelector("main")?.scrollTo(0, 0);
  }, []);

  const nav = (v: ViewKey) => {
    setView(v);
    if (v !== "master") setPreset(null);
    document.querySelector("main")?.scrollTo(0, 0);
  };

  const ctx: ShellCtx = { openDrawer, toast, goMaster };

  return (
    <>
      <Sidebar
        active={view}
        newHigh={newHigh}
        theme={theme}
        onNav={nav}
        onTheme={applyTheme}
        onSavedView={(p) => goMaster(p)}
      />
      <div className="app">
        <Topbar title={TITLES[view]} />
        <main>
          <div className="content">
            {view === "dash" && <Dashboard ctx={ctx} />}
            {view === "notable" && <Notable ctx={ctx} onCount={setNewHigh} />}
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
