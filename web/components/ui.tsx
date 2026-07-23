import React from "react";
import { priorityMeta } from "@/lib/format";

export function PriorityPill({ priority, verified, compact }: { priority: string | null; verified?: boolean; compact?: boolean }) {
  const m = priorityMeta(priority);
  if (compact) {
    return (
      <span className={`pill ${m.cls}`} title={verified ? "verified by adversarial second pass" : undefined}>
        {m.label}
        {verified ? " ✓" : ""}
      </span>
    );
  }
  return (
    <>
      <span className={`pill ${m.cls}`}>{m.label}</span>
      {verified ? <span className="pill vrf">✓ verified</span> : null}
    </>
  );
}

export function Tag({ children, theme }: { children: React.ReactNode; theme?: boolean }) {
  return <span className={`tag${theme ? " theme-t" : ""}`}>{children}</span>;
}
