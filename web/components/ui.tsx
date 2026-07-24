import React from "react";
import { priorityMeta } from "@/lib/format";

// Priority only. The "✓ verified" marker that used to ride along here was removed —
// it read as a quality badge on the issue rather than what it is (an internal
// second-pass flag). The concept is explained once, in Batches & ops.
export function PriorityPill({ priority }: { priority: string | null }) {
  const m = priorityMeta(priority);
  return <span className={`pill ${m.cls}`}>{m.label}</span>;
}

export function Tag({ children, theme }: { children: React.ReactNode; theme?: boolean }) {
  return <span className={`tag${theme ? " theme-t" : ""}`}>{children}</span>;
}
