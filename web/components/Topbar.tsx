"use client";

import { IconMenu } from "./Icons";

// No sync pill here: the timestamp duplicates the dashboard's "Last update" tile, and the
// in-flight state is already announced by the refresh toast ("Sync batch #N running…" →
// "Batch #N synced"). The topbar is just the view title and the mobile nav toggle.
export function Topbar({ title, onMenu }: { title: string; onMenu: () => void }) {
  return (
    <div className="topbar">
      <button className="menu-btn" onClick={onMenu} aria-label="Toggle navigation">
        <IconMenu />
      </button>
      <span className="topbar-title">{title}</span>
    </div>
  );
}
