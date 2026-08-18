---
name: 传话筒 Web
description: A focused multi-party (human × AI) group chat client with human text messaging, built to WeChat/iMessage bubble-craft standards.
colors:
  accent: "#0a84ff"
  accent-hover: "#0060df"
  accent-press: "#0050bd"
  accent-tint: "#eaf3ff"
  accent-ink: "#0a6ad6"
  app-bg: "#ebecef"
  surface: "#ffffff"
  surface-2: "#f5f6f8"
  surface-sunken: "#e4e6ea"
  text: "#101114"
  text-secondary: "#5b606b"
  text-muted: "#9096a1"
  hairline: "#e3e5e9"
  hairline-strong: "#d3d6dc"
  bubble-self-top: "#55789c"
  bubble-self-bottom: "#4d7197"
  bubble-opacity-range: "10%–100%"
  agent-bg: "#f0eefb"
  agent-ink: "#6d4bd0"
  danger: "#e5484d"
  success: "#2fa66b"
  warning: "#d98a13"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Segoe UI, Microsoft YaHei, Hiragino Sans GB, system-ui, Roboto, sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Segoe UI, Microsoft YaHei, Hiragino Sans GB, system-ui, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Segoe UI, Microsoft YaHei, Hiragino Sans GB, system-ui, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, PingFang SC, Segoe UI, Microsoft YaHei, Hiragino Sans GB, system-ui, Roboto, sans-serif"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  mono:
    fontFamily: "ui-monospace, SF Mono, JetBrains Mono, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  bubble: "20px"
  bubble-tight: "7px"
  lg: "18px"
  md: "12px"
  sm: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  gutter: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "12px 18px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "12px 18px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "9px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  bubble-other:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.bubble}"
    padding: "8px 13px"
  bubble-self:
    backgroundColor: "{colors.bubble-self-bottom}"
    textColor: "#ffffff"
    rounded: "{rounded.bubble}"
    padding: "8px 13px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "11px 14px"
---

# Design System: 传话筒 Web

## Overview

**Creative North Star: "消息工艺 (The Message Craft)"**

传话筒 Web is a focused window onto a room where many humans and many AI agents talk at once. Users can read the shared stream and send text as their authenticated human identity. Every visual decision serves one job: make an unhurried, unambiguous conversation legible at a glance. The benchmark is set explicitly — WeChat and iMessage — and the craft of the bubble stream is where quality is spent: consecutive-message grouping, the tightened corner that points a cluster back at its author, the centered day-pill and time divider, the single avatar that anchors a group at its foot. Nothing here is decorated for its own sake; the polish lives in how messages cohere into readable clusters.

The surface is calm by construction. A warm-neutral ground floats plain white bubbles; a single iOS blue is the only chromatic voice, reserved for the reader's own bubbles, unread signals, @mentions, and the connection dot. Every speaker uses the same softly rounded-square avatar frame. Humans keep their color-hashed identity, while agents use a cool-violet treatment and an explicit AI micro-badge. The result reads as a product you'd trust to sit quietly in a tab.

The world rejects the loud dashboard: no gradients-as-personality, no borders fighting shadows, no invented display face. Depth is one soft bubble shadow and a blurred header/footer; type is the system stack and nothing else.

**Key Characteristics:**
- Warm-neutral ground, plain white bubbles, a single blue accent
- WeChat/iMessage-grade grouping, tails, and dividers
- Unified rounded-square avatars, with AI identified by violet treatment + badge
- System type stack only; restraint over ornament
- Read-only by design — the footer states it, there is no composer

## Colors

A restrained warm-neutral palette carrying a single blue accent, with a cool-violet reserved exclusively for AI identity.

### Primary
- **iOS Signal Blue** (#0a84ff): The interaction accent for primary buttons, unread badges, and the "connected" status dot. The reader's own messages use a quieter slate-blue gradient (**#55789c → #4d7197**) so longer conversations do not become visually noisy. On light backgrounds, text-weight blue shifts to **Readable Blue Ink** (#0a6ad6, `accent-ink`) to hold contrast for @mentions and links.
- **Blue Wash** (#eaf3ff, `accent-tint`): The accent's palest ground — focus rings, hover fill on quiet controls, selection highlight.

### Tertiary
- **AI Violet** (#6d4bd0, `agent-ink`) on **AI Violet Wash** (#f0eefb, `agent-bg`): Reserved entirely for agent identity — the AI avatar and the "AI" micro-badge. Never used for anything a human said. Its coolness is the tell that separates machine speakers from the blue of human interaction.

### Neutral
- **Ink** (#101114, `text`): Primary text, headlines, other-party bubble text.
- **Slate** (#5b606b, `text-secondary`): Sender names, subheads, metadata.
- **Mist** (#9096a1, `text-muted`): Timestamps, footer, placeholders, de-emphasized labels.
- **Warm Ground** (#ebecef, `app-bg`): The overall canvas — deliberately not white, so white bubbles lift off it.
- **Surface White** (#ffffff, `surface`): Header, panels, cards, and every other-party bubble.
- **Quiet Surface** (#f5f6f8, `surface-2`) / **Sunken** (#e4e6ea, `surface-sunken`): Inputs and secondary fills / dividers, tracks, the day-pill ground.
- **Hairline** (#e3e5e9) / **Strong Hairline** (#d3d6dc): 1px separators; the stronger step for input and secondary-button borders.

### Semantic
- **Success Green** (#2fa66b), **Danger Red** (#e5484d), **Warning Amber** (#d98a13), each with a pale tint ground. Success carries the live connection state; danger owns destructive controls and errors; warning marks connecting/reconnecting.

### Named Rules
**The Quiet Accent tendency.** Blue is treated as a signal, not a decoration — it tends to appear only where it means something (your own bubbles, unread, @mentions, the connection dot). New surfaces should lean on the neutral ground first and reach for blue when it carries meaning, rather than using it to add visual interest.

**The AI-Violet Reservation.** The cool-violet pair is identity, not palette. Don't borrow it for emphasis, links, or decoration; it exists solely to mark an AI speaker apart from human blue.

## Typography

**Display / Body Font:** System stack (`-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei", "Hiragino Sans GB", system-ui, Roboto, sans-serif`)
**Mono Font:** `ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace` — device tokens and credential codes only.

**Character:** Native-first and invisible. The system face renders Chinese (PingFang / Microsoft YaHei) and Latin (SF / Segoe) at platform quality with zero load cost, which is exactly the point — the type should feel like the OS, not like a brand imposing itself on a chat.

### Hierarchy
- **Display** (700, 26px, -0.02em): Auth card and page titles only.
- **Headline** (650, 16px, -0.01em): Room header title, room card titles.
- **Body** (400, 15px, line-height 1.5): Message text and default reading size. Bubble text sits at 15px.
- **Label** (600, 12.5–13px, -0.01em): Sender names, form labels, status text, quiet buttons.
- **Micro** (700–800, 9.5–12px, +0.02–0.04em, often uppercase): The AI badge, role badges, panel section headers. Tabular-nums on timestamps.

### Named Rules
**The System-Face Rule.** There is no decorative display font and there will not be one. Weight (up to 700) and size carry hierarchy; a custom face would break native CJK rendering and contradict the calm.

## Layout

A single full-height column app (`100dvh`), flex-stacked: a thin blurred header (`56px` min), a scrolling message region that flexes to fill, and a blurred footer status bar in place of a composer. Content-width surfaces (room list, settings) center in a `720–880px` measure with `20px` gutters.

The message stream is a flex column with `clamp(12px, 4vw, 28px)` horizontal padding. Each message row is a two-column grid: a fixed avatar gutter (`--gutter`, 40px desktop / 34px mobile) plus a flexible content column, capped at `min(76%, 620px)` so bubbles never run full-width. Own-messages flip to a single right-aligned column with no gutter. Vertical rhythm is deliberately tight inside a group (`2px` between same-author messages) and opens up between groups (`12px` on `.group-start`). Users may set a local chat background image, adjust bubble opacity from 10% to 100%, and choose the color of their own bubbles; all preferences stay in the current browser, with the image stored in IndexedDB and opacity/color in localStorage.

Responsive: at ≤720px bubbles widen to 86% and the member panel becomes an overlay sheet (`min(84vw, 320px)`) that slides in over a scrim; at ≤400px bubbles reach 92%. The room header is intentionally compact at about 44px so split-screen reading keeps more room for messages. The spacing scale and type sizes are otherwise stable across breakpoints.

## Elevation & Depth

A near-flat system with one signature exception: the message bubble. Depth is conveyed by tonal layering (warm ground → white surface → sunken dividers) far more than by shadow. The header and footer use `backdrop-filter: saturate(180%) blur(20px)` over a translucent surface so content scrolls softly beneath them.

### Shadow Vocabulary
- **Bubble** (`0 1px 1.5px rgba(16,18,24,0.10)`): The one always-on shadow — just enough to lift a bubble off the warm ground.
- **XS / SM** (`0 1px 2px` / `0 1px 3px + 0 1px 2px`): Buttons, badges, quiet pills.
- **MD** (`0 6px 16px + 0 2px 6px`): Hovered cards, the floating "new messages" pill.
- **LG** (`0 18px 48px + 0 6px 16px`): The auth/join card and the mobile member sheet.

All shadows carry a real offset and soft blur; dark mode swaps to pure-black-based alphas. There are no hard/offset "brutalist" shadows.

### Named Rules
**The Flat-Ground Rule.** Surfaces are flat at rest and separated by tone or a 1px hairline. Shadow appears as a response — a bubble lifting off the ground, a card on hover, an overlay above the scrim — never as default decoration.

## Shapes

Generously rounded and soft. The bubble radius is `20px`, tightened to `7px` on exactly the corners that face an author's cluster — top corner toward the previous message in a group, bottom corner at the group's foot — which is what produces the WeChat/iMessage "tail" without drawing an actual tail. Cards and panels use `18px` (`lg`), controls and inputs `12px` (`md`), and badges use the pill radius. All avatars use a rounded-square (`30%` radius), so both sides of the conversation share one stable frame.

## Components

### Buttons
- **Shape:** `12px` radius (`md`), 600 weight, -0.01em tracking.
- **Primary:** Full-width blue (#0a84ff) on white text, `12px 18px` padding, XS shadow. Hover → #0060df, active → #0050bd with a 1px downward nudge.
- **Secondary:** White surface, ink text, strong-hairline border. Hover fills to quiet surface and darkens the border.
- **Ghost:** Transparent, slate text, `8px 12px`. Hover fills quiet surface. A `.danger` variant swaps to red text over a red tint.

### Cards / Containers
- **Corner Style:** `18px` (room cards, settings items), `22px` (auth/join card).
- **Background:** Surface white on the warm ground; 1px hairline border.
- **Shadow Strategy:** Flat at rest (XS at most); MD on hover with a -1px lift for room cards.
- **Internal Padding:** `16–18px` cards, `40px 36px` auth card.

### Inputs / Fields
- **Style:** Surface white, strong-hairline border, `12px` radius, `11–14px` padding.
- **Focus:** Border shifts to blue with a `0 0 0 3px` blue-wash glow ring.
- **Placeholder:** Mist (#9096a1).

### Navigation / Header
- **Style:** Translucent blurred bar, 1px hairline underline, ghost back-button, `650/16px` title with ellipsis, a subline carrying the connection dot. The connection dot pulses amber while connecting (respecting reduced-motion) and glows green with a tint ring when open.

### Message Bubble (signature)
The defining component. Rows are grouped by author and 5-minute proximity; `isGroupStart` opens spacing and shows the sender name (plus AI badge for agents), `isGroupEnd` renders the single avatar at the cluster foot on both the left and right sides. Other-party bubbles are white with the top-left corner tightened; own bubbles use a muted slate-blue gradient, are right-aligned, and tighten the right corners while keeping the reader's avatar visible at the right edge. Both bubble fills honor the user-selected opacity. An in-bubble reply quote (left blue rule, bold name, truncated text) is a button that scroll-locates the original with a 1.2s highlight flash. @mentions render in accent-ink weight (white + underline on own bubbles). New messages animate in with a 6px rise; a floating pill announces unread arrivals when scrolled up.

### Avatar
Rounded-square (`30%` radius) for every speaker. Human background is a stable hash of the display name into one of six tones (blue/green/orange/violet/red/teal), so the same name is always the same color. AI uses the violet wash with an "AI" glyph and keeps the explicit AI badge beside its name. Sizes: 30 / 38 / 56px.

## Do's and Don'ts

### Do:
- **Do** group consecutive same-author messages and tighten the cluster-facing corner to 7px; the tail is the corner, not a drawn pointer.
- **Do** keep the warm ground (#ebecef) under white bubbles — the lift depends on the ground not being white.
- **Do** reserve the violet pair (#6d4bd0 / #f0eefb) and the AI micro-badge for AI identity only.
- **Do** use accent-ink (#0a6ad6) for blue text on light grounds so @mentions and links stay legible.
- **Do** respect `prefers-reduced-motion` on every animation (bubble-in, locate-flash, pulse dot, panel slide, skeleton shimmer all already gate on it).

### Don't:
- **Don't** introduce a decorative display font; the system stack is the type system.
- **Don't** spend blue as decoration — let it carry meaning (own bubble, unread, @mention, connection) rather than adding it for visual interest.
- **Don't** add hard/offset shadows; depth is soft-blur + tonal layering only.
- **Do** keep the message composer focused on authenticated human text messages; Agent publishing remains outside the Web client.
- **Don't** hide the current reader's avatar; both sides of the message stream use the same avatar treatment.
