import { describe, expect, it } from "vitest"
import { CLIExperienceError, describeClientFailure, ProjectSetupError, ProjectSetupGatewayError } from "./index.ts"

describe("Client failure recovery", () => {
  it("keeps account recovery bound to the Project's Instance", () => {
    expect(describeClientFailure(new CLIExperienceError({ reason: "changed", message: "Account changed", instanceOrigin: "https://team.example" })))
      .toEqual({ message: "Account changed", actions: [{ kind: "sign_in", instanceOrigin: "https://team.example" }, { kind: "retry" }] })
  })

  it("offers review for a stale setup and the current Instance for an expired gateway credential", () => {
    expect(describeClientFailure(new ProjectSetupError({ reason: "changed", message: "Directory changed" })).actions)
      .toEqual([{ kind: "review" }])
    expect(describeClientFailure(new ProjectSetupGatewayError({ reason: "unauthenticated", message: "Sign in" })).actions)
      .toEqual([{ kind: "sign_in" }, { kind: "retry" }])
  })

  it("offers an update only for an identified incompatible tool", () => {
    expect(describeClientFailure(new CLIExperienceError({ reason: "upgrade", message: "Upgrade reader", adapterId: "opencode" })).actions)
      .toEqual([{ kind: "update_tool", adapterId: "opencode" }, { kind: "retry" }])
    expect(describeClientFailure(new CLIExperienceError({ reason: "upgrade", message: "Upgrade reader" })).actions)
      .toEqual([{ kind: "retry" }])
  })

  it("does not derive account or package actions from unrecognized error fields", () => {
    const error = Object.assign(new Error("Unexpected failure"), { reason: "changed", instanceOrigin: "https://unrelated.example" })
    expect(describeClientFailure(error)).toEqual({ message: "Unexpected failure", actions: [{ kind: "retry" }] })
  })
})
