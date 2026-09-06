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

export const WorkspaceHomeView = ({ state, teamSlug, onRetry }: Props) => {
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
          title="Register a local Project"
          command={`atape login\natape setup /path/to/project --team ${teamSlug ?? "your-team"} --create`}
        >
          ATape captures only the Git repository or ordinary folder you explicitly select.
        </SetupStep>
        <SetupStep
          number={2}
          eyebrow="Connect a Harness"
          title="Install and enable an Adapter"
          command={"atape adapters install <adapter-package>\natape adapters enable <adapter-id> --project <project-id>"}
        >
          Adapters stay independent and are loaded only when that Project is collected.
        </SetupStep>
        <SetupStep
          number={3}
          eyebrow="Create shared memory"
          title="Start background collection"
          command={"atape start\natape status"}
        >
          The first successful cycle makes the Project visible here; later cycles keep it current.
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
