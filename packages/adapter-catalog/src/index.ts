// Official product metadata, independent of installed package capabilities.
export const officialSources = [
  { id: "codex", label: "Codex", packageName: "@atape/adapter-codex" },
  { id: "claude", label: "Claude Code", packageName: "@atape/adapter-claude" },
  { id: "codebuddy", label: "CodeBuddy Code CLI", packageName: "@atape/adapter-codebuddy" },
  { id: "opencode", label: "OpenCode", packageName: "@atape/adapter-opencode" }
] as const

export const officialSourceLabel = (id: string) => officialSources.find(source => source.id === id)?.label ?? id
