import { readSessionAnalytics } from "@atape/application"
import { Effect } from "effect"
import { BrowserSessionAnalyticsGatewayLayer } from "../src/runtime/sessionAnalyticsGateway"

// Browser-only test entry: run the same application Interface and production
// Browser Adapter as the reader, with this Vite server's configured API origin.
export const readAnalyticsAcrossOrigins = () => Effect.runPromise(
  readSessionAnalytics("session-reader").pipe(Effect.provide(BrowserSessionAnalyticsGatewayLayer)))
