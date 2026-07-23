# Issue Tracker — Frontend Design Spec (v1.1)

Companion to `claude/frontend-mockup.html` (the interactive reference — open it in a browser; it is the source of truth for look & feel). This doc extracts the tokens and rules so a Claude Code build session can implement the Next.js app without parsing the mockup.

**Design language:** claude.ai — warm ivory surfaces, terracotta accent, serif display type over a quiet sans UI, soft 10–14px radii, hairline borders, minimal shadows. The app should feel like a native Claude-family product ("what an Anthropic employee would see").

## Tokens

| Role | Light | Dark |
|---|---|---|
| App background | `#FAF9F5` | `#262624` |
| Sidebar background | `#F0EEE6` | `#1F1E1C` |
| Card / chart surface | `#FFFFFF` | `#30302E` |
| Inset panel | `#F7F6F0` | `#383733` |
| Border / hairline | `#E6E2D7` / `#ECE9DF` | `#413F3B` / `#3A3936` |
| Text primary / secondary / muted | `#201F1E` / `#5E5A51` / `#75705F` | `#F0EEE6` / `#B8B3A9` / `#9A958B` |
| Accent (Claude terracotta) | `#C15F3C` (strong `#A84E2F` for buttons, 5.5:1 w/ white) | `#D97757` (strong `#C96442`) |
| Accent soft (fills, active chips) | `#F7EAE2` | `rgba(217,119,87,.13)` |
| Success | `#2E7D43` / bg `#E6F0E7` | `#58B26B` |

Priority pills are tinted-background + dark-text (never solid fills), all ≥5.4:1: High `#F6E3DF`/`#9C2F23`, Medium `#F5EBD7`/`#7A4F0E`, Low `#EDEAE0`/`#5F5B4E`; dark equivalents in the mockup CSS. Verified badge: accent-soft + accent-strong text, always with the word "verified" (color never carries meaning alone).

## Typography

- Display/serif (view titles, greeting, drawer titles, theme names): `"Copernicus","Tiempos Text",Georgia,serif` — 26–27px view titles, 19px drawer titles, weight 500–600, letter-spacing −0.01em.
- UI sans (everything else): `"Styrene B",-apple-system,"Segoe UI",Roboto,sans-serif` — base 14px, table cells 13px, micro-labels 10.5–11px uppercase +0.07–0.09em tracking.
- Stat-tile values and hero numbers: **sans semibold, proportional figures** (never serif, never tabular-nums at display size). `tabular-nums` only in table columns and axis ticks.
- Mono (issue numbers, cursors, config): `ui-monospace,"SF Mono",Menlo,monospace`.

## Chart palette (validated with the dataviz six-checks, both modes)

| Slot | Light (on #FFFFFF) | Dark (on #30302E) |
|---|---|---|
| 1 — terracotta | `#C15F3C` | `#D26E4B` |
| 2 — blue | `#3B72C0` | `#5B93DD` |
| 3 — green | `#238B57` | `#34A16B` |

All checks PASS in both modes (lightness band, chroma ≥0.10, CVD ΔE 18.3/16.9 worst adjacent, normal-vision 20.0/19.4, contrast ≥3:1). Chart marks for priority use `--hi-mark #BB4737`, `--med-mark #C98A2E`, `--low-mark #A8A29A` with counts always printed in the legend (relief rule for the sub-3:1 amber/gray). Rules honored and to preserve: 2px lines, ≤22px bars with 4px rounded data-ends, 2px surface gaps between stacked segments, 2px surface rings on dots, hairline solid gridlines, legend for ≥2 series + selective end-labels only, single hue for nominal theme bars, crosshair+tooltip on lines / per-mark tooltips on bars, a table-view toggle on every chart card, dark mode = its own validated steps (not a filter).

## Layout & components

264px fixed sidebar (logo row with 8-ray starburst mark + "Claude Code" serif wordmark + INTERNAL chip → terracotta "Run sync now" CTA → nav with 16px line icons + count badge → saved views → theme toggle + user chip). Content max-width 1230px, 30/36px padding. Top bar: view title, sync pill (pulsing green dot + "Synced 2:17 PM · batch #418"), "Unlock editing" ghost button. Cards: 14px radius, hairline border, barely-there shadow. Right drawer 620px for issue detail (summary → rationale + confidence meter → score decomposition bars → signals grid → cluster chips → triage panel → meta). Toasts bottom-center, dark inverse.

## Views (all in mockup)

1. **Dashboard** — serif greeting w/ starburst, 4 KPI tiles (sparkline on intake), intake-vs-closes 2-series line, priority-mix stacked bar, latest batches, theme bars, claude.ai-style "Ask about this backlog" input (v2 hook).
2. **New & Notable** — batch-grouped verified-High cards, acknowledge flow, unack-only toggle.
3. **Master list** — filter row (search, Type, Theme, Priority, Triage, **State: Active/Closed/All**, cluster toggle), sortable columns, score bar cells, compact "High ✓" pills, dimmed closed rows with close-reason tags ("fixed in 2.1.218" / "dup of #80104"), row → drawer.
4. **Themes** — 7 serif-titled cards, count + Δ7d + mean impact + top-3 issues.
5. **Batches & ops** — QA meters (area agreement, priority within-one, High-share band, queue), sync history table with GHA log links, pipeline config card.

## Implementation notes for the build session

Port tokens as CSS custom properties (same names as mockup) with `[data-theme]` switching; Tailwind maps them via `var()`. Table = TanStack Table with server-side filters against `v_master`; charts = hand-rolled SVG or Recharts constrained to the specs above; drawer = the detail route (`/issue/[n]`) rendered as a parallel-route modal. Closed issues: `state` filter param, `state_reason` chip mapping, triage chip swaps to "Closed Xd ago". Keep the ask-bar as a disabled v2 affordance.
