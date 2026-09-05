import { Button } from "@atape/ui"
import type { ActionView, LoadView } from "../presenters/accessPresenter"
import type { SignInOptions } from "@atape/domain"
import { AccessBrand, FailureNotice } from "./AccessPrimitives"

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
              <strong>CLI sign-in in progress</strong>
              <span>After signing in, review the request from <code>atape-cli</code>.</span>
            </div>
          )}
          <h1 id="sign-in-title">Sign in to ATape</h1>
          <p className="login-copy">Choose an enabled sign-in method to continue.</p>

          {options._tag === "Loading" && <p className="inline-status" role="status">Loading sign-in methods…</p>}
          {options._tag === "Failed" && <FailureNotice failure={options.failure} onRetry={onRetry} />}
          {options._tag === "Ready" && options.value.providers.length === 0 && (
            <div className="access-notice access-notice--warning" role="status">
              <strong>No sign-in method is enabled on this instance.</strong>
              <span>Ask the instance operator to configure a Provider.</span>
            </div>
          )}
          {options._tag === "Ready" && options.value.providers.map((provider) => (
            <Button
              key={provider.id}
              className="provider-button"
              variant="primary"
              pending={pending}
              pendingLabel="Opening sign-in…"
              onClick={() => onSignIn(provider.id)}
            >
              <ProviderMark /> Continue with {provider.label}
            </Button>
          ))}
          {action._tag === "Failed" && <FailureNotice failure={action.failure} />}
          {options._tag === "Ready" && (
            <p className="login-instance">Instance <code>{options.value.instance.instanceOrigin}</code></p>
          )}
        </section>
      </main>
    </div>
  )
}

const callbackMessages: Readonly<Record<string, { readonly title: string; readonly message: string }>> = {
  access_denied: {
    title: "Sign-in was cancelled",
    message: "No ATape session was created. You can try again whenever you are ready."
  },
  login_expired: {
    title: "This sign-in request expired",
    message: "Start again to receive a new, short-lived sign-in request."
  },
  identity_conflict: {
    title: "This identity belongs to another account",
    message: "ATape did not change either account. Contact the instance operator if this is unexpected."
  },
  provider_unavailable: {
    title: "The sign-in method is unavailable",
    message: "The Provider could not complete the request. Try again in a moment."
  },
  login_failed: {
    title: "ATape could not complete sign-in",
    message: "The request was rejected safely. Start a new sign-in attempt."
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
          <h1 id="auth-error-title">{copy.title}</h1>
          <p>{copy.message}</p>
          {incident !== undefined && <p className="incident-reference">Incident {incident}</p>}
          <a className="atape-button atape-button--primary provider-button" href="/auth/sign-in">Try sign-in again</a>
        </section>
      </main>
    </div>
  )
}
