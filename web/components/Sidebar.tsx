"use client";

import type { ViewKey, MasterPreset } from "./AppShell";
import {
  Starburst, IconSync, IconDash, IconNotable, IconMaster, IconThemes, IconOps, IconSun, IconMoon,
} from "./Icons";

const NAV: { key: ViewKey; label: string; Icon: (p: any) => JSX.Element }[] = [
  { key: "dash", label: "Dashboard", Icon: IconDash },
  { key: "notable", label: "New & Notable", Icon: IconNotable },
  { key: "master", label: "Master list", Icon: IconMaster },
  { key: "themes", label: "Themes", Icon: IconThemes },
  { key: "ops", label: "Batches & ops", Icon: IconOps },
];

const SAVED: { label: string; dot: string; preset: MasterPreset }[] = [
  { label: "Verified High · open", dot: "var(--hi-mark)", preset: { priority: "H" } },
  { label: "Regressions this week", dot: "var(--med-mark)", preset: { theme: "change-velocity-rollout" } },
  { label: "Money correctness", dot: "var(--s2)", preset: { theme: "money-correctness" } },
];

export function Sidebar({
  active, newHigh, theme, onNav, onTheme, onSavedView, onRunSync,
}: {
  active: ViewKey;
  newHigh: number;
  theme: "light" | "dark";
  onNav: (v: ViewKey) => void;
  onTheme: (t: "light" | "dark") => void;
  onSavedView: (p: MasterPreset) => void;
  onRunSync: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="logo-row">
        <Starburst className="logo-mark" />
        <span className="logo-name">Claude Code</span>
        <span className="logo-sub">INTERNAL</span>
      </div>
      <button className="sync-cta" onClick={onRunSync}>
        <IconSync />
        Run sync now
      </button>
      <div className="nav-label">ISSUE TRACKER</div>
      {NAV.map(({ key, label, Icon }) => (
        <button key={key} className={`nav-item${active === key ? " active" : ""}`} onClick={() => onNav(key)}>
          <Icon />
          {label}
          {key === "notable" && newHigh > 0 ? <span className="nav-count">{newHigh}</span> : null}
        </button>
      ))}
      <div className="nav-label">SAVED VIEWS</div>
      {SAVED.map((s) => (
        <div key={s.label} className="saved-item" onClick={() => onSavedView(s.preset)}>
          <span className="saved-dot" style={{ background: s.dot }} />
          {s.label}
        </div>
      ))}
      <div className="sidebar-foot">
        <div className="theme-toggle">
          <button className={theme === "light" ? "on" : ""} onClick={() => onTheme("light")}>
            <IconSun /> Light
          </button>
          <button className={theme === "dark" ? "on" : ""} onClick={() => onTheme("dark")}>
            <IconMoon /> Dark
          </button>
        </div>
        <div className="user-chip">
          <div className="avatar">K</div>
          <div>
            <div className="user-name">Kevin</div>
            <div className="user-plan">Product Ops · Max</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
