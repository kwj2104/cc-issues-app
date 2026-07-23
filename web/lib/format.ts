// Formatting helpers ported from the mockup's JS.

export const fmtK = (n: number | null | undefined): string => {
  if (n == null) return "0";
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
};

export const fmtAge = (d: number | null | undefined): string => {
  if (d == null) return "—";
  if (d < 1) return Math.max(1, Math.round(d * 24)) + "h";
  if (d < 90) return Math.round(d) + "d";
  if (d < 365) return Math.round(d / 30) + "mo";
  return (d / 365).toFixed(1) + "y";
};

// Blended score → 0-100 for the score bar (final_rank_score is already ~0-100).
export const rankScore = (r: { final_rank_score: number | null; priority_score: number | null }): number => {
  const v = r.final_rank_score ?? r.priority_score ?? 0;
  return Math.round(v);
};

export const priorityMeta = (p: string | null): { cls: string; label: string } => {
  const m: Record<string, { cls: string; label: string }> = {
    H: { cls: "hi", label: "High" },
    M: { cls: "med", label: "Medium" },
    L: { cls: "low", label: "Low" },
  };
  return m[p ?? ""] ?? { cls: "low", label: "—" };
};

export const timeET = (iso: string | null): string => {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
};

export const relDays = (iso: string | null): string => {
  if (!iso) return "—";
  const days = (Date.now() - new Date(iso).getTime()) / 86400000;
  return fmtAge(days);
};
