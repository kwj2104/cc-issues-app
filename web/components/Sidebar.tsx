"use client";

import type { ViewKey } from "./AppShell";
import {
  IconDash, IconNotable, IconMaster, IconThemes, IconOps, IconSun, IconMoon,
} from "./Icons";

const NAV: { key: ViewKey; label: string; Icon: (p: any) => JSX.Element }[] = [
  { key: "dash", label: "Dashboard", Icon: IconDash },
  { key: "master", label: "Master list", Icon: IconMaster },
  { key: "notable", label: "New & Notable", Icon: IconNotable },
  { key: "themes", label: "Themes", Icon: IconThemes },
  { key: "ops", label: "Batches & ops", Icon: IconOps },
];

export function Sidebar({
  active, theme, open, onNav, onTheme,
}: {
  active: ViewKey;
  theme: "light" | "dark";
  open: boolean;
  onNav: (v: ViewKey) => void;
  onTheme: (t: "light" | "dark") => void;
}) {
  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="logo-row">
        <img className="logo-mark" src="/clawdpixel.svg" alt="" />
        <span className="logo-name">Claude Code</span>
        <span className="logo-sub">INTERNAL</span>
      </div>
      <div className="nav-label" style={{ paddingTop: 4 }}>ISSUE TRACKER</div>
      {NAV.map(({ key, label, Icon }) => (
        <button key={key} className={`nav-item${active === key ? " active" : ""}`} onClick={() => onNav(key)}>
          <Icon />
          {label}
        </button>
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
            <div className="user-plan">Product Ops</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
