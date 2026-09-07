import { Effect, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import { writeClipboard } from "../runtime/clipboard"

export const useCodeCopy = (text: string) => {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle")
  const pending = useRef<Fiber.Fiber<void, never> | undefined>(undefined)

  useEffect(() => {
    setStatus("idle")
    return () => {
      if (pending.current) Effect.runFork(Fiber.interrupt(pending.current))
      pending.current = undefined
    }
  }, [text])

  const copy = () => {
    if (pending.current) Effect.runFork(Fiber.interrupt(pending.current))
    setStatus("copying")
    pending.current = Effect.runFork(writeClipboard(text).pipe(
      Effect.match({
        onFailure: () => setStatus("failed"),
        onSuccess: () => setStatus("copied")
      })
    ))
  }

  return { status, copy }
}
