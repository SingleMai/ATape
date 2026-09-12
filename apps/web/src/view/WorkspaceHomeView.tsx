import type { Workspace } from "@atape/domain"
import { Button, Eyebrow } from "@atape/ui"
import type { LoadableView } from "../presenters/memoryPresenter"
import { t } from "../i18n"

type Props = {
  readonly state: LoadableView<Workspace>
  readonly teamSlug?: string
  readonly onRetry: () => void
}

const SetupStep = ({
  number,
  eyebrow,
  title,
  children,
  command
}: {
  readonly number: number
  readonly eyebrow: string
  readonly title: string
  readonly children: string
  readonly command: string
}) => (
  <article className="onboarding-step">
    <span className="onboarding-step-number" aria-hidden="true">{number}</span>
    <div>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2>{title}</h2>
      <p>{children}</p>
      <pre><code>{command}</code></pre>
    </div>
  </article>
)

export const WorkspaceHomeView = ({ state, onRetry }: Props) => {
  if (state._tag === "Loading") {
    return <section className="state-card" aria-live="polite">{t("home.loading", "Looking for shared project memory…")}</section>
  }

  if (state._tag === "Failed") {
    return (
      <section className="state-card error-card" role="alert">
        <h1>{t("home.unavailableTitle", "ATape could not open the Workspace")}</h1>
        <p>{t(state.messageKey)}</p>
        {state.retryable && <Button onClick={onRetry}>{t("common.tryAgain", "Try again")}</Button>}
      </section>
    )
  }

  return (
    <section className="onboarding" aria-labelledby="workspace-home-title">
      <header className="hero onboarding-hero">
        <div>
          <Eyebrow>{t("home.eyebrow", "Your shared agent memory starts locally")}</Eyebrow>
          <h1 id="workspace-home-title">{t("home.title", "Bring in the first conversation")}</h1>
          <p>
            {t("home.body", "Choose one local Project and keep using your preferred Harness. ATape will capture its conversations into the Team’s searchable history.")}
          </p>
        </div>
        <span className="onboarding-route">{t("home.cliFirst", "CLI-first setup")}</span>
      </header>

      <div className="onboarding-steps" aria-label={t("home.setupLabel", "Set up ATape collection")}>
        <SetupStep
          number={1}
          eyebrow={t("home.step1Eyebrow", "Choose the boundary")}
          title={t("home.step1Title", "Open guided setup")}
          command={"npm install --global @atape/cli\natape"}
        >
          {t("home.step1Body", "Choose a local directory in the terminal. Setup handles sign-in and connects its Git repository or ordinary folder to your Team.")}
        </SetupStep>
        <SetupStep
          number={2}
          eyebrow={t("home.step2Eyebrow", "Review your choices")}
          title={t("home.step2Title", "Confirm the Project and sources")}
          command={"atape"}
        >
          {t("home.step2Body", "Review the Instance, Team, Project and conversation sources. Confirm once to install the selected integrations, import history and start ongoing sync.")}
        </SetupStep>
        <SetupStep
          number={3}
          eyebrow={t("home.step3Eyebrow", "Create shared memory")}
          title={t("home.step3Title", "Check progress in your Project console")}
          command={"atape"}
        >
          {t("home.step3Body", "The terminal shows sync progress and problems. Closing it leaves background sync running. After a reboot, open ATape and select Start sync.")}
        </SetupStep>
      </div>

      <footer className="onboarding-refresh">
        <span>
          <strong>{t("home.alreadyCollecting", "Already collecting?")}</strong>
          <small>{t("home.autoCheck", "The Workspace also checks automatically every 30 seconds.")}</small>
        </span>
        <Button pending={state.refreshing} pendingLabel={t("home.checking", "Checking…")} onClick={onRetry}>{t("home.checkAgain", "Check again")}</Button>
      </footer>
    </section>
  )
}
