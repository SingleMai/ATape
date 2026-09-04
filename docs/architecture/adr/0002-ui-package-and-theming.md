# ADR-0002: UI Package and Theming Boundary

- Status: Accepted
- Date: 2026-09-04

## Context

ATape's Cozy Island Workshop direction must remain easy to revise without coupling product Views to one palette, shape system, or styling tool. The first Web slice proved the visual direction with application-local CSS Variables, but that placed theme values, reusable primitives, and product layout in one file.

A utility-CSS framework can accelerate isolated page construction, but it does not by itself define the ownership boundary between themes, reusable components, and product composition. ATape needs that boundary before the number of screens and executables grows.

## Decision

The monorepo owns a presentation-only `@atape/ui` workspace package.

Its Interface consists of:

- semantic `--atape-*` CSS custom properties;
- independently authored theme token maps;
- foundation CSS for typography, focus, touch targets, and reduced motion;
- reusable pure React primitives with `atape-`-prefixed classes.

The initial theme Adapter is `cozy-island`. Applications select a theme at their Composition Root and import the complete UI stylesheet once. A new theme implements the same semantic token Interface instead of overriding product selectors.

Product-specific composition remains local to the presentation application. Project Memory cards, conversation events, Thread paths, and responsive page layout therefore do not become generic UI primitives merely because they have styles.

Tailwind and runtime CSS-in-JS are not part of the v0.1 foundation. This decision does not prohibit adopting a build-time styling tool later, provided `@atape/ui` remains the semantic Interface and product Views do not become coupled to theme-specific values.

## Consequences

- Palette, typography, radii, depth, and motion can change through a theme token map.
- Web, future CLI-rendered Web surfaces, and component previews can share one visual contract.
- CSS layers keep foundation and primitive styles intentionally weaker than application-local composition.
- Component variants are tested through the same React Interface callers use.
- Product CSS still exists, but it consumes semantic tokens and no longer owns reusable primitive styling.

## Rejected alternatives

- **Keep one application stylesheet**: simplest initially, but theme and reusable-component ownership become progressively ambiguous.
- **Tailwind as the design-system Interface**: useful as an implementation tool, but utility classes are not the semantic theme contract ATape needs.
- **Runtime CSS-in-JS theme provider**: adds runtime work and framework coupling where native CSS custom properties already satisfy the requirement.
