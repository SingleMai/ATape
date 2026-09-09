# Team Overview visual contract

Accepted 2026-09-10. Product requirements: [Team Overview](../../../docs/team-overview.md).

This page explicitly overrides the master's original avoidance of an analytics
dashboard for this Team management surface. It keeps the shared Cozy Island
tokens, typography, accessible contrast, icon discipline and reading conventions.
Project Activity and Session Reader remain conversation-first surfaces.

- Continuous six-metric strip rather than six heavily decorated cards.
- One full-width usage chart, then compact recent conversations.
- Input/output/cache-read/cache-write Token amounts are visible together.
- Chart categories have textual legends and exact accessible values; color alone
  does not communicate identity. Prefer ordinary bars over decorative striped bars.
- Agent categories use the theme's categorical chart tokens: teal for Codex,
  coral for Claude, neutral for other Agents. Stronger edges preserve pale-fill
  visibility; legends and conversation icons share the mapping. State colors
  such as danger are reserved for actual state feedback.
- Compact previews show latest input and last output sentence. Desktop uses a
  two-column grid in row reading order; narrow screens use one column.
- Preserve a readable body size, tabular numerals, aligned labels, ample chart
  area, visible keyboard focus and clear missing-data states.
- Use existing semantic theme tokens and independently authored consistent vector
  icons. The user reference supplies layout ideas, not copied assets or colors.
