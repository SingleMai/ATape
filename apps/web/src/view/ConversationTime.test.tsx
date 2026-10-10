import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { initializeWebI18n } from "../i18n"
import { ConversationTime, formatConversationTime } from "./ConversationTime"

afterEach(() => initializeWebI18n("en"))

describe("ConversationTime", () => {
  it.each([
    ["en", "Time unknown"],
    ["zh-CN", "时间未知"]
  ] as const)("labels missing time in %s without inventing a machine-readable date", (locale, label) => {
    initializeWebI18n(locale)
    expect(formatConversationTime(null)).toBe(label)
    expect(renderToStaticMarkup(<ConversationTime value={null} relative />))
      .toBe(`<span class="conversation-time">${label}</span>`)
  })

  it("retains the supplied known time and its absolute tooltip in relative displays", () => {
    const value = "2026-09-07T00:01:00Z"
    const html = renderToStaticMarkup(<ConversationTime value={value} relative />)
    expect(html).toContain(`dateTime="${value}"`)
    expect(html).toContain("title=")
    expect(html).not.toContain("Time unknown")
  })
})
