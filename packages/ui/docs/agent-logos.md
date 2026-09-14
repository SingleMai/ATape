# Agent logos

This guide owns ATape's approved **A3 / Soft Glow** agent-logo family. The current
assets are [Codex](../src/styles/themes/cozy-island/agents/codex.svg),
[Claude Code](../src/styles/themes/cozy-island/agents/claude-code.svg),
[WorkBuddy](../src/styles/themes/cozy-island/agents/workbuddy.svg),
[Grok](../src/styles/themes/cozy-island/agents/grok.svg) and
[Kimi Code](../src/styles/themes/cozy-island/agents/kimi-code.svg).
They are custom ATape identifiers derived from the universal tape cartridge,
not exact reproductions of official provider logos.

## Location and naming

Keep production SVGs in `packages/ui/src/styles/themes/cozy-island/agents/`,
beside the theme's universal `brand-mark.svg`. Use one lowercase kebab-case
filename per agent, such as `codex.svg` or `claude-code.svg`. Use stable agent
names, without design iteration numbers or provider model versions.

This directory is inside the Web Vite `publicDir`; its files are served at
`/agents/<name>.svg` and copied unchanged into the production build. Keep only
browser-facing SVG assets there. Design rules belong in this guide; concept
boards, generated bitmaps and temporary previews stay outside production assets.

## Fixed visual rules

- Keep the square single-reel cartridge, rounded corners, clipped lower-right
  corner, five reel dots, lower-left slot and dot, and bent tape-end opening.
- Keep `width="96"`, `height="96"` and `viewBox="0 0 96 96"`. The silhouette
  occupies coordinates 5–91, preserving the same safe margin across agents.
- The reel is centered at `(47, 43)` with radius `29`. The five dots have radius
  `4.2`, lie on a radius-22 circle, and repeat every 72 degrees starting at the
  top. Copy the existing SVG's geometry rather than approximating it anew.
- The background and all openings are transparent, including the reel around
  the symbol. Do not bake white or a page background into the artwork.
- Change the center symbol to identify the agent. Preserve the cartridge's
  proportions; keep the symbol optically centered and separate from the dots.
- The approved Codex and Claude symbols use
  `translate(47 43) scale(1.10) translate(-47 -43)`: **10% larger than the initial
  vector drawing**, not 15%. Their original rounded stroke widths are 4.5 and
  4.3 respectively, before that scale. These current SVGs are the visual sizing
  reference for new symbols; a different symbol may need optical adjustment to
  achieve the same apparent size and clear spacing.

## Color and soft glow

Use the agent's recognizable color family. ATape yellow belongs to the universal
site mark; do not reuse it as the common shell color for all agents. The approved
palette below is the ATape treatment, not a claim about official brand hex values.

| Agent | Base | Soft light | Highlight | Center symbol |
| --- | --- | --- | --- | --- |
| Codex | `#0872F9` | `#388FFA` | `#88CEFA` | Terminal `>_` |
| Claude Code | `#DA704B` | `#E98964` | `#F7B697` | Eight-ray asterisk |
| WorkBuddy | `#28B894` | `#61CDAF` | `#A9E7D5` | Tilted cat-ear head with two cutout eyes |
| Grok | `#34373B` | `#656B73` | `#A2A9B2` | Open orbit with a diagonal slash |
| Kimi Code | `#262729` | `#53565A` | `#94999F` | Bold straight-legged K with a blue accent dot |

The three added designs follow primary visual references reviewed on 2026-09-15:
[WorkBuddy](https://copilot.tencent.com/work/) supplies the cat-ear motif and
green download-button color; [Grok](https://grok.com/) supplies the monochrome
orbit/slash identity. Kimi Code follows the user-provided black app-icon reference
with a bold K and a small blue dot at its upper right. Its accent `#1783FF` is
also present in the [Kimi Code](https://www.kimi.com/code) CLI illustration.
The simplified glyphs and lighter palette stops are ATape adaptations.

The shared presentation mapping uses the following correspondence. It does not
rename the existing Adapters or change their capture capabilities:

| Existing provider ID | Visual label | Asset URL |
| --- | --- | --- |
| `codex` | Codex | `/agents/codex.svg` |
| `claude` | Claude Code | `/agents/claude-code.svg` |
| `codebuddy` | WorkBuddy | `/agents/workbuddy.svg` |
| `grok` | Grok | `/agents/grok.svg` |
| `kimi` | Kimi Code | `/agents/kimi-code.svg` |
| `opencode` | OpenCode | Text fallback; no artwork yet |

The `codebuddy` → WorkBuddy visual correspondence follows the product request;
it does not claim support for additional WorkBuddy capture formats. The existing
Grok Build and Kimi Code CLI Adapter scope is likewise unchanged.

Within each icon, the shell, reel dots and center symbol **share the same color
treatment in the same coordinate system**. Use one mask containing all three,
then paint the shared material through it. Do not give the center a darker
gradient, separate ink color or additional shadow. The base color remains the
reference; the effect only introduces lighter regions.

Kimi Code has one deliberate local exception matching the supplied reference:
the small upper-right identity dot is blue (`#1783FF`), at `(59.5, 28.5)` with
radius `2.2`. It is separate from the five structural reel dots and the shared
mask. The K, shell and reel dots still share the same grayscale material. This
does not permit a separately darkened center or arbitrary accent colors on
other agents. At small sizes, the K remains the primary identifier; the tiny
blue dot is supplementary.

The current soft-glow recipe is:

- A linear gradient in user space from `(13, 10)` to `(84, 91)`. Stops at
  `0`, `.2`, `.39`, `.56`, `.68`, `.82`, `1` use respectively base, soft light,
  base, soft light, highlight, base, base. No stop is a darker shade of the base.
- An elliptical radial highlight with
  `translate(60 7) rotate(132) scale(65 19)`, radius 1 at the origin. It uses
  the highlight color fading from opacity `.85` to `0`, over the linear gradient.
- Clean vector edges and restrained color blending. No grain/noise filter,
  embedded raster texture, bevel, extrusion, metallic effect or drop shadow.
  The image-generated concept's grain is intentionally omitted in SVG.

These gradients are an intentional, bounded treatment of agent identity assets;
they do not establish a general gradient style for UI controls or surfaces.

## SVG and rendering contract

Use native SVG paths, gradients and a luminance mask, with no scripts, embedded
bitmaps, font dependencies or external resources. Prefix every internal ID and
reference with the agent name, including the accessible title. Keep assets
compact; the current examples are approximately 2 KB each.

Application views render through the shared UI Interface:

```tsx
import { AgentIdentity, resolveAgentIdentity } from "@atape/ui"

<AgentIdentity provider={session.actor.harness} />
<AgentIdentity provider={row.agent} size={32} iconOnly />
const label = resolveAgentIdentity(row.agent).label
```

[`resolveAgentIdentity`](../src/agentIdentity.ts) is the single owner of aliases,
display names and image paths. It returns `{ id, label, iconSrc }`. `id` and
`iconSrc` are undefined for unknown providers; OpenCode has a known ID and label
but no image. Name matching trims whitespace, ignores case, normalizes whitespace
and underscores to hyphens, then matches an explicit alias. Captured names such
as `codebuddy-code`, `grok-build` and `kimi-code` resolve alongside catalog IDs.
Unknown strings keep their trimmed text; substring matches and paths synthesized
from input are deliberately excluded. This is visual normalization only: filter
values, Canonical authors, protocol IDs and source names retain their data values.

[`AgentIdentity`](../src/agentIdentityView.tsx) consumes this function. It supports
24px (default) and 32px, an optional placement class, and `iconOnly`. Missing
artwork or image-loading errors reveal the name even in icon-only mode; empty
input displays an em dash. If the provider changes after a failed image, the new
asset is attempted. Adding a logo means extending this one mapping, not adding
checks or asset URLs to each Web view. Do not use the monochrome `BrandMark` CSS
mask for agent images: it discards their colors.

Reserve equal width and height. Use `alt=""` when adjacent text already names
the agent; otherwise provide its name. Standalone SVGs also include a descriptive
`title` and `aria-labelledby`. Prefer external images; repeated inline copies
would require unique per-instance IDs to prevent gradient/mask collisions.

Use 24–32 CSS pixels for session rows. Review at 20, 24, 32 and 48px and at a
larger inspection size. At 20px the small reel details are less distinct; do not
rely on those details alone to communicate the provider. Check the transparent
openings against the actual paper, canvas and navigation surfaces. A dark
surface requires its own review; current acceptance covers the light theme.

## Add another agent

1. Copy an existing SVG into `agents/<name>.svg` and rename its title, IDs and
   all local references. Keep the shared cartridge geometry and glow recipe.
2. Choose its recognizable base color and two lighter accents. Replace the
   central glyph with a simple identifying symbol, matching the current icons'
   optical weight and spacing. Keep the shell, reel dots and main symbol in the
   shared mask; document any identifying accent separately, as for Kimi Code.
3. Review alongside Codex and Claude Code at the sizes and surfaces above.
   Check small-symbol clarity, dot clearance, silhouette consistency and color.
4. Extend the entry and aliases in `src/agentIdentity.ts`, then add its asset link
   and palette row to this guide. Validate SVG XML and local
   references, run `pnpm check:docs` and `git diff --check`, and run
   `pnpm --filter @atape/web build` to confirm the asset reaches
   `apps/web/dist/agents/` unchanged.

The five SVGs are integrated into Project conversation rows, the Session reader
header (including child readers), global Search results, and Team Overview
conversation cards. Overview's chart classification also uses the shared identity
resolver, while retaining its existing categorical palette. Chart legends, exact
data tables and filter controls retain their current text presentation. Message
authors and authentication-provider UI are not agent identity fields.

The UI mapping is presentation metadata, not a second installation/capability
catalog. Adding assets or aliases here does not enable an Adapter. Publication,
deployment and additional provider artwork are separate work.
