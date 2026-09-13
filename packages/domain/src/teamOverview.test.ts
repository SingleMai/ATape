import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { OverviewOption, overviewMemberDetails } from "./teamOverview"

describe("Overview options", () => {
  const member = { id: "active", name: "Active member", current: true }
  const tokens = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110, records: 1, sessions: 1 }
  const activity = { ...member, sessions: 1, projects: 1, tokens }

  it("accepts compact and legacy choices without retaining unused counters", () => {
    const decode = Schema.decodeUnknownSync(OverviewOption)
    expect(decode(member)).toEqual(member)
    expect(decode(activity)).toEqual(member)
  })

  it("preserves current members with no activity and unknown usage", () => {
    const inactive = { id: "inactive", name: "No activity", current: true }
    const former = { id: "former", name: "Former member", current: false }
    const rows = overviewMemberDetails({
      options: { projects: [], members: [inactive, member, former], agents: [], models: [] },
      members: [activity, { ...activity, ...former }]
    })
    expect(rows).toEqual([
      { ...inactive, sessions: 0, projects: 0, tokens: { input: null, output: null, cacheRead: null, cacheWrite: null, total: null, records: 0, sessions: 0 } },
      activity
    ])
  })
})
