# @atape/ui

ATape's presentation-only style Module. It owns the semantic design-token contract, themes, foundation CSS, and reusable React primitives. It contains no product workflows, remote state, routing, or persistence.

## Use

Import the complete default system once at the application Composition Root:

```ts
import "@atape/ui/styles.css"
```

Then consume primitives from the package Interface:

```tsx
import { Avatar, Badge, Button, Eyebrow } from "@atape/ui"
```

## Themes

The default theme is `cozy-island`. Its semantic token map lives in `src/styles/themes/cozy-island.css` and is applied to `:root` as well as `[data-atape-theme="cozy-island"]`.

A future theme should provide the same `--atape-*` token Interface. It must not override product selectors or duplicate page layouts. Theme selection belongs to an application Composition Root; product Views should continue to consume semantic tokens and primitives unchanged.

## Boundary

- This package owns visual primitives and their states.
- `apps/web` owns product composition such as Project Memory cards and the Session Reader stream.
- Effect-backed Presenters own workflows and remote state; UI primitives remain pure React.
