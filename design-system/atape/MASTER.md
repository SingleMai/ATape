# ATape Master Design Contract

Status: **Accepted for v0.1**  
Visual direction: **Cozy Island Workshop**  
Last updated: 2026-09-04

Production implementation: [`packages/ui`](../../packages/ui/README.md). This document owns the visual contract; `@atape/ui` owns its reusable code and semantic token Interface.

This document is the source of truth for ATape's visual language. It describes the product-wide contract; a page-specific file under `pages/` may override a rule only when it states the difference explicitly.

## 1. Product feeling

ATape should feel like a calm island workshop where a team leaves useful traces for one another. It is friendly and tactile without becoming a toy, a game UI, or an analytics dashboard.

The visual system combines:

- warm, paper-like reading surfaces;
- seafoam navigation and nature-derived accents;
- soft organic silhouettes and rounded geometry;
- restrained handmade details such as dashed separators;
- compact, professional information density for developer workflows.

Design dials:

| Dial | Target | Meaning |
|---|---:|---|
| Variance | 5/10 | Recognizable personality without irregular layouts |
| Motion | 4/10 | Short tactile feedback; no decorative choreography |
| Density | 7/10 | Compact enough for sessions and long conversations |

## 2. Naming and intellectual-property boundary

The internal design name is **Cozy Island Workshop** or **ATape Island**. Public product copy must not call ATape an “Animal Crossing UI” or imply a relationship with Nintendo.

[Animal-Island-UI](https://github.com/guokaigdg/animal-island-ui) is a mood reference only. It is licensed under [CC BY-NC 4.0](https://github.com/guokaigdg/animal-island-ui/blob/main/LICENSE), and its README explicitly prohibits commercial use.

Therefore ATape must not:

- add Animal-Island-UI as a runtime or build dependency;
- copy its source code, exact component implementations, token sheet, icons, illustrations, cursor, animations, or bundled assets;
- use Nintendo names, logos, characters, silhouettes, UI captures, sound effects, or other protected trade dress;
- market itself as official, compatible with, or endorsed by either project.

ATape may independently use broad design ideas that are not unique assets: a warm natural palette, rounded controls, paper-like surfaces, organic CSS geometry, and tactile feedback. All production tokens, components, illustrations, and icons must be independently authored and distributed under an ATape-compatible license.

## 3. Design principles

### 3.1 Conversation first

The unified conversation is the product. Decoration must never reduce message width, scannability, code readability, or the ability to follow a long thread.

### 3.2 Friendly, not childish

Use warmth, color, and organic forms. Avoid mascots in core work surfaces, noisy patterns, novelty copy, exaggerated bouncing, and candy-like controls everywhere.

### 3.3 Honest data states

Activity, lifecycle, and capture quality must remain explicit text. Never communicate healthy/degraded/active status using color alone.

Only render events that exist. Do not add empty “this Harness did not provide…” panels to the normal conversation flow. Show `partial`, `degraded`, or `unanchored` only where the limitation materially changes how the user should trust the displayed data.

### 3.4 Project context is persistent

Team and Project location must stay visible while browsing activity, search results, a session, or Raw data. Warm visual styling must not obscure navigation hierarchy.

### 3.5 Raw is intentionally secondary

Canonical replay is the default reading surface. Raw uses a separately loaded, visually distinct code surface; opening Raw must feel deliberate rather than like another conversation tab. Whether it appears as a drawer or a full route is an experience decision, not a visual-system rule.

## 4. Foundation tokens

Production components must consume semantic tokens. Screen-level code must not introduce ad-hoc hex colors for ordinary UI states.

```css
:root {
  /* Core surfaces */
  --atape-color-canvas: #eef7e8;
  --atape-color-navigation: #d8f3ec;
  --atape-color-panel: #fffaf0;
  --atape-color-paper: #fffdf7;
  --atape-color-surface-muted: #f5efdf;

  /* Content */
  --atape-color-text: #5b4533;
  --atape-color-text-muted: #786753;
  --atape-color-border: #d6c6a6;
  --atape-color-border-soft: #e9dfc9;

  /* Brand and actions */
  --atape-color-accent: #237f70;
  --atape-color-accent-bright: #54c8ad;
  --atape-color-accent-soft: #d9f2e8;
  --atape-color-on-accent-bright: #493b2c;
  --atape-color-focus: #e8b900;

  /* Island accents */
  --atape-color-yellow: #f4cc61;
  --atape-color-yellow-soft: #fff1b9;
  --atape-color-coral: #e88f78;
  --atape-color-blue: #8fc7dc;
  --atape-color-lavender: #b6a5df;
  --atape-color-green: #8fc98d;

  /* Semantic states */
  --atape-color-success: #77c978;
  --atape-color-success-border: #4f9e59;
  --atape-color-success-soft: #dbefd9;
  --atape-color-warning: #9a661e;
  --atape-color-danger: #a84e45;
  --atape-color-code: #372b23;
  --atape-color-code-text: #f2e6d2;

  /* Geometry */
  --atape-radius-sm: 14px;
  --atape-radius-md: 20px;
  --atape-radius-lg: 28px;
  --atape-radius-pill: 999px;

  /* Spacing */
  --atape-space-1: 4px;
  --atape-space-2: 8px;
  --atape-space-3: 12px;
  --atape-space-4: 16px;
  --atape-space-6: 24px;
  --atape-space-8: 32px;
  --atape-space-12: 48px;
  --atape-space-16: 64px;

  /* Motion */
  --atape-duration-fast: 150ms;
  --atape-duration-normal: 200ms;
  --atape-duration-page: 300ms;
  --atape-ease-standard: cubic-bezier(.4, 0, .2, 1);
}
```

Validated contrast ratios in the accepted prototype:

| Foreground / background | Ratio |
|---|---:|
| Text / panel | 8.61:1 |
| Muted text / panel | 5.22:1 |
| Text / canvas | 8.15:1 |
| Muted text / canvas | 4.94:1 |
| Accent text / paper | 4.76:1 |
| Primary-button text / bright accent | 5.27:1 |
| Code text / code surface | 11.11:1 |

Do not assume a new token pair is accessible merely because each color appears in this palette. Test the actual foreground/background pair.

## 5. Typography

```css
font-family:
  Nunito,
  "Noto Sans SC",
  -apple-system,
  "PingFang SC",
  sans-serif;
```

- Nunito carries Latin text and the rounded brand character.
- Noto Sans SC carries Simplified Chinese and mixed-language product copy.
- Body text: 16px minimum, weight 500, line-height 1.5–1.65.
- Page title: 25–32px, weight 900.
- Section heading: 18–20px, weight 800.
- Component title and button: weight 700–800.
- Metadata: 12–14px, weight 500–700. No normal UI text below 12px.
- Monospace is reserved for source code, Raw content, IDs, hashes, and exact commands.
- Avoid weights below 400, condensed type, all-caps paragraphs, and novelty display fonts.

## 6. Shape, border, and depth

- Interactive controls use at least 14px radius; primary buttons and inputs use pill geometry.
- Cards use 20px radius; major project/header surfaces may use 28px.
- Standard structural borders are 2px warm neutral, never cold gray or pure black.
- Dashed borders and separators are allowed for secondary structure, child relationships, and workshop-like detail.
- Organic background shapes are decorative, low contrast, CSS-authored, and `aria-hidden`.
- Default cards do not float on large shadows. Their hierarchy comes from color, border, and spacing.
- Default buttons use a soft warm elevation of at most `0 4px 9px rgba(91,69,51,.11)` on hover.
- A short stacked shadow is reserved for primary actions. Do not apply game-button depth to every control.
- Hover may lift a card by at most 2px. Pressed states may move a control by 1–3px without shifting surrounding layout.

## 7. Color usage

- Canvas, navigation, and reading surfaces remain low-saturation and warm.
- Teal is for navigation selection, links, focus, and primary actions.
- Yellow is for highlights and attention, not long text backgrounds without contrast validation.
- Coral, blue, lavender, and green provide categorical variation for summaries and avatars; they do not encode a state by themselves.
- Red is reserved for destructive/error semantics.
- Avoid pure black, cold gray dashboards, large saturated backgrounds, neon colors, and uncontrolled gradients.
- The v0.1 contract defines a light theme. Do not auto-invert these tokens to manufacture dark mode. A dark theme requires a separately designed and tested token map.

## 8. Component grammar

### Navigation

- Navigation must preserve Team and Project context without competing with the current conversation.
- The active destination sits on a paper surface with teal text and a visible border.
- Labels remain visible; icons support recognition but never replace navigation text.
- Search may be presented as a context-preserving layer; it does not require a permanent top-level destination.
- Desktop and mobile navigation structures may differ, but Back behavior and deep links must remain predictable.

### Buttons

- Minimum interactive height: 44px.
- Primary actions use bright teal, dark warm text, a restrained stacked shadow, and a visible teal focus ring.
- Secondary actions use paper surfaces, warm borders, and soft elevation only.
- Ghost buttons are limited to predictable Back/Cancel-style navigation.
- Every async action needs pending feedback and must prevent duplicate submission.

### Inputs and search

- Search and primary text inputs use pill geometry and visible labels or an accessible name.
- Keyboard focus uses the yellow focus token; never remove focus outlines without an equivalent replacement.
- Search results highlight the matching term without lowering text contrast.

### Cards and rows

- Summary cards may use one muted island accent each.
- Dense lists use one shared outer panel with dashed row separators; do not turn every row into a floating card.
- Hover is supportive only. The full action must work by click/tap and keyboard.

### Tags and metadata

- Tags are compact pills with warm neutral surfaces.
- Tags describe Harness, branch, message count, child count, or status metadata; they must not dominate the session title.
- Avoid a wall of colored chips. Use color only when it improves grouping.

### Conversation messages

- Message content controls the visual hierarchy; speaker and time are supporting metadata.
- User and agent turns may use subtly different paper tones, but both must remain comfortable for long reading.
- Code, tool calls, artifacts, and child-thread cards are embedded only when an event actually exists.
- Tool calls are collapsed by default when their output would interrupt the conversation.

### Subagent threads

- A child thread appears as a contextual card at its spawn point and in the current thread path. A persistent tree is optional, not mandatory.
- Child-thread cards use the accent-soft surface and a dashed relation border.
- `partial` is shown as text near the child identity. Missing child content never produces a fake thread or placeholder conversation.

### Status

- Pair a shape/marker with text such as `Active · healthy`, `Idle · degraded`, or `Disconnected`.
- Lifecycle, activity, and capture state remain separate concepts even if a compact row summarizes them.

### Raw and code

- Raw opens through an explicit secondary action and a separately loaded page, drawer, or layer.
- Use the dark warm code surface with high-contrast light text and monospace typography.
- Keep Raw paging/download controls outside the code block.
- Raw must never inherit playful patterns that reduce source readability.

## 9. Icons and illustration

- Structural icons use one consistent rounded, 2px-stroke vector family or independently authored CSS geometry.
- Do not use emoji as navigation, status, or action icons.
- Decorative icons beside visible text are hidden from assistive technology.
- Icon-only buttons require an accessible name and a minimum 44×44px target.
- Product illustrations, if added later, must be original ATape assets. Keep them out of dense replay/search surfaces.

## 10. Motion

- Interaction feedback: 150–200ms.
- Page or list entrance: up to 300ms and 8px of travel.
- Use the standard easing token unless spatial continuity requires a documented exception.
- Motion communicates hover, press, expand/collapse, or route continuity. It must not run merely to make the product feel game-like.
- Respect `prefers-reduced-motion`; render the final state immediately when motion is reduced.
- Avoid autoplay, looping ambient animation, parallax in work surfaces, and spring/bounce on repeated actions.

## 11. Responsive layout

Canonical validation widths are 375, 768, 1024, and 1440px.

- Above 1180px: workspace navigation and the reading surface may coexist without narrowing the conversation below its readable measure.
- 861–1180px: secondary metadata progressively collapses before the message column loses readability.
- 641–860px: workspace navigation may become a compact top shell; conversation content remains one primary column.
- 375–640px: interactive cards, metadata, filters, search and message content stack without hiding actions.

Requirements at every width:

- no document-level horizontal scrolling;
- no fixed-width message column that clips code or long identifiers;
- sticky UI must not obscure keyboard focus;
- text scaling must not make actions unreachable;
- desktop information may rearrange but must not disappear without an accessible alternative.

## 12. Accessibility and performance gates

A UI is not conformant unless all applicable gates pass:

- normal text contrast is at least 4.5:1; meaningful non-text boundaries are at least 3:1;
- every operable element is keyboard reachable with a visible focus indicator;
- visual order and keyboard order match;
- pointer/touch targets are at least 44×44px where practical and never below WCAG's 24×24px web minimum without an exception;
- color is never the only carrier of status or meaning;
- headings are sequential and landmarks are present;
- reduced-motion is supported;
- long lists above roughly 50 rendered rows use pagination or virtualization;
- fonts use swap/optional loading behavior and the system fallback keeps layout usable;
- images reserve dimensions and non-critical images are lazy-loaded;
- repeated input/search work is debounced, and one interaction must not block the main thread for a frame budget;
- loading, degraded, disconnected, empty, and error states are designed explicitly.

## 13. Voice and microcopy

- Calm, direct, and specific. Prefer `Capture degraded · 2 files unreadable` over `Oops, something went wrong!`.
- Use established domain words consistently: Team, Project, Session, Thread, Canonical, Raw, Harness, Adapter.
- Friendly styling does not justify whimsical names for technical states.
- State what ATape knows; do not infer missing Harness behavior.

## 14. Hard anti-patterns

Do not ship:

- Nintendo or Animal-Island-UI assets, code, exact component replicas, or trademark-adjacent naming;
- emoji used as structural icons;
- pure-black outlines, cold-gray dashboard chrome, or neon accents;
- a thick 3D shadow on every button/card;
- decorative motion that competes with conversation reading;
- giant hero art inside authenticated product surfaces;
- analytics-style charts on the Activity page when a session list answers the user question;
- one card per tiny metadata field;
- hidden focus rings, hover-only actions, color-only status, or controls under 24×24px;
- empty capability panels or fake Subagent threads;
- Raw payloads mixed into the default Canonical message response.

## 15. Review checklist

Before accepting a new page or component:

- [ ] It uses semantic ATape tokens rather than screen-local colors.
- [ ] Conversation and code readability win over decoration.
- [ ] Team/Project context and a predictable Back path are visible.
- [ ] Actual event availability drives what is rendered.
- [ ] Keyboard, focus, target size, contrast, and reduced-motion checks pass.
- [ ] It works at 375, 768, 1024, and 1440px without document overflow.
- [ ] Icons are consistent, accessible, and not emoji.
- [ ] Status includes text and does not rely on color.
- [ ] Raw remains an explicit secondary surface.
- [ ] No third-party visual asset or dependency violates ATape's license boundary.

## 16. Accepted reference artifact

- Interactive prototype: `../../.wayfinder-prototypes/web-v01/index.html`
- Review notes: `../../.wayfinder-prototypes/web-v01/REVIEW.md`
- Persistent prototype asset: https://gist.github.com/SingleMai/49f7af2ab980a01c48af6cfd1858c20f

The prototype demonstrates the direction; this contract governs production implementation when the two differ.
