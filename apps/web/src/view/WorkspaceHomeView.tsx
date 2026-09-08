import type { Workspace } from "@atape/domain"
import { Button, Eyebrow } from "@atape/ui"
import type { LoadableView } from "../presenters/memoryPresenter"

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
    return <section className="state-card" aria-live="polite">Looking for shared project memory…</section>
  }

  if (state._tag === "Failed") {
    return (
      <section className="state-card error-card" role="alert">
        <h1>ATape could not open the Workspace</h1>
        <p>{state.message}</p>
        {state.retryable && <Button onClick={onRetry}>Try again</Button>}
      </section>
    )
  }

  return (
    <section className="onboarding" aria-labelledby="workspace-home-title">
      <header className="hero onboarding-hero">
        <div>
          <Eyebrow>Your shared agent memory starts locally</Eyebrow>
          <h1 id="workspace-home-title">Bring in the first conversation</h1>
          <p>
            Choose one local Project and keep using your preferred Harness. ATape will capture its conversations
            into the Team’s searchable history.
          </p>
        </div>
        <span className="onboarding-route">CLI-first setup</span>
      </header>

      <div className="onboarding-steps" aria-label="Set up ATape collection">
        <SetupStep
          number={1}
          eyebrow="Choose the boundary"
          title="Open guided setup"
          command={"npm install --global @atape/cli\natape"}
        >
          Choose a local directory in the terminal. Setup handles sign-in and connects its Git repository or ordinary folder to your Team.
        </SetupStep>
        <SetupStep
          number={2}
          eyebrow="Review your choices"
          title="Confirm the Project and sources"
          command={"atape setup /path/to/project"}
        >
          Review the Instance, Team, Project and conversation sources. Confirm once to install the selected integrations, import history and start ongoing sync.
        </SetupStep>
        <SetupStep
          number={3}
          eyebrow="Create shared memory"
          title="Check progress in your Project console"
          command={"atape\n# After a reboot:\natape start"}
        >
          The terminal distinguishes waiting for a conversation, syncing and partial coverage. You can close it while background sync continues.
        </SetupStep>
      </div>

      <footer className="onboarding-refresh">
        <span>
          <strong>Already collecting?</strong>
          <small>The Workspace also checks automatically every 30 seconds.</small>
        </span>
        <Button pending={state.refreshing} pendingLabel="Checking…" onClick={onRetry}>Check again</Button>
      </footer>
    </section>
  )
}
