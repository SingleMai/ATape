import { Data, Effect } from "effect"

class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly cause: unknown
}> {}

export const writeClipboard = (text: string) => Effect.tryPromise({
  try: () => navigator.clipboard.writeText(text),
  catch: (cause) => new ClipboardError({ cause })
})
