import type { User } from "@atape/domain"
import { Badge, Button, Eyebrow } from "@atape/ui"
import { useEffect, useState } from "react"
import type { ActionView } from "../presenters/accessPresenter"
import { AccessHeader, FailureNotice } from "./AccessPrimitives"
import { t, type WebMessageKey } from "../i18n"

const Outcome = ({ outcome }: { readonly outcome: "approve" | "deny" | "expired" }) => {
  const copy: { readonly eyebrowKey: WebMessageKey; readonly mark: string; readonly titleKey: WebMessageKey; readonly bodyKey: WebMessageKey; readonly terminalKey: WebMessageKey } = outcome === "approve"
    ? {
      eyebrowKey: "cli.approveEyebrow",
      mark: "✓",
      titleKey: "cli.approveTitle",
      bodyKey: "cli.approveBody",
      terminalKey: "cli.approveTerminal"
    }
    : outcome === "deny"
      ? {
        eyebrowKey: "cli.denyEyebrow",
        mark: "×",
        titleKey: "cli.denyTitle",
        bodyKey: "cli.denyBody",
        terminalKey: "cli.denyTerminal"
      }
      : {
        eyebrowKey: "cli.expiredEyebrow",
        mark: "!",
        titleKey: "cli.expiredTitle",
        bodyKey: "cli.expiredBody",
        terminalKey: "cli.expiredTerminal"
      }
  return (
    <section className="cli-card cli-outcome" aria-labelledby="cli-outcome-title" role="status" aria-live="polite">
      <div className={`outcome-mark ${outcome === "approve" ? "" : "outcome-mark--danger"}`} aria-hidden="true">
        {copy.mark}
      </div>
      <Eyebrow>{t(copy.eyebrowKey)}</Eyebrow>
      <h1 id="cli-outcome-title">{t(copy.titleKey)}</h1>
      <p>{t(copy.bodyKey)}</p>
      <div className="terminal-note">{t(copy.terminalKey)}</div>
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
    content = <section className="cli-card cli-loading" role="status">{t("cli.opening", "Opening the CLI request…")}</section>
  } else if (resolved !== undefined) {
    content = (
      <section className="cli-card" aria-labelledby="cli-title">
        <div className="cli-card-main">
          <div className="cli-title-row">
            <div>
              <Eyebrow>{t("cli.authorization", "CLI authorization")}</Eyebrow>
              <h1 id="cli-title">{t("cli.allowPrefix", "Allow")} <code>{resolved.clientLabel}</code> {t("cli.allowSuffix", "to use your account?")}</h1>
            </div>
            <Badge tone="warning">{t("cli.approvalRequired", "Approval required")}</Badge>
          </div>
          <p className="muted-copy">{t("cli.checkCode", "Check that the code and instance match your terminal before continuing.")}</p>
          <div className="request-code">
            <span>{t("cli.codeShown", "Code shown in your terminal")}</span>
            <code>{resolved.userCode}</code>
          </div>
          <dl className="request-facts">
            <div><dt>{t("cli.instance", "ATape instance")}</dt><dd>{resolved.instanceOrigin}</dd></div>
            <div><dt>{t("cli.signedInAs", "Signed in as")}</dt><dd>{user.displayName}</dd></div>
          </dl>
          <section className="permission-box" aria-labelledby="cli-permissions-title">
            <h2 id="cli-permissions-title">{t("cli.requestedAccess", "Requested access")}</h2>
            <p>{resolved.permissionSummary}</p>
            <small>{t("cli.permissionNote", "It cannot manage Team members or account security.")}</small>
          </section>
          <p className="cli-warning"><strong>{t("cli.warningStrong", "Didn’t start this?")}</strong> {t("cli.warningBody", "Deny the request. Never approve a code sent by someone else.")}</p>
          {decision._tag === "Failed" && <FailureNotice failure={decision.failure} />}
        </div>
        <footer className="cli-actions">
          <Button disabled={pending} onClick={() => onDecide(resolved.grantViewId, "deny")}>{t("cli.deny", "Deny")}</Button>
          <Button
            variant="primary"
            pending={pending}
            pendingLabel={t("cli.authorizing", "Authorizing…")}
            onClick={() => onDecide(resolved.grantViewId, "approve")}
          >
            {t("cli.authorize", "Authorize CLI")}
          </Button>
        </footer>
      </section>
    )
  } else {
    content = (
      <section className="cli-card cli-code-entry" aria-labelledby="cli-code-title">
        <Eyebrow>{t("cli.authorization", "CLI authorization")}</Eyebrow>
        <h1 id="cli-code-title">{t("cli.enterCodeTitle", "Enter the code from your terminal")}</h1>
        <p className="muted-copy">{t("cli.enterCodeBody", "The code identifies a short-lived request. You will review it before anything is approved.")}</p>
        {resolution._tag === "Failed" && <FailureNotice failure={resolution.failure} />}
        <form onSubmit={(event) => {
          event.preventDefault()
          onResolve(code)
        }}>
          <label htmlFor="cli-user-code">{t("cli.code", "CLI code")}</label>
          <input
            id="cli-user-code"
            className="cli-code-input"
            value={code}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            placeholder={t("cli.codePlaceholder", "Q7KM4W")}
            maxLength={6}
            required
            onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
          />
          <Button type="submit" variant="primary">{t("cli.reviewRequest", "Review request")}</Button>
        </form>
      </section>
    )
  }

  return (
    <div className="cli-page">
      <div className="cli-wrap">
        <AccessHeader displayName={user.displayName} avatarUrl={user.avatarUrl} />
        <main id="main-content">{content}</main>
      </div>
    </div>
  )
}
