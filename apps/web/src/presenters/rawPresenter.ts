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
import type { LoadableView } from "./memoryPresenter"

export type RawTextPage = {
  readonly page: RawContentPage
  readonly text: string
}

const runtime = Atom.runtime(BrowserRawGatewayLayer)
const archiveAtoms = Atom.family((sessionId: string) => runtime.atom(listSessionRaw(sessionId)))
const contentAtoms = Atom.family((objectId: string) =>
  Atom.family((generation: number) =>
    Atom.family((cursor: string) => runtime.atom(
      readRawContent({ objectId, generation, ...(cursor ? { cursor } : {}) }).pipe(
        Effect.flatMap(decodeTextPage)
      )
    ))
  )
)

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
  defectMessage: string
): LoadableView<A> => AsyncResult.matchWithError(result, {
  onInitial: () => ({ _tag: "Loading" as const }),
  onError: (error) => ({
    _tag: "Failed" as const,
    message: error.message,
    retryable: error.reason !== "decode"
  }),
  onDefect: () => ({ _tag: "Failed" as const, message: defectMessage, retryable: false }),
  onSuccess: (success) => ({
    _tag: "Ready" as const,
    value: success.value,
    refreshing: success.waiting
  })
})

export const useSessionRawPresenter = (sessionId: string): {
  readonly state: LoadableView<SessionRawArchive>
  readonly reload: () => void
} => {
  const atom = archiveAtoms(sessionId)
  return {
    state: toLoadable(useAtomValue(atom), "ATape could not render the Raw manifest safely."),
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
  const atom = contentAtoms(objectId)(generation)(cursor)
  return {
    state: toLoadable(useAtomValue(atom), "ATape could not render the Raw content safely."),
    reload: useAtomRefresh(atom)
  }
}
