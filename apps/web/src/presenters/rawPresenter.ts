import {
  listSessionRaw,
  RawGatewayError,
  readRawContent,
  type RawGatewayError as RawGatewayFailure
} from "@atape/application"
import type { RawContentPage, SessionRawArchive } from "@atape/domain"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Effect } from "effect"
import { AsyncResult, Atom } from "effect/unstable/reactivity"
import { BrowserRawGatewayLayer } from "../runtime/rawGateway"
import { gatewayFailureMessageKey, type LoadableView } from "./memoryPresenter"
import type { WebMessageKey } from "../i18n"

export type RawTextPage = {
  readonly page: RawContentPage
  readonly text: string
}

const runtime = Atom.runtime(BrowserRawGatewayLayer)
// Keep the complete read key in one family. Nested weak families can disappear
// under large-page GC pressure while the leaf atom is still mounted, restarting
// the request on every subsequent render (the conversation reader uses this too).
const archiveAtoms = Atom.family((key: string) => {
  const [sessionId, cursor] = JSON.parse(key) as [string, string]
  return runtime.atom(listSessionRaw(sessionId, cursor))
})
const contentAtoms = Atom.family((key: string) => {
  const [objectId, generation, cursor] = JSON.parse(key) as [string, number, string]
  return runtime.atom(readRawContent({ objectId, generation, cursor }).pipe(Effect.flatMap(decodeTextPage)))
})

const decodeTextPage = (page: RawContentPage): Effect.Effect<RawTextPage, RawGatewayFailure> =>
  Effect.try({
    try: () => {
      const decoder = new TextDecoder()
      const parts = page.chunks.map((chunk) => {
        const binary = window.atob(chunk.contentBase64)
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
        return decoder.decode(bytes)
      })
      return { page, text: parts.join("") }
    },
    catch: () => new RawGatewayError({
      reason: "decode",
      message: "The Raw content could not be decoded safely."
    })
  })

const toLoadable = <A>(
  result: AsyncResult.AsyncResult<A, RawGatewayFailure>,
  defectMessageKey: WebMessageKey
): LoadableView<A> => AsyncResult.matchWithError(result, {
  onInitial: () => ({ _tag: "Loading" as const }),
  onError: (error) => ({
    _tag: "Failed" as const,
    messageKey: gatewayFailureMessageKey(error.reason, error.status),
    retryable: error.reason !== "decode"
  }),
  onDefect: () => ({ _tag: "Failed" as const, messageKey: defectMessageKey, retryable: false }),
  onSuccess: (success) => ({
    _tag: "Ready" as const,
    value: success.value,
    refreshing: success.waiting
  })
})

export const useSessionRawPresenter = (sessionId: string, cursor: string): {
  readonly state: LoadableView<SessionRawArchive>
  readonly reload: () => void
} => {
  const atom = archiveAtoms(JSON.stringify([sessionId, cursor]))
  return {
    state: toLoadable(useAtomValue(atom), "errors.defect.rawManifest"),
    reload: useAtomRefresh(atom)
  }
}

export const useRawContentPresenter = (
  objectId: string,
  generation: number,
  cursor: string
): {
  readonly state: LoadableView<RawTextPage>
  readonly reload: () => void
} => {
  const atom = contentAtoms(JSON.stringify([objectId, generation, cursor]))
  return {
    state: toLoadable(useAtomValue(atom), "errors.defect.rawContent"),
    reload: useAtomRefresh(atom)
  }
}
