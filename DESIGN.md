---
name: VoWiFi gateway
description: Control plane for SIM-backed VoWiFi lines: status, recovery, config, softphone and SMS.
colors:
  signal-indigo: "#4f46e5"
  signal-indigo-deep: "#4338ca"
  signal-indigo-dark: "#6366f1"
  paper: "#fafafa"
  panel-white: "#ffffff"
  hairline: "#e4e4e7"
  hairline-strong: "#d4d4d8"
  hover-wash: "#f4f4f5"
  active-wash: "#ececef"
  ink: "#09090b"
  ink-soft: "#3f3f46"
  ink-dim: "#71717a"
  ink-mute: "#a1a1aa"
  ink-faint: "#c4c4cc"
  night: "#09090b"
  night-panel: "#111113"
  night-input: "#0c0c0e"
  night-hairline: "#202024"
  night-hairline-strong: "#2e2e34"
  night-hover: "#18181b"
  night-active: "#1f1f24"
  night-ink: "#fafafa"
  night-ink-soft: "#d4d4d8"
  night-ink-dim: "#a1a1aa"
  ok: "#15803d"
  ok-night: "#4ade80"
  ok-solid: "#16a34a"
  warn: "#a16207"
  warn-night: "#facc15"
  registering-amber: "#eab308"
  pipeline-amber: "#ca8a04"
  tunnel-orange: "#c2410c"
  tunnel-orange-night: "#fb923c"
  tunnel-orange-dot: "#f97316"
  danger: "#dc2626"
  danger-night: "#f87171"
  danger-dot: "#ef4444"
  stopped-slate: "#94a3b8"
typography:
  headline:
    fontFamily: "Adwaita Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    letterSpacing: "-0.4px"
  title:
    fontFamily: "Adwaita Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "-0.2px"
  body:
    fontFamily: "Adwaita Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    letterSpacing: "-0.005em"
    fontFeature: "\"ss01\", \"cv11\""
  body-small:
    fontFamily: "Adwaita Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Adwaita Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
  caption:
    fontFamily: "Adwaita Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
  mono:
    fontFamily: "Adwaita Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "12px"
    lineHeight: 1.5
    fontFeature: "\"tnum\""
rounded:
  sm: "8px"
  input: "9px"
  md: "10px"
  key: "12px"
  pill: "999px"
spacing:
  xxs: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.signal-indigo}"
    textColor: "{colors.panel-white}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.signal-indigo-deep}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  button-ghost-hover:
    backgroundColor: "{colors.hover-wash}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.panel-white}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  card:
    backgroundColor: "{colors.panel-white}"
    rounded: "{rounded.md}"
    padding: "20px"
  input:
    backgroundColor: "{colors.panel-white}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.input}"
    padding: "8px 10px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dim}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
  nav-item-active:
    backgroundColor: "{colors.active-wash}"
    textColor: "{colors.ink}"
  pill:
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  segmented:
    backgroundColor: "{colors.hover-wash}"
    rounded: "{rounded.sm}"
    padding: "3px"
---

# Design System: VoWiFi gateway

## Overview

**Creative North Star: "The Switchboard"**

The UI is an operator's panel of telephone lines. Each SIM is a line on the board, and the board's job is to say at a glance which lines are live, which are coming up, and which are down and where. The chrome stays quiet: zinc neutrals, hairline borders, one indigo accent, compact type. That way the status lamps (green, amber, orange, red, slate) are what the eye finds first.

It is dense the way a desk instrument is: 12–14px text, tight 6–12px gaps, real values printed in full (IMSI, SMSC, P-CSCF, codecs) rather than summarised. Light and dark are equal citizens; dark is a true near-black board (#09090b), not a grey inversion, and it drops card shadows entirely. On a phone the board turns into a bottom tab bar and single-pane views so the softphone and messages work one-handed.

The stylesheet's own label for this direction is "clean devtool"; the Switchboard is what that devtool is for.

**Key Characteristics:**
- Zinc neutral scale, one indigo accent, semantic state colours with fixed meanings
- Hairline 1px borders define surfaces; shadows are near-absent at rest
- Small, precise type in Adwaita Sans; Adwaita Mono with tabular figures for identifiers and live numbers
- Gently rounded (8–10px) rectangles, full pills for status
- Every theme token has a light and a dark value; both must be checked

## Colors

A cool zinc greyscale with an indigo accent, plus a fixed set of line-state lamps.

### Primary
- **Signal Indigo** (`signal-indigo`; `signal-indigo-dark` in dark theme): the accent. Primary buttons, focus rings (40–50% mix), input focus border, the selected reader card's outline, active nav icon, the "Vo" in the wordmark. It may also carry links, highlights and other emphasis.
- **Signal Indigo Deep** (`signal-indigo-deep`): primary button hover.

### Neutral
- **Paper / Night** (`paper` / `night`): app and sidebar background.
- **Panel White / Night Panel** (`panel-white` / `night-panel`): cards, sections, modals.
- **Hairline / Hairline Strong** (`hairline`, `hairline-strong` and their `night-` pairs): card borders and dividers; the strong step for inputs, ghost buttons and scrollbar thumbs.
- **Hover Wash / Active Wash** (`hover-wash`, `active-wash` and `night-` pairs): hover and selected backgrounds for nav, segmented controls, dial keys.
- **Ink ramp** (`ink`, `ink-soft`, `ink-dim`, `ink-mute`, `ink-faint`): primary text, secondary text, labels, hints, faint meta. Dark theme inverts the ramp (`night-ink` …).

### Line-state lamps
Each state of the line state machine has one colour, used for its dot, pill and pipeline step:
- **OK**: `ok-solid` dot with a 20% halo; `ok` / `ok-night` for pill text and tint.
- **REGISTERING**: `registering-amber` dot with a soft glow; `warn` / `warn-night` pill. The pipeline's current-step bar uses `pipeline-amber`.
- **TUNNEL_DOWN, EPDG_UNRESOLVED**: `tunnel-orange-dot`; `tunnel-orange` / `tunnel-orange-night` pill.
- **PIN_PROBLEM, NO_CARD, ERROR**: `danger-dot`; `danger` / `danger-night` pill and danger buttons.
- **STOPPED**: `stopped-slate` dot, neutral pill.

### Named Rules
**The Lamp Rule.** Green, amber, orange and red belong to line health. A pill, banner or dot in one of those colours always means a state, and a state always uses the same colour wherever it appears (dashboard pill, pipeline, softphone registration).

**The Tint, Not Fill Rule.** Status surfaces are tints mixed from the lamp token: pills at 12% background / 28% border, banners at 9% over the panel / 35% border. Solid fills are reserved for dots, pipeline bars and destructive buttons.

## Typography

**Body Font:** Adwaita Sans (fallback `ui-sans-serif, system-ui, sans-serif`)
**Mono Font:** Adwaita Mono (fallback `ui-monospace, SF Mono, Menlo, monospace`)

**Character:** A neutral GNOME-family sans with stylistic set `ss01` and `cv11` on, slightly tightened (-0.005em). Display and body share one family; hierarchy comes from size and weight, not a second face.

### Hierarchy
- **Headline** (600, 22px, -0.4px): page titles in the app header; 19px under 860px.
- **Title** (600, 15px, -0.2px): config section titles, card headers. The wordmark is 18px/700.
- **Body** (400–500, 14px): buttons (500), nav (500), inputs, main text.
- **Body small** (13px, 1.45): banners, notes, checkbox rows (13.5px), detail rows.
- **Label** (500, 12px): field labels, pills, hints (12px/1.5 in `ink-mute`), section descriptions (12.5px).
- **Caption** (11px): reader meta, theme picker, instance count; pipeline step labels drop to 10px.
- **Mono** (12px, 1.5, tabular figures): log bodies, identifiers, codes in hints.

### Named Rules
**The Steady Digits Rule.** Anything that updates in place (timers, counters, signal values, `<time>`) uses tabular figures so it never jitters.

## Layout

A fixed 224px sidebar plus a scrolling content area. Content is not centred in a max-width column by default; the SIM Config page caps at 1120px and lays out a 260–320px sticky card beside a fluid form.

- **Rhythm:** 4/6/8/10/12/16/20/24px. Gaps are mostly 6–12px; cards pad 20px (18px for config sections, 14px when narrow).
- **Phone (≤860px):** the sidebar becomes a bottom tab bar (respecting `safe-area-inset-bottom`); brand, theme picker, logout and instance count hide; split panes (Messages, Softphone) show one pane at a time with a back control; toasts move above the tab bar.
- **≤600px:** nav labels drop, icons only.
- **Container queries** drive the SIM Config form (820 / 700 / 560px), because usable width depends on the sidebar, not the viewport.
- Touch and narrow viewports hide scrollbars; fine pointers get a 10px custom thumb.

## Elevation & Depth

Flat, with tonal layering. Surfaces separate by background step (paper → panel) and a hairline border. Light-theme cards carry a barely visible 1px shadow; dark-theme cards carry none. Real shadows appear only on things floating above the board.

### Shadow Vocabulary
- **Card rest** (`0 1px 2px rgba(9,9,11,0.04)`, none in dark): cards.
- **Primary button** (`inset 0 1px 0 rgba(255,255,255,0.15), 0 1px 2px rgba(9,9,11,0.12)`): a slight bevel on the one filled button.
- **Segment lift** (`0 1px 2px var(--shadow)`): the active segment in segmented controls.
- **Sticky bar** (`0 -8px 24px -12px var(--shadow)`): SIM Config's sticky save bar.
- **Toast** (`0 8px 30px var(--shadow)`) and **Modal** (`0 24px 60px -12px var(--shadow)` over a 45–65% overlay with 2px backdrop blur).

### Named Rules
**The Float-Only Rule.** Shadows mark things above the board: toasts, modals, sticky bars. Resting cards are drawn by their border.

## Shapes

Gently rounded rectangles throughout: 10px for cards, 8px for buttons, nav, banners, segmented controls, 9px for inputs, 12px for dial keys. Status uses full pills and round dots (10px dots, 6px inside pills). Pipeline bars are 5px tall with 3px corners. Borders are always 1px; selection uses a 2px outline offset by 2px rather than a thicker border.

## Components

### Buttons
Compact, precise, one filled voice per group.
- **Shape:** 8px radius, 8px × 14px padding, 14px / 500, 6px icon gap.
- **Primary:** Signal Indigo fill, white text, subtle bevel shadow; hover to Signal Indigo Deep.
- **Ghost (default secondary):** transparent with a `hairline-strong` border and `ink-soft` text; hover fills with the hover wash. Most line actions (Stop, Re-register, SIP info) are ghost buttons.
- **Danger:** solid danger red, white text; hover mixes 15% black.
- **Disabled:** 50% opacity, not-allowed cursor. Transitions are 0.15s.
- **Focus:** global `:focus-visible` 2px outline in the indigo focus mix, 2px offset.

### Status pill (signature)
- **Style:** full pill, 12px / 500, 2px × 9px, lamp-coloured text on a 12% tint with a 28% border, a 6px dot leading.
- **Use:** the line state on each reader card, and anywhere a state is named.

### Pipeline (signature)
Five equal bars (SIM → ePDG DNS → Tunnel → IMS reg → Working), 6px apart, with 10px `ink-mute` labels. Completed steps are `ok-solid`, the current failing step is `pipeline-amber`, untouched steps are `hairline-strong`. It shows where a line stopped, not only that it stopped.

### Cards / Containers
- **Corner Style:** 10px.
- **Background:** panel on paper.
- **Shadow Strategy:** card rest (see Elevation).
- **Border:** 1px hairline. A selected reader card gets a 2px Signal Indigo outline at 2px offset.
- **Internal Padding:** 20px (dashboard), 18px (config sections), 24px (login, modals).

### Banners
8px radius, 10px × 12px, 13px / 1.45 text in `ink-soft`, tinted from `--tone` (warn by default, danger variant).

### Inputs / Fields
- **Style:** `input-bg` fill, 1px `hairline-strong` border, 9px radius, 8px × 10px, 14px text, full width.
- **Focus:** border turns Signal Indigo plus a 3px focus-mix ring.
- **Labels:** 12px / 500 `ink-dim`, 4px above the field. Hints sit 6px below in 12px `ink-mute`.

### Segmented control
A 3px-padded wash track with an 8px radius; segments are borderless buttons, the active one lifts onto the panel colour with the segment shadow. The theme picker (Auto / Light / Dark) is the same pattern at 11px.

### Navigation
- **Desktop:** vertical list in the sidebar, 14px / 500 `ink-dim`, 8px × 10px, 8px radius; hover wash; active uses the active wash, `ink` text and an indigo icon.
- **Phone:** the same buttons in a bottom bar, then icon-only below 600px.

### Softphone dial pad
A 3-column grid of square keys (aspect 1:1), max 280px wide with 10px gaps; DTMF keys are 48–56px tall, 12px radius, hover-wash fill with a hairline border.

### Toast
Inverted (dark on light theme, light on dark), 8px radius, 14px / 600, bottom-right; full-width above the tab bar on phones.

## Do's and Don'ts

### Do:
- **Do** define every new colour as a CSS custom property with light, dark and auto-dark values in `index.css`, and check both themes.
- **Do** colour line health with the lamp tokens through `.pill-*`, `.banner-*` and `.st-*` classes, so a state looks the same everywhere.
- **Do** use ghost buttons for routine line actions and keep one primary button per group.
- **Do** print real identifiers in full, in Adwaita Mono with tabular figures where they update.
- **Do** use container queries for layouts inside the content area, because the sidebar takes width.

### Don't:
- **Don't** use green, amber, orange or red for anything that isn't a line or result state (The Lamp Rule).
- **Don't** put shadows on resting cards beyond the card-rest token; shadows are for toasts, modals and sticky bars.
- **Don't** hard-code hex values in component inline styles when a token exists; `#ca8a04` in the pipeline and the `.st-*` dots are the known exceptions.
- **Don't** add a second typeface; hierarchy comes from size and weight in Adwaita Sans.
