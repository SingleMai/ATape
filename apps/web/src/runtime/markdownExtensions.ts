import { Data, Effect } from "effect"
import type { Options } from "react-markdown"

class MarkdownExtensionError extends Data.TaggedError("MarkdownExtensionError")<{
  readonly cause: unknown
}> {}

export type MarkdownPlugins = Pick<Options, "remarkPlugins" | "rehypePlugins">

export const loadMarkdownPlugins = (gfm: boolean, highlight: boolean) => Effect.tryPromise({
  try: async (): Promise<MarkdownPlugins> => {
    const [grammar, highlighter] = await Promise.all([
      gfm ? import("remark-gfm") : undefined,
      highlight ? import("rehype-highlight") : undefined
    ])
    return {
      remarkPlugins: grammar ? [grammar.default] : [],
      rehypePlugins: highlighter ? [[highlighter.default, { detect: false }]] : []
    }
  },
  catch: (cause) => new MarkdownExtensionError({ cause })
})

let diagramSequence = 0
let mermaidModule: Promise<typeof import("mermaid")> | undefined

export const renderMermaid = (text: string) => Effect.tryPromise({
  try: async () => {
    mermaidModule ??= import("mermaid").then((module) => {
      module.default.initialize({
        startOnLoad: false,
        securityLevel: "sandbox",
        suppressErrorRendering: true,
        maxTextSize: 50_000
      })
      return module
    }).catch((error) => {
      mermaidModule = undefined
      throw error
    })
    const { default: mermaid } = await mermaidModule
    const container = document.createElement("div")
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:1000px;visibility:hidden"
    document.body.append(container)
    try {
      const result = await mermaid.render(`atape-mermaid-${++diagramSequence}`, text, container)
      return result.svg.replace(/<iframe\b/, '<iframe title="Mermaid diagram"')
    } finally {
      container.remove()
    }
  },
  catch: (cause) => new MarkdownExtensionError({ cause })
})
