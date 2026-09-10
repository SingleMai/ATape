import { Button } from "@atape/ui"
import type { ActionView, LoadView } from "../presenters/accessPresenter"
import type { SignInOptions } from "@atape/domain"
import { AccessBrand, FailureNotice } from "./AccessPrimitives"
import { t, type WebMessageKey } from "../i18n"

const ProviderMark = () => (
  <svg className="provider-mark" aria-hidden="true" viewBox="0 0 24 24">
    <path d="M7 7.5a5 5 0 1 1 8.6 3.45L11 15.55V18H8v-3.7l5.45-5.45A2 2 0 1 0 10 7.5Z" fill="currentColor" />
    <path d="M8 20h3v3H8z" fill="currentColor" />
  </svg>
)

export const SignInView = ({
  options,
  action,
  cliReturn,
  flash,
  onSignIn,
  onRetry
}: {
  readonly options: LoadView<SignInOptions>
  readonly action: ActionView<string>
  readonly cliReturn: boolean
  readonly flash?: string
  readonly onSignIn: (providerRegistrationId: string) => void
  readonly onRetry: () => void
}) => {
  const pending = action._tag === "Pending"
  return (
    <div className="access-page auth-page">
      <main className="login-panel" id="main-content">
        <div className="login-brand"><AccessBrand /></div>
        <section className="auth-card" aria-labelledby="sign-in-title">
          {flash !== undefined && <div className="access-notice access-notice--success" role="status">{flash}</div>}
          {cliReturn && (
            <div className="return-context">
              <strong>{t("signIn.cliInProgress", "CLI sign-in in progress")}</strong>
              <span>{t("signIn.cliAfter", "After signing in, review the request from atape-cli.")}</span>
            </div>
          )}
          <h1 id="sign-in-title">{t("signIn.title", "Sign in to ATape")}</h1>
          <p className="login-copy">{t("signIn.subtitle", "Choose an enabled sign-in method to continue.")}</p>

          {options._tag === "Loading" && <p className="inline-status" role="status">{t("signIn.loading", "Loading sign-in methods…")}</p>}
          {options._tag === "Failed" && <FailureNotice failure={options.failure} onRetry={onRetry} />}
          {options._tag === "Ready" && options.value.providers.length === 0 && (
            <div className="access-notice access-notice--warning" role="status">
              <strong>{t("signIn.noMethodsTitle", "No sign-in method is enabled on this instance.")}</strong>
              <span>{t("signIn.noMethodsBody", "Ask the instance operator to configure a Provider.")}</span>
            </div>
          )}
          {options._tag === "Ready" && options.value.providers.map((provider) => (
            <Button
              key={provider.id}
              className="provider-button"
              variant="primary"
              pending={pending}
              pendingLabel={t("signIn.opening", "Opening sign-in…")}
              onClick={() => onSignIn(provider.id)}
            >
              <ProviderMark /> {t("signIn.continueWith", "Continue with {provider}", { provider: provider.label })}
            </Button>
          ))}
          {action._tag === "Failed" && <FailureNotice failure={action.failure} />}
          {options._tag === "Ready" && (
            <p className="login-instance">{t("signIn.instance", "Instance")} <code>{options.value.instance.instanceOrigin}</code></p>
          )}
        </section>
      </main>
    </div>
  )
}

const callbackMessages: Readonly<Record<string, { readonly titleKey: WebMessageKey; readonly messageKey: WebMessageKey }>> = {
  access_denied: {
    titleKey: "authError.access_denied.title",
    messageKey: "authError.access_denied.message"
  },
  login_expired: {
    titleKey: "authError.login_expired.title",
    messageKey: "authError.login_expired.message"
  },
  identity_conflict: {
    titleKey: "authError.identity_conflict.title",
    messageKey: "authError.identity_conflict.message"
  },
  provider_unavailable: {
    titleKey: "authError.provider_unavailable.title",
    messageKey: "authError.provider_unavailable.message"
  },
  login_failed: {
    titleKey: "authError.login_failed.title",
    messageKey: "authError.login_failed.message"
  }
}

export const AuthenticationErrorView = ({ code, incident }: {
  readonly code: string
  readonly incident?: string
}) => {
  const copy = callbackMessages[code] ?? callbackMessages.login_failed!
  return (
    <div className="access-page auth-page">
      <main className="login-panel" id="main-content">
        <div className="login-brand"><AccessBrand /></div>
        <section className="auth-card" aria-labelledby="auth-error-title">
          <div className="outcome-mark outcome-mark--danger" aria-hidden="true">!</div>
          <h1 id="auth-error-title">{t(copy.titleKey)}</h1>
          <p>{t(copy.messageKey)}</p>
          {incident !== undefined && <p className="incident-reference">{t("authError.incident", "Incident {incident}", { incident })}</p>}
          <a className="atape-button atape-button--primary provider-button" href="/auth/sign-in">{t("authError.tryAgain", "Try sign-in again")}</a>
        </section>
      </main>
    </div>
  )
}
