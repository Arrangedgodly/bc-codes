---
name: bc-codes
description: A crisis-wall drop console — live Bandcamp code pools on one command wall, phosphor on absolute black.
colors:
  ink: "#0a0a0a"
  panel: "#100d0b"
  panel-inset: "#060505"
  orange: "#ff5c1a"
  orange-bright: "#ff7a3d"
  green: "#39d353"
  alarm: "#e8102a"
  alarm-bright: "#ff3b4a"
  text: "#c9c2ba"
  text-muted: "#8a857e"
  text-micro: "#847f77"
  hairline: "#5a2e14"
  hairline-dim: "rgba(90, 46, 20, 0.55)"
  hairline-green: "rgba(57, 211, 83, 0.4)"
  hairline-alarm: "rgba(232, 16, 42, 0.45)"
typography:
  display:
    fontFamily: "Anton, 'Arial Narrow', 'Helvetica Neue', sans-serif"
    fontSize: "clamp(2.5rem, 8vw, 4.5rem)"
    fontWeight: 400
    lineHeight: 0.94
    letterSpacing: "0.015em"
  headline:
    fontFamily: "Anton, 'Arial Narrow', 'Helvetica Neue', sans-serif"
    fontSize: "clamp(1.75rem, 7vw, 3.5rem)"
    fontWeight: 400
    lineHeight: 1.04
    letterSpacing: "0.015em"
  title:
    fontFamily: "'Martian Mono', 'Courier New', monospace"
    fontSize: "0.75rem"
    fontWeight: 560
    lineHeight: 1.4
    letterSpacing: "0.18em"
  body:
    fontFamily: "'Martian Mono', 'Courier New', monospace"
    fontSize: "0.875rem"
    fontWeight: 380
    lineHeight: 1.6
  label:
    fontFamily: "'Martian Mono', 'Courier New', monospace"
    fontSize: "0.625rem"
    fontWeight: 460
    lineHeight: 1.4
    letterSpacing: "0.18em"
  micro-label:
    fontFamily: "'Martian Mono', 'Courier New', monospace"
    fontSize: "0.625rem"
    fontWeight: 340
    lineHeight: 1.4
    letterSpacing: "0.32em"
  readout:
    fontFamily: "'DSEG7 Classic', 'Martian Mono', monospace"
    fontSize: "clamp(2rem, calc(92cqw / 0.936 / n), 10rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "0.12em"
rounded:
  none: "0px"
  machined: "2px"
spacing:
  gap-1: "0.25rem"
  gap-2: "0.5rem"
  gap-3: "0.75rem"
  gap-4: "1rem"
  gap-5: "1.5rem"
  gap-6: "2.5rem"
  gap-7: "4rem"
components:
  button-primary:
    backgroundColor: "{colors.orange}"
    textColor: "{colors.ink}"
    typography: "{typography.display}"
    padding: "0.55rem 1.6rem"
    height: "3.5rem"
  button-primary-hover:
    backgroundColor: "{colors.orange-bright}"
    textColor: "{colors.ink}"
  button-primary-disabled:
    backgroundColor: "{colors.panel-inset}"
    textColor: "{colors.text-muted}"
  button-primary-launch:
    backgroundColor: "{colors.orange}"
    textColor: "{colors.ink}"
    typography: "{typography.headline}"
    padding: "0.75rem 2rem"
  button-ghost:
    backgroundColor: "{colors.panel-inset}"
    textColor: "{colors.orange}"
    typography: "{typography.title}"
    padding: "0.35rem 0.9rem"
    height: "2.5rem"
  button-ghost-hover:
    textColor: "{colors.orange-bright}"
  status-chip:
    backgroundColor: "{colors.panel-inset}"
    textColor: "{colors.green}"
    padding: "0.28em 0.7em 0.24em"
  status-chip-drained:
    textColor: "{colors.alarm-bright}"
  panel:
    backgroundColor: "{colors.panel}"
    padding: "1rem"
  panel-inset-well:
    backgroundColor: "{colors.panel-inset}"
  field-input:
    backgroundColor: "{colors.panel-inset}"
    textColor: "{colors.text}"
    padding: "0.5rem 0.85rem"
    height: "3rem"
---

# Design System: bc-codes

## Overview

**Creative North Star: "The Crisis Wall"**

bc-codes is drawn as a command console in a state of calm emergency, not a storefront. One continuous console frame (hazard band, header rail, hairline borders) wraps every route; inside it, every project is a live drop-cell — a machined panel carrying artwork, a segmented availability meter, and a seven-segment count of what actually remains. The material is absolute black warmed by phosphor: flat surfaces, hairline boundaries, and glow. Nothing is skeuomorphic and nothing is decorative for decoration's sake; the scanlines, hazard chevrons, and corner brackets are the console's own hardware.

The palette is a semantic tri-color on three grounds of black: phosphor orange is the single structural/interactive voice, nominal green means available or claimed-yours, and alarm red is rationed to drained pools, dead codes, and errors. All text contrast ratios were computed for WCAG 2.1 against the exact token hexes (verified 2026-08-28, recorded in `src/app.css`): every reading surface clears AA, and the base alarm red is large-text-and-fills only.

Every number on screen is a real pool count. Meters render segments against a real fraction, seven-segment readouts render real values, and state is always duplicated in words — the colors and textures are the machine's expression, never the sole carrier of meaning.

**Key Characteristics:**

- Absolute black grounds (`#0a0a0a` ink → `#100d0b` panel → `#060505` recessed well) with a CRT scanline wash over the whole body
- Phosphor orange as the one interactive voice; green and alarm red are semantic states, never flavors
- Anton condensed caps for display, Martian Mono for everything human-readable, DSEG7 for numeric readouts
- Sharp machined geometry: square corners, 1px hairlines, corner brackets drawn with background strokes
- Flat + glow: no drop shadows, no gradient decoration; depth comes from ground-tone layering and phosphor bloom
- All animation gated behind `prefers-reduced-motion: no-preference` — the world is fully readable without motion
- **Favicon** (`src/lib/assets/favicon.svg`): the console's own readout in miniature — a seven-segment "b" (the product initial, DSEG7-style hexagonal segments) in phosphor orange on the recessed-well black with a hairline-dim edge, its two unlit segments held as the 10% ghost; under 4KB so it inlines as a `data:` URI (the documented CSP `img-src data:` allowance)

## Colors

A semantic tri-color rationed across three grounds of warm black — the console never adds a fourth voice.

### Primary
- **Phosphor Orange** (#ff5c1a): The brand and structure voice — links, rail nav, wordmark tag, meter low-state fill, the primary action slab, focus rings, carets, hazard stripes. Black text on it (buttons) is 6.41:1 AA.
- **Phosphor Orange, Bright** (#ff7a3d): The hover/active register of orange (7.64:1 on ink), and the caution tone for panel labels when a pool is truly running low.

### Secondary
- **Nominal Green** (#39d353): Availability. Available and claimed-yours chips, nominal meter fills, seven-segment readouts, the dispensing lamp, the claimed code slab. 10.01:1 on ink; black-on-green chips are AA.

### Tertiary
- **Alarm Red** (#e8102a): Drained pools, dead/reported codes, errors, the alarm hazard crawl. 4.28:1 — large text (≥24px, or ≥18.66px bold) and fills only; never small body text.
- **Alarm Red, Bright** (#ff3b4a): The small-text-safe alarm (5.63:1 on ink) — drained/reported chip text, alarm panel labels, dead-code readouts, error messages, report controls.

### Neutral
- **Absolute Black / Ink** (#0a0a0a): The void — body ground under a 2.6% orange scanline wash, and the text color on orange and green surfaces.
- **Console Panel** (#100d0b): Raised panel ground — every Panel, the drop-cells of the wall.
- **Recessed Well** (#060505): Inset ground for readouts, meter slots, chips, inputs, and secondary buttons — the console's deepest layer.
- **Warm Gray Text** (#c9c2ba): Primary reading color (11.23:1 on ink).
- **Warm Gray Text, Muted** (#8a857e): Secondary copy, labels, meta lines (5.41:1 AA).
- **Warm Gray Text, Micro** (#847f77): The decorative bilingual JP layer — dimmer than muted but still AA on every ground (4.98:1 on ink); always `aria-hidden`.
- **Hairline** (#5a2e14): The dim orange-brown boundary color — panel borders, meter slot edges, input borders. Decorative only (1.73:1); never the sole indicator of state.
- **Hairline, Dim** (rgba(90, 46, 20, 0.55)): Default 1px boundaries everywhere — panel edges, head/foot rules, the console frame's sides.
- **Hairline, Green** (rgba(57, 211, 83, 0.4)): Panel and well borders in the nominal register (claimed code, nominal tone).
- **Hairline, Alarm** (rgba(232, 16, 42, 0.45)): Panel, well, and meter-slot borders in the alarm register.

### Named Rules
**The Drained-Only Rule.** Alarm red appears only for drained pools, dead codes, and errors. Any alarm red at reading sizes uses the bright tint (#ff3b4a); the base red (#e8102a) is large text and fills only.

**The Never-Sole-Indicator Rule.** Color and hairlines never carry state alone. Tinted borders and marker squares are always backed by words — a StatusChip's text, a panel's tone-tinted label, or an adjacent count.

## Typography

**Display Font:** Anton (self-hosted woff2, latin subset, with 'Arial Narrow', 'Helvetica Neue', sans-serif fallbacks)
**Body Font:** Martian Mono (variable 100–800, with 'Courier New', monospace fallback)
**Readout Font:** DSEG7 Classic Bold (with Martian Mono fallback)

**Character:** One ultra-heavy condensed caps face shouts the titles; one engineered wide mono does everything else — labels, body, buttons, codes. The seven-segment face renders numbers as hardware. Weights on the variable mono are fine-grained (340 micro, 380 body, 460 links, 520 chips, 560 titles/confirm, 620 OTP entry, 640 code strings); Anton is always 400.

### The Ramp
Nine steps carry every size in the world — the `--step` tokens of `src/app.css`, and nothing between them: **micro** 0.625rem (10px) · **data** 0.75rem (12px) · **body** 0.875rem (14px) · **emphasis** 1rem (16px) · **section-display** 1.375rem (22px) · **headline** 1.75rem (28px) · **display** 2.5rem (40px) · **near-monumental** 3.5rem (56px) · **ceiling** 4.5rem (72px). Every Anton and Martian Mono size is a step or clamps step-to-step (the display role clamps display→ceiling, the headline role headline→near-monumental, the launch tier headline→near-monumental). The DSEG7 readout is the one face off the ramp, by the formula below — the archive clamp's fixed endpoints are steps, while the slab's own 2rem/10rem endpoints are the exception's literals, quoted inside it. (The ramp's machine-readable record lives in the sidecar's `extensions.typeScale`; the frontmatter carries roles only.)

### Hierarchy
- **Display** (400, clamp(2.5rem, 8vw, 4.5rem) — display→ceiling steps, 0.94 line-height, 0.015em tracking, caps): Page titles — "Drop board", "My codes", "Design reference". Anton carries its own weight; no eyebrow or kicker accompanies it.
- **Headline** (400, clamp(1.75rem, 7vw, 3.5rem) — headline→near-monumental steps — on project pages; the section-display step 1.375rem in board cells, 1.04 line-height): Drop titles and artist names in cells and headers; section headings at section-display.
- **Title** (560, data step 0.75rem, 0.18em tracking, uppercase, 1.4): The Panel label — the tracked-caps heading voice of every panel head.
- **Body** (380, body step 0.875rem, 1.6): All reading copy, capped at the 68ch measure.
- **Label** (460, micro step 0.625rem, 0.18em tracking, uppercase): The data voice — sublabels, meter legends, meta lines, nav links.
- **Micro-label** (340, micro step 0.625rem, 0.32em tracking): The decorative bilingual JP layer (aria-hidden), the widest tracking in the system.
- **Readout** (700, sized per slot — emphasis 1rem sm / display 2.5rem md / near-monumental 3.5rem lg / ceiling 4.5rem xl; the code slab and archive mini-slab size by the Code-Readout Formula below): DSEG7 numeric displays. Letter-spacing 0.12–0.14em because seven-segment displays gap their digits.
- **Code string** (640, 0.3em tracking slab / 0.24em archive, `user-select: all`): The Martian Mono reading layer under every DSEG7 run — the accessible truth of a dispensed code. It rides the ramp, scaling with its well: the slab clamps emphasis→display (1rem→2.5rem, `clamp(--step-1, 4.4cqw, --step-4)`); the my-codes archive mini-slab clamps emphasis→section-display (1rem→1.375rem) — readable-but-subordinate, one tier under the slab's own ceiling.

### Named Rules
**The Readout-Is-Decoration Rule.** DSEG7 layers are always `aria-hidden`; the accessible truth is a Martian Mono string or an `aria-label` with the plain number. Seven-segment is how the machine looks, not how it reads.

**The Code-Readout Formula.** The DSEG7 face is monospaced at a measured 0.816em advance (verified against the shipped woff2 hmtx); adding its 0.12em tracking gives 0.936em per glyph. A run of *n* characters therefore fits any well without overflow when sized by the count: the code slab runs `clamp(2rem, calc(92cqw / 0.936 / n), 10rem)` and the my-codes archive mini-slab runs `clamp(1.375rem, calc(84cqw / 0.936 / n), 4.5rem)` — monumental at every width (an 8-character worst case included), structurally unable to overflow the well. This container-relative fluid term is the system's one intentionally off-ramp size expression. Of the two clamps, only the archive's fixed endpoints are ramp steps (section-display → ceiling); the slab's 2rem/10rem endpoints are the exception's own literals, quoted verbatim here so nothing ships undocumented.

## Layout

One console frame wraps every route: a 6px structural hazard band crowns the page (dim orange, opacity 0.5), then a header rail (wordmark in Anton at 1.75rem + orange tracked-caps tagline + aria-hidden JP micro-label, right bay for surface-aware nav) over a hairline rule, then the body — centered, max-width 76rem (1216px), side padding clamp(0.75rem, 2.5vw, 2rem), top spacing 2.5rem. The frame's left/right/bottom hairlines (dim) close the console at the viewport edges.

Inside the body, panels stack in vertical rhythm on phones and grid up by breakpoint:

- **≤479px (default):** single column; drop-cell artwork fixed at 144px; primary actions go full-width at 4rem min-height (one-hand fan flow); meter slots drop to 12px; the JP micro layer is the first to yield.
- **≥768px:** board grid 2 columns; project header 240px artwork column; console detail head 200px; archive gaps widen to 1.5rem.
- **≥900px:** artist console dashboard 2 columns.
- **Console dashboard header (all widths):** display title left, the launch-tier NEW DROP slab right (meta promise "csv → live link in minutes" beneath it); the slab holds its right berth when the header wraps (margin-left: auto) and goes full-width on phones. The header slab is the screen's one primary in BOTH states — a populated control wall and the first-run "no drops yet" panel, whose footer door is a GhostAction ("start the first drop"), never a second orange slab.
- **≥1200px:** board grid 3 columns, gap 1.5rem.
- **Honest fill (board, all widths):** a trailing cell that would sit alone on an open row fills the row instead — at 2 columns an odd trailing cell spans both tracks; at 3 columns a remainder of one spans the row and a remainder of two ends with a two-track cell. The wide cell then recomposes (below), so no orphan idles beside dead ground and nothing stretches at a fixed height.
- **Standby board (no live drops):** the wall stays built — a `role="status"` wall-status panel (what this console is, plus both doors: fans check back, artists bring codes to `/console`) over one row of unlit drop bays: panel-ground bay outlines carrying the meter's 24 hairline slots at rest with a 10%-alpha phosphor ghost (one step dimmer than a live pool's 15% unlit extent — an empty bay is less lit than a loaded one). The bays follow the board grid including honest fill, are aria-hidden structure (no fabricated titles, artwork, or counts), and breathe one motion-gated idle pulse (3.2s ease-in-out, staggered per bay); reduced motion keeps the static ghost.
- **Project-page state panel (active / paused / drained):** the count + meter are one instrument in every state — the seven-segment count's well hugs its zero-padded digits (never stretched: a full-width readout strands dead space beside the digits) while the 24-slot meter spans the panel width beneath it, shared left edge, the board cell's own grammar. The paused hold's state line leads the panel ("on hold … held, not gone") so the caution-orange readout arrives pre-framed as held, never as danger; the drained panel keeps its readout-first punchline (000, then the celebration copy).

Three component-level container queries do work viewport breakpoints can't: Artwork text-cards drop their JP tag and artist line below a 159px container (the small-card title settling at the data step), the code slab sizes its DSEG7 run by the Code-Readout Formula (`clamp(2rem, calc(92cqw / 0.936 / char-count), 10rem)`; the my-codes archive mini-slab runs the same formula at 84cqw with step endpoints) so the code is monumental at every width without ever overflowing its well, and a drop-cell wider than 640px (its own `inline-size` container) recomposes horizontally — 200px artwork left, artist identity top-right, and the count+meter readout group grounded at the artwork's bottom edge — while cells at normal track width keep the stacked composition.

Spacing runs on the seven-step `--gap` scale (0.25 / 0.5 / 0.75 / 1 / 1.5 / 2.5 / 4rem); 1rem is the workhorse (grid gaps, panel padding), 2.5rem separates page sections, 4rem closes the /design matrix blocks. Body copy caps at a 68ch measure.

## Elevation & Depth

No shadows exist in this system — nothing casts, nothing floats. Depth is tonal and radiative: three grounds of black (ink → panel → panel-inset) stack into a physical console section, 1px hairlines draw the machined seams, and the only bloom is phosphor glow. Glow is a material, not a state: readouts, meter fills, marker squares, and the primary action carry it at rest.

### Shadow Vocabulary
- **Glow, Orange** (`box-shadow: 0 0 18px rgba(255, 92, 26, 0.35), 0 0 2px rgba(255, 92, 26, 0.6)`): Primary action, low-pool meter fills, focused inputs, orange marker squares.
- **Glow, Green** (`0 0 16px rgba(57, 211, 83, 0.3), 0 0 2px rgba(57, 211, 83, 0.55)`): Nominal meter fills, seven-segment readouts (as text-shadow), green markers, the dispensing lamp.
- **Glow, Alarm** (`0 0 16px rgba(232, 16, 42, 0.35), 0 0 2px rgba(232, 16, 42, 0.6)`): Alarm markers and dead-code readouts.

### Named Rules
**The Flat-Plus-Glow Rule.** Surfaces are flat and hairline-ruled; the only radiance is the phosphor glow vocabulary above. No drop shadows, no gradients as decoration (the scanline wash and hazard chevrons are the console's own textures, not ornament).

## Shapes

The form language is machined and square: every corner in the system is 0px — panels, buttons, chips, inputs, wells, meter slots. A 2px radius token exists in the palette but no component consumes it; record square as the built language. Edges are 1px hairlines; emphasis adds corner brackets — four 10px × 2px machined ticks at a box's corners, drawn as eight background strokes on an overlay (`.brackets` in app.css, tone-tinted on panels, orange-bright on the primary action's focus state). Stripes are the second form motif: -45deg hazard chevrons (10px on / 10px off) for structural and drained states. Indicator squares (0.55em chip markers, 0.7em lamps) are drawn, never glyph icons.

## Components

### Buttons
- **Shape:** Square (0px radius); full-width at ≤480px.
- **Primary (PrimaryAction):** The one orange slab per screen — Anton caps at 1.375rem, black on phosphor orange, 1px orange-bright border, resting orange glow, min-height 3.5rem (4rem full-width on phones). One per screen; fan flows are one-hand, one-action.
- **Primary, launch tier (`action--lg`):** The same slab with its label promoted to the headline step of the ramp (clamp 1.75rem→3.5rem, padding 0.75rem 2rem, natural height carrying the tier) — reserved for the console dashboard header's NEW DROP, the standing first step of the 3-minute CSV→link journey, at both populated and first-run states. Same material, same focus grammar; every other screen keeps the 3.5rem slab.
- **Hover / Focus:** Hover brightens to orange-bright. Focus draws four machined corner brackets in the void outside the button (the world's focus grammar); `:active` seats the button 1px down.
- **Secondary (GhostAction):** The console's working button — recessed well ground, 1px hairline border, tracked mono caps in orange (0.75rem, 520), min-height 2.5rem. Hover brightens text and border; focus uses the global 2px orange outline. Disabled state is honest and readable (muted text, transparent ground, not-allowed cursor).

### Chips
- **Style (StatusChip):** Inline-flex on the recessed well, 1px hairline-dim border, tracked-caps mono at 0.625rem/520, leading 0.55em marker square that carries the state glow.
- **State:** available and claimed → green (same green, different words); paused → orange-bright on hairline; drained and reported → alarm-bright text, alarm marker + glow; draft → quiet warm gray, deliberately glow-less.

### Cards / Containers
- **Panel** is this world's card — cards are never nested in panels: warm near-black ground (#100d0b), 1px hairline-dim border, 1rem padding, corner brackets inset 3px riding inside the boundary. A tracked-caps label head (tone-tinted by `tone`: default / nominal / caution / alarm, which also tints brackets and border) with optional right-aligned sublabel and aria-hidden JP tag, ruled off from the body; optional footer row over a top rule.
- **Recessed wells** (`#060505`) sit inside panels for readouts, inputs, and meters — the inset layer of the console.

### Inputs / Fields
- **Style (LabeledField):** Tracked-caps mono label (0.625rem) over a recessed well: 1px hairline border, 3rem min-height, mono text at 1rem with 0.04em tracking, orange caret.
- **Focus:** Hairline border shifts to orange plus the orange glow.
- **Error / Disabled:** Error swaps border to alarm red, message in alarm-bright under `role="alert"`; errors name the problem and the recovery, never just "invalid". Placeholders are AA-readable muted.

### Navigation
- Header rail, surface-aware: fan surfaces carry "my codes" / "artist console"; console surfaces carry "console" / "new drop" plus the signed-in identity (ellipsis-fading, it's data not a link) and sign-out. Tracked mono caps at 0.75rem in orange over a 1px hairline underline; hover brightens; focus is the global 2px orange outline.

### SegmentedMeter
THE availability primitive: a fixed row of 24 slots (14px tall, 12px on phones), each a hairline-edged recessed well; filled segments are the real pool fraction, never a naked percentage. Unfilled slots hold a 15%-alpha ghost of the live tone — the unlit display, the same idea as the code slab's 8.5% all-segments ghost — so the pool's full extent reads as individual empty cells, never a muddy strip. Nominal green fill with green glow; ≤15% remaining honestly turns the fill orange (low); paused holds its claimed fraction lit-but-dimmed (brightness 0.55) over the ghosted pool extent, under a slow structural hazard crawl; drained keeps dead slots (no ghost), alarms the slot edges, and runs the fast alarm crawl beneath. `role="meter"` carries the real numbers; the strip itself is decoration.

### SevenSegmentCount
A count on the DSEG7 face inside a recessed, hairline-ruled well, green/orange/red by tone, letter-spaced 0.14em, zero-padded so the readout keeps its width as the pool drains. Four sizes (emphasis 1rem → ceiling 4.5rem; xl reserved for near-monumental readouts). The container's `aria-label` carries the plain number; the glyph layer is decoration.

### CodeSlab
The product moment — the dispensed code as the biggest object the site ever shows. A recessed well (green hairline; alarm when the code is dead) containing the DSEG7 run over a dim all-segments ghost at 8.5% (the unlit display; the dead-code variant holds its alarm ghost at 9%), sized by the Code-Readout Formula to ~92% of the well at every code length; beneath it the selectable Martian Mono code string (640 weight, 0.3em tracking, `user-select: all`) riding the ramp at `clamp(--step-1, 4.4cqw, --step-4)` — emphasis floor, display-step ceiling, always subordinate to the monument above it — and the copy/redeem actions. On a fresh claim the characters power on one hard `steps()` tick at a time (240ms + 110ms per char), the well breathes one green bloom (1.7s), and the mono layer settles in — all motion-gated; revisits render settled. The my-codes archive reprises the slab in miniature per claim: the same formula at 84cqw (step-2 → step-6 endpoints) with its code string at `clamp(--step-1, 4.5cqw, --step-2)` — readable-but-subordinate.

### Artwork
The drop-cell's visual payload as a fixed square (aspect-ratio 1, container query): the fetched cover, or an honest text-card in the world's own type (display-caps title clamped to the square — settling at the data step below a 159px container, where the JP tag and artist line drop out — tracked artist, orange state line) — never a placeholder image, never a spinner. A failed image load degrades to the text-card in place with zero layout shift.

### ConsoleFrame
The continuous outer frame: hazard band crown, header rail (wordmark + tagline + JP micro), hairline side/bottom borders, centered 76rem body. `framed={false}` drops the border for full-bleed surfaces that keep the rail.

## Do's and Don'ts

### Do:
- **Do** use exactly one PrimaryAction per screen; every other control is GhostAction or a text link.
- **Do** render every meter and count from real pool numbers — a meter is segments of a true fraction, a readout a true value; `--alarm` in reading sizes is always the bright tint.
- **Do** gate every animation behind `prefers-reduced-motion: no-preference` (140ms ease-out transitions, `steps()` ticks, the two hazard crawls at 1.4s structural / 0.9s alarm, the 2.8s phosphor pulse, the 3.2s standby bay breathe).
- **Do** draw focus with the world's grammar: the global 2px orange outline at 3px offset, or corner brackets outside the slab — always visible, never removed.
- **Do** keep depth tonal: ink → panel → recessed well, separated by 1px hairlines, with glow as the only radiance.
- **Do** pair every state color with words (chip text, tone-tinted label, adjacent count) — color never carries state alone.

### Don't:
- **Don't** use alarm red as decoration, flavor, or small body text — it means drained, dead, or error, and small alarm text is `#ff3b4a`.
- **Don't** round corners, add drop shadows, or use gradients as ornament; the world is square, flat, and hairline-ruled (scanlines and hazard chevrons are the pinned exceptions).
- **Don't** invent scarcity or counts — no fabricated pools, no placeholder artwork, no spinner pretending work is happening.
- **Don't** nest cards inside panels; Panel is the card. Compose inside it with wells, meters, chips, and fields.
- **Don't** let the DSEG7 layer be the reading surface — it is always aria-hidden decoration over an accessible mono string or aria-label.
