import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AgentIdentity, resolveAgentIdentity } from "./index"

describe("agent identity Interface", () => {
  it.each([
    [" Codex ", "codex", "Codex", "/agents/codex.svg"],
    ["CLAUDE_CODE", "claude", "Claude Code", "/agents/claude-code.svg"],
    ["codebuddy-code", "codebuddy", "WorkBuddy", "/agents/workbuddy.svg"],
    ["CodeBuddy Code CLI", "codebuddy", "WorkBuddy", "/agents/workbuddy.svg"],
    ["WorkBuddy", "codebuddy", "WorkBuddy", "/agents/workbuddy.svg"],
    ["grok-build", "grok", "Grok", "/agents/grok.svg"],
    ["Kimi Code CLI", "kimi", "Kimi Code", "/agents/kimi-code.svg"],
    ["kimi-code", "kimi", "Kimi Code", "/agents/kimi-code.svg"],
    ["OpenCode", "opencode", "OpenCode", undefined]
  ])("resolves %s without changing the underlying provider identity", (input, id, label, iconSrc) => {
    expect(resolveAgentIdentity(input!)).toEqual({ id, label, iconSrc })
  })

  it.each(["Codex Helper", "my-claude-proxy", "../../other.svg", "Private Agent", "constructor"])(
    "keeps unknown %s readable without guessing a provider or constructing an image URL", (provider) => {
      expect(resolveAgentIdentity(provider)).toEqual({ id: undefined, label: provider, iconSrc: undefined })
      const html = renderToStaticMarkup(<AgentIdentity provider={provider} iconOnly />)
      expect(html).toContain(provider)
      expect(html).not.toContain("<img")
    })

  it("renders an accessible icon alone or a decorative icon beside its label", () => {
    const withLabel = renderToStaticMarkup(<AgentIdentity provider="codebuddy-code" />)
    expect(withLabel).toContain('src="/agents/workbuddy.svg"')
    expect(withLabel).toContain('alt=""')
    expect(withLabel).toContain('<span>WorkBuddy</span>')
    const icon = renderToStaticMarkup(<AgentIdentity provider="codebuddy-code" size={32} iconOnly />)
    expect(icon).toContain('alt="WorkBuddy"')
    expect(icon).toContain('width="32" height="32"')
    expect(icon).toContain('title="WorkBuddy"')
  })

  it("retains text for known agents without artwork and a neutral placeholder for empty input", () => {
    expect(renderToStaticMarkup(<AgentIdentity provider="open-code" iconOnly />)).toContain('<span>OpenCode</span>')
    expect(renderToStaticMarkup(<AgentIdentity provider="  " iconOnly />)).toContain('<span>—</span>')
  })
})
