export type AgentIdentityInfo = {
  readonly id: string | undefined
  readonly label: string
  readonly iconSrc: string | undefined
}

// Presentation metadata only. Adapter installation and capture capabilities
// remain owned by the official source catalog and provider Adapters.
const agents = [
  { id: "codex", label: "Codex", iconSrc: "/agents/codex.svg",
    aliases: ["codex", "codex-cli"] },
  { id: "claude", label: "Claude Code", iconSrc: "/agents/claude-code.svg",
    aliases: ["claude", "claude-code", "claude-code-cli"] },
  { id: "codebuddy", label: "WorkBuddy", iconSrc: "/agents/workbuddy.svg",
    aliases: ["codebuddy", "codebuddy-code", "codebuddy-code-cli", "codebuddy-cli", "workbuddy", "work-buddy"] },
  { id: "grok", label: "Grok", iconSrc: "/agents/grok.svg",
    aliases: ["grok", "grok-build"] },
  { id: "kimi", label: "Kimi Code", iconSrc: "/agents/kimi-code.svg",
    aliases: ["kimi", "kimi-code", "kimi-code-cli", "kimi-cli"] },
  { id: "opencode", label: "OpenCode", iconSrc: undefined,
    aliases: ["opencode", "open-code"] }
] as const

const byAlias = new Map<string, AgentIdentityInfo>(agents.flatMap(({ aliases, ...identity }) =>
  aliases.map(alias => [alias, identity] as const)))

/** Resolves exact known names; unknown values remain readable and never form asset URLs. */
export const resolveAgentIdentity = (provider: string): AgentIdentityInfo => {
  const label = provider.trim()
  const key = label.toLowerCase().replace(/[\s_]+/g, "-")
  return byAlias.get(key) ?? { id: undefined, label, iconSrc: undefined }
}
