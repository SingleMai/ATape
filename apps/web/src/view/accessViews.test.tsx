import type { CLIDeviceGrantView, SignInOptions, User } from "@atape/domain"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { ActionView, LoadView, TeamAccess } from "../presenters/accessPresenter.ts"
import { CLIAuthorizationView } from "./CLIAuthorizationView.tsx"
import { SignInView } from "./SignInView.tsx"
import { TeamAccessView } from "./SecuritySettingsView.tsx"

const user: User = { id: "user-1", displayName: "Mai", avatarUrl: "" }
const idle = { _tag: "Idle" } as const
const options: LoadView<SignInOptions> = {
  _tag: "Ready",
  refreshing: false,
  value: {
    instance: {
      protocol: "atape.instance.v1",
      instanceOrigin: "https://atape.dev",
      webOrigin: "https://atape.dev",
      apiOrigin: "https://api.atape.dev",
      protocols: ["atape.cli-authorization.v1"],
      releaseVersion: "0.2.0",
      authEpoch: "auth-v1",
      minimumCliVersion: "0.2.0"
    },
    providers: [{ id: "provider-registration-a", label: "GitHub" }]
  }
}

const grant: CLIDeviceGrantView = {
  grantViewId: "private-grant-view-id",
  userCode: "Q7KM4W",
  instanceOrigin: "https://atape.dev",
  clientLabel: "atape-cli",
  capabilityVersion: "atape-cli.v1",
  permissionSummary: "Read and sync this account's ATape projects.",
  expiresAt: "2026-09-05T00:15:00Z",
  status: "pending"
}

describe("access views", () => {
  it("keeps ordinary sign-in minimal and renders Provider data generically", () => {
    const html = renderToStaticMarkup(<SignInView
      options={options}
      action={idle}
      cliReturn={false}
      onRetry={() => undefined}
      onSignIn={() => undefined}
    />)

    expect(html).toContain("Sign in to ATape")
    expect(html).toContain("Continue with GitHub")
    expect(html).toContain("https://atape.dev")
    expect(html).not.toContain("provider-registration-a")
    expect(html).not.toContain("Team permissions")
    expect(html).not.toContain("OAuth")
  })

  it("shows a review before CLI approval without rendering internal or secret values", () => {
    const html = renderToStaticMarkup(<CLIAuthorizationView
      user={user}
      requestedCode="Q7KM4W"
      resolution={{ _tag: "Succeeded", value: grant }}
      decision={idle}
      onResolve={() => undefined}
      onDecide={() => undefined}
    />)

    expect(html).toContain("Q7KM4W")
    expect(html).toContain("https://atape.dev")
    expect(html).toContain("Signed in as")
    expect(html).toContain("Authorize CLI")
    expect(html).toContain("Deny")
    expect(html).not.toContain("private-grant-view-id")
    expect(html).not.toContain("device_code")
    expect(html).not.toContain("credential-secret")
  })

  it("renders approved and expired CLI terminal states without another approval control", () => {
    const approved = renderToStaticMarkup(<CLIAuthorizationView
      user={user}
      requestedCode="Q7KM4W"
      resolution={{ _tag: "Succeeded", value: { ...grant, status: "approved_unclaimed" } }}
      decision={idle}
      onResolve={() => undefined}
      onDecide={() => undefined}
    />)
    expect(approved).toContain("The CLI is connected")
    expect(approved).not.toContain("Authorize CLI")

    const expired = renderToStaticMarkup(<CLIAuthorizationView
      user={user}
      requestedCode="Q7KM4W"
      resolution={{
        _tag: "Failed",
        failure: {
          message: "The code is unavailable.",
          code: "invalid_user_code",
          reason: "invalid_input",
          retryable: false
        }
      }}
      decision={idle}
      onResolve={() => undefined}
      onDecide={() => undefined}
    />)
    expect(expired).toContain("This code is no longer valid")
    expect(expired).not.toContain("Authorize CLI")
  })

  it("keeps owner-only Team controls out of a Member view", () => {
    const memberAccess: TeamAccess = {
      team: {
        id: "team-id",
        slug: "team-a",
        displayName: "Team A",
        membership: { role: "member" },
        createdAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z"
      },
      members: [{
        userId: user.id,
        displayName: user.displayName,
        avatarUrl: "",
        role: "member",
        joinedAt: "2026-09-05T00:00:00Z",
        updatedAt: "2026-09-05T00:00:00Z"
      }]
    }
    const state: LoadView<TeamAccess> = { _tag: "Ready", value: memberAccess, refreshing: false }
    const action: ActionView<void> = idle
    const html = renderToStaticMarkup(<TeamAccessView
      user={user}
      state={state}
      action={action}
      onRetry={() => undefined}
      onAction={() => undefined}
      onReauthenticate={() => undefined}
      onSignOut={() => undefined}
    />)

    expect(html).toContain("Team &amp; access")
    expect(html).toContain("Leave Team")
    expect(html).not.toContain("Team join code")
    expect(html).not.toContain("Make Owner")
    expect(html).not.toContain("Remove member")
  })
})
