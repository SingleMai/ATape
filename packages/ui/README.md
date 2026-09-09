# @atape/ui

ATape's presentation-only style Module. It owns the semantic design-token contract, themes, foundation CSS, and reusable React primitives. It contains no product workflows, remote state, routing, or persistence.

## Use

Import the complete default system once at the application Composition Root:

```ts
import "@atape/ui/styles.css"
```

Then consume primitives from the package Interface:

```tsx
import { Avatar, Badge, BrandMark, Button, Eyebrow } from "@atape/ui"
```

## Themes

The default theme is `cozy-island`. Its semantic token map lives in `src/styles/themes/cozy-island.css` and is applied to `:root` as well as `[data-atape-theme="cozy-island"]`.

A future theme should provide the same `--atape-*` token Interface. It must not override product selectors or duplicate page layouts. Theme selection belongs to an application Composition Root; product Views should continue to consume semantic tokens and primitives unchanged.

Categorical charts use `--atape-color-chart-1`, `--atape-color-chart-2`, their
`-strong` variants for edges/hover/icon strokes, and `--atape-color-chart-neutral`
for unclassified series. Cozy Island maps these to teal and coral from its island
palette. Keep success, warning and danger tokens for state meaning. Pale chart
fills need the stronger outline; legend text continues to use content tokens.

### Brand assets

Keep theme assets beside their stylesheet, in the matching theme directory:

```text
src/styles/themes/
  cozy-island.css
  cozy-island/
    brand-mark.svg
```

To replace the logo, edit `src/styles/themes/cozy-island/brand-mark.svg`. Keep its background and openings transparent and crop its `viewBox` to the artwork. The theme selects the asset with `--atape-brand-mark-image`, its width-to-height ratio with `--atape-brand-mark-aspect-ratio`, and its color with `--atape-color-brand`. Update the ratio when the replacement artwork has different proportions. Relative asset URLs are resolved by the application bundler.

The current mark is a square, single-reel tape cartridge with a small safe margin. Its central hub intentionally carries no provider symbol: ATape collects conversations from every Agent. The theme supplies ATape's yellow; provider-specific concept studies remain outside the production assets.

The Web HTML entry also uses this SVG as its favicon. Its default `color` supplies the yellow when loaded directly by a browser tab, while the component's CSS mask uses `--atape-color-brand`. Keep those colors aligned when changing the theme palette. The Web Vite configuration selects the theme's asset directory as its public directory, serving `/brand-mark.svg` in development and copying it into the production build. Keep this directory limited to browser-facing assets. No second logo drawing is maintained.

`BrandMark` renders the SVG as a monochrome CSS mask. Views only set its displayed width and placement; the theme owns the artwork and color. The mark is decorative, so its containing link must provide the brand name through visible text or an accessible label. Multicolor artwork would need a different rendering implementation.

The next visual increment is provider-specific conversation icons, using the approved cartridge direction after small-size review. Those icons should keep provider identity separate from the universal site mark.

## Boundary

- This package owns visual primitives and their states.
- `apps/web` owns product composition such as Project Memory cards and the Session Reader stream.
- Effect-backed Presenters own workflows and remote state; UI primitives remain pure React.
