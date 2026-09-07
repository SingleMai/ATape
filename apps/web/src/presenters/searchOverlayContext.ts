import { createContext, useContext } from "react"

export type SearchSeed = { readonly query: string; readonly projectId: string }
export const SearchOverlayContext = createContext<{
  readonly hasSearch: boolean
  readonly openSearch: (seed?: SearchSeed) => void
}>({ hasSearch: false, openSearch: () => undefined })
export const useSearchOverlay = () => useContext(SearchOverlayContext)
