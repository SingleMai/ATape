import type { User } from "@atape/domain"
import { Badge, Button, Eyebrow } from "@atape/ui"
import { useEffect, useState } from "react"
import type { ActionView } from "../presenters/accessPresenter"
import { AccessHeader, FailureNotice } from "./AccessPrimitives"

const Outcome = ({ outcome }: { readonly outcome: "approve" | "deny" | "expired" }) => {
  const copy = outcome === "approve"
    ? {
      eyebrow: "Authorization complete",
      mark: "✓",
      title: "The CLI is connected",
      body: "Return to your terminal to continue. This browser never receives or displays the CLI credential.",
      terminal: "Authorization approved. Finishing sign-in…"
    }
    : outcome === "deny"
      ? {
        eyebrow: "Request denied",
        mark: "×",
        title: "The CLI was not connected",
        body: "No credential was issued. You can close this page safely.",
        terminal: "Authorization denied by user."
      }
      : {
        eyebrow: "Request unavailable",
        mark: "!",
        title: "This code is no longer valid",
        body: "Return to your terminal and start sign-in again to get a new code.",
        terminal: "$ atape login"
      }
  return (
    <section className="cli-card cli-outcome" aria-labelledby="cli-outcome-title" role="status" aria-live="polite">
      <div className={`outcome-mark ${outcome === "approve" ? "" : "outcome-mark--danger"}`} aria-hidden="true">
        {copy.mark}
      </div>
      <Eyebrow>{copy.eyebrow}</Eyebrow>
      <h1 id="cli-outcome-title">{copy.title}</h1>
      <p>{copy.body}</p>
      <div className="terminal-note">{copy.terminal}</div>
    </section>
  )
}

export const CLIAuthorizationView = ({
  user,
  requestedCode,
  resolution,
  decision,
  onResolve,
  onDecide
}: {
  readonly user: User
  readonly requestedCode: string
  readonly resolution: ActionView<import("@atape/domain").CLIDeviceGrantView>
  readonly decision: ActionView<"approve" | "deny">
  readonly onResolve: (code: string) => void
  readonly onDecide: (grantViewId: string, decision: "approve" | "deny") => void
}) => {
  const [code, setCode] = useState(requestedCode)
  useEffect(() => setCode(requestedCode), [requestedCode])
  const resolved = resolution._tag === "Succeeded" ? resolution.value : undefined
  const decided = decision._tag === "Succeeded" ? decision.value : undefined
  const pending = decision._tag === "Pending"
  const requestedCodeUnavailable = requestedCode !== "" && resolution._tag === "Failed" &&
    (resolution.failure.code === "invalid_user_code" || resolution.failure.code === "expired_token")

  let content
  if (decided !== undefined) {
    content = <Outcome outcome={decided} />
  } else if (resolved?.status === "denied") {
    content = <Outcome outcome="deny" />
  } else if (resolved?.status === "claimed" || resolved?.status === "approved_unclaimed") {
    content = <Outcome outcome="approve" />
  } else if (resolved?.status === "expired" || requestedCodeUnavailable) {
    content = <Outcome outcome="expired" />
  } else if (resolution._tag === "Pending") {
    content = <section className="cli-card cli-loading" role="status">Opening the CLI request…</section>
  } else if (resolved !== undefined) {
    content = (
      <section className="cli-card" aria-labelledby="cli-title">
        <div className="cli-card-main">
          <div className="cli-title-row">
            <div>
              <Eyebrow>CLI authorization</Eyebrow>
              <h1 id="cli-title">Allow <code>{resolved.clientLabel}</code> to use your account?</h1>
            </div>
            <Badge tone="warning">Approval required</Badge>
          </div>
          <p className="muted-copy">Check that the code and instance match your terminal before continuing.</p>
          <div className="request-code">
            <span>Code shown in your terminal</span>
            <code>{resolved.userCode}</code>
          </div>
          <dl className="request-facts">
            <div><dt>ATape instance</dt><dd>{resolved.instanceOrigin}</dd></div>
            <div><dt>Signed in as</dt><dd>{user.displayName}</dd></div>
          </dl>
          <section className="permission-box" aria-labelledby="cli-permissions-title">
            <h2 id="cli-permissions-title">Requested access</h2>
            <p>{resolved.permissionSummary}</p>
            <small>It cannot manage Team members or account security.</small>
          </section>
          <p className="cli-warning"><strong>Didn’t start this?</strong> Deny the request. Never approve a code sent by someone else.</p>
          {decision._tag === "Failed" && <FailureNotice failure={decision.failure} />}
        </div>
        <footer className="cli-actions">
          <Button disabled={pending} onClick={() => onDecide(resolved.grantViewId, "deny")}>Deny</Button>
          <Button
            variant="primary"
            pending={pending}
            pendingLabel="Authorizing…"
            onClick={() => onDecide(resolved.grantViewId, "approve")}
          >
            Authorize CLI
          </Button>
        </footer>
      </section>
    )
  } else {
    content = (
      <section className="cli-card cli-code-entry" aria-labelledby="cli-code-title">
        <Eyebrow>CLI authorization</Eyebrow>
        <h1 id="cli-code-title">Enter the code from your terminal</h1>
        <p className="muted-copy">The code identifies a short-lived request. You will review it before anything is approved.</p>
        {resolution._tag === "Failed" && <FailureNotice failure={resolution.failure} />}
        <form onSubmit={(event) => {
          event.preventDefault()
          onResolve(code)
        }}>
          <label htmlFor="cli-user-code">CLI code</label>
          <input
            id="cli-user-code"
            className="cli-code-input"
            value={code}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            placeholder="Q7KM-4WDP"
            maxLength={9}
            required
            onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 9))}
          />
          <Button type="submit" variant="primary">Review request</Button>
        </form>
      </section>
    )
  }

  return (
    <div className="cli-page">
      <div className="cli-wrap">
        <AccessHeader displayName={user.displayName} />
        <main id="main-content">{content}</main>
      </div>
    </div>
  )
}
