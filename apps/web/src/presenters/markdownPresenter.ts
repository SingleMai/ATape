import { Effect, Fiber } from "effect"
import { useEffect, useState } from "react"
import { loadMarkdownPlugins, renderMermaid, type MarkdownPlugins } from "../runtime/markdownExtensions"

export const useMarkdownPlugins = (text: string) => {
  // Conservative checks: false positives cost a download; false negatives hide formatting.
  const gfm = /\||~|\[[ xX]\]|\[\^|(?:https?:\/\/|www\.)|\S@\S/.test(text)
  const highlight = [...text.matchAll(/(?:`{3,}|~{3,})[ \t]*(\S+)/g)]
    .some(([, language]) => !["mermaid", "text", "txt", "plaintext"].includes(language!))
  const [plugins, setPlugins] = useState<MarkdownPlugins>({})

  useEffect(() => {
    if (!gfm && !highlight) return
    const fiber = Effect.runFork(loadMarkdownPlugins(gfm, highlight).pipe(
      Effect.match({ onFailure: () => undefined, onSuccess: setPlugins })
    ))
    return () => { Effect.runFork(Fiber.interrupt(fiber)) }
  }, [gfm, highlight])

  return plugins
}

type DiagramState =
  | { readonly text: string; readonly status: "ready"; readonly html: string }
  | { readonly text: string; readonly status: "failed" }

export const useMermaid = (text: string, enabled: boolean) => {
  const [state, setState] = useState<DiagramState>()
  useEffect(() => {
    if (!enabled) return
    const fiber = Effect.runFork(renderMermaid(text).pipe(
      Effect.match({
        onFailure: () => setState({ text, status: "failed" }),
        onSuccess: (html) => setState({ text, status: "ready", html })
      })
    ))
    return () => { Effect.runFork(Fiber.interrupt(fiber)) }
  }, [text, enabled])
  return state?.text === text ? state : undefined
}
