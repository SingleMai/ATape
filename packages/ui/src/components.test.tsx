import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Avatar, Badge, Button, Eyebrow } from "./components"

describe("ATape UI Interface", () => {
  it("renders semantic variants without leaking product behavior", () => {
    const output = renderToStaticMarkup(
      <div>
        <Button variant="ghost">Back</Button>
        <Badge tone="success">Active</Badge>
        <Avatar name="Liying Chen" />
        <Eyebrow>Project memory</Eyebrow>
      </div>
    )

    expect(output).toContain("atape-button--ghost")
    expect(output).toContain("atape-badge--success")
    expect(output).toContain(">LC</span>")
    expect(output).toContain("atape-eyebrow")
  })

  it("prevents duplicate actions while pending", () => {
    const output = renderToStaticMarkup(<Button pending pendingLabel="Saving…">Save</Button>)

    expect(output).toContain("aria-busy=\"true\"")
    expect(output).toContain("disabled=\"\"")
    expect(output).toContain("Saving…")
  })
})
