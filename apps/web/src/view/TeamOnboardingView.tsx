import { slugifyTeamName, type User } from "@atape/domain"
import { Button, Eyebrow } from "@atape/ui"
import { useState } from "react"
import type { ActionView } from "../presenters/accessPresenter"
import { AccessHeader, FailureNotice } from "./AccessPrimitives"

export const TeamChoiceView = ({ user }: { readonly user: User }) => (
  <div className="onboarding-page">
    <div className="onboarding-wrap">
      <AccessHeader displayName={user.displayName} />
      <main id="main-content">
        <section className="choice-heading" aria-labelledby="team-choice-title">
          <Eyebrow>Welcome, {user.displayName}</Eyebrow>
          <h1 id="team-choice-title">Start with a Team</h1>
          <p>A Team is the shared boundary for Projects and people. You can create or join more Teams later.</p>
        </section>
        <div className="choice-grid">
          <article className="choice-card choice-card--primary">
            <div className="choice-icon" aria-hidden="true">＋</div>
            <h2>Create a Team</h2>
            <p>Start a new space, then connect your first local Project from the CLI.</p>
            <a className="atape-button atape-button--primary" href="/onboarding/create-team">Create a Team</a>
          </article>
          <article className="choice-card">
            <div className="choice-icon choice-icon--secondary" aria-hidden="true">↗</div>
            <h2>Join with a code</h2>
            <p>Use the six-character code an Owner shared with you. Letter case does not matter.</p>
            <a className="atape-button atape-button--secondary" href="/onboarding/join-team">Join a Team</a>
          </article>
        </div>
      </main>
    </div>
  </div>
)

export const CreateTeamView = ({
  user,
  action,
  instanceOrigin,
  onSubmit
}: {
  readonly user: User
  readonly action: ActionView<unknown>
  readonly instanceOrigin: string
  readonly onSubmit: (input: { readonly displayName: string; readonly slug: string }) => void
}) => {
  const [displayName, setDisplayName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const pending = action._tag === "Pending"

  return (
    <div className="onboarding-page">
      <div className="onboarding-wrap">
        <AccessHeader displayName={user.displayName} />
        <main className="access-form-page" id="main-content">
          <a className="back-link" href="/onboarding">← Back</a>
          <form
            className="access-form-card"
            onSubmit={(event) => {
              event.preventDefault()
              onSubmit({ displayName, slug })
            }}
          >
            <Eyebrow>New Team</Eyebrow>
            <h1>Name your shared space</h1>
            <p className="muted-copy">You will be its first Owner. Team settings and members stay manageable from the Web.</p>
            {action._tag === "Failed" && <FailureNotice failure={action.failure} />}
            <div className="access-field">
              <label htmlFor="team-name">Team name</label>
              <input
                id="team-name"
                name="teamName"
                autoComplete="organization"
                value={displayName}
                required
                maxLength={200}
                aria-describedby="team-name-help"
                onChange={(event) => {
                  const value = event.target.value
                  setDisplayName(value)
                  if (!slugEdited) setSlug(slugifyTeamName(value))
                }}
              />
              <small id="team-name-help">Use the name people on this Team will recognize.</small>
            </div>
            <div className="access-field">
              <label htmlFor="team-slug">Web address</label>
              <input
                id="team-slug"
                name="teamSlug"
                value={slug}
                required
                minLength={2}
                maxLength={63}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                aria-describedby="team-slug-help team-url-preview"
                onChange={(event) => {
                  setSlugEdited(true)
                  setSlug(slugifyTeamName(event.target.value))
                }}
              />
              <small id="team-slug-help">Lowercase letters, numbers, and single hyphens.</small>
              <div className="slug-preview" id="team-url-preview">
                {instanceOrigin}/teams/<strong>{slug || "your-team"}</strong>
              </div>
            </div>
            <div className="access-form-actions">
              <Button type="submit" variant="primary" pending={pending} pendingLabel="Creating Team…">
                Create Team
              </Button>
              <a className="atape-button atape-button--ghost" href="/onboarding">Cancel</a>
            </div>
          </form>
        </main>
      </div>
    </div>
  )
}

export const JoinTeamView = ({
  user,
  action,
  onSubmit
}: {
  readonly user: User
  readonly action: ActionView<unknown>
  readonly onSubmit: (joinCode: string) => void
}) => {
  const [joinCode, setJoinCode] = useState("")
  const pending = action._tag === "Pending"
  return (
    <div className="onboarding-page">
      <div className="onboarding-wrap">
        <AccessHeader displayName={user.displayName} />
        <main className="access-form-page" id="main-content">
          <a className="back-link" href="/onboarding">← Back</a>
          <form
            className="access-form-card"
            onSubmit={(event) => {
              event.preventDefault()
              onSubmit(joinCode)
            }}
          >
            <Eyebrow>Join a Team</Eyebrow>
            <h1>Enter your join code</h1>
            <p className="muted-copy">Codes contain six letters and numbers. Letter case and spaces do not matter.</p>
            {action._tag === "Failed" && <FailureNotice failure={action.failure} />}
            <div className="access-field">
              <label htmlFor="join-code">Team join code</label>
              <input
                className="join-code-input"
                id="join-code"
                name="joinCode"
                inputMode="text"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                value={joinCode}
                maxLength={16}
                placeholder="K7M4PX"
                required
                pattern="[A-HJ-NP-Z2-9]{6}"
                aria-describedby="join-code-help"
                onChange={(event) => setJoinCode(
                  event.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6)
                )}
              />
              <small id="join-code-help">Ask a Team Owner if the code has expired or was rotated.</small>
            </div>
            <div className="access-form-actions">
              <Button type="submit" variant="primary" pending={pending} pendingLabel="Joining Team…">
                Join Team
              </Button>
              <a className="atape-button atape-button--ghost" href="/onboarding">Cancel</a>
            </div>
          </form>
        </main>
      </div>
    </div>
  )
}
