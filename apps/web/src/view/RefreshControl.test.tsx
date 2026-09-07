import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { RefreshControl } from "./RefreshControl.tsx"

describe("RefreshControl", () => {
  it("defaults to a visible manual refresh control with automatic refresh off", () => {
    const html = renderToStaticMarkup(
      <RefreshControl
        settings={{ cadence: "manual", setCadence: () => undefined }}
        refreshing={false}
        status="Updated just now"
        onRefresh={() => undefined}
      />
    )

    expect(html).toContain("Refresh controls")
    expect(html).toContain(">Refresh</span>")
    expect(html).toContain("Automatic refresh interval")
    expect(html).toContain('<option value="manual" selected="">Off</option>')
    expect(html).toContain("Every 30 sec")
    expect(html).toContain("Updated just now")
  })

  it("keeps the previous snapshot visible when a refresh fails", () => {
    const html = renderToStaticMarkup(
      <RefreshControl
        settings={{ cadence: "1_minute", setCadence: () => undefined }}
        refreshing={false}
        refreshFailure="Service unavailable"
        status="Updated earlier"
        onRefresh={() => undefined}
      />
    )

    expect(html).toContain('<option value="1_minute" selected="">Every minute</option>')
    expect(html).toContain("Refresh failed · showing previous data")
    expect(html).toContain('title="Service unavailable"')
    expect(html).not.toContain("Updated earlier")
  })

  it("signals background work without changing the refresh label", () => {
    const html = renderToStaticMarkup(
      <RefreshControl
        settings={{ cadence: "manual", setCadence: () => undefined }}
        refreshing
        status="Updated just now"
        onRefresh={() => undefined}
      />
    )

    expect(html).toContain('aria-busy="true"')
    expect(html).toContain("disabled")
    expect(html).toContain(">Refresh</span>")
  })
})
