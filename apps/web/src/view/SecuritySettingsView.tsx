import type {
  CLICredential,
  ExternalIdentity,
  JoinCodeGrant,
  TeamMember,
  User,
  WebSession
} from "@atape/domain"
import { Avatar, Badge, Button, Eyebrow } from "@atape/ui"
import { useEffect, useState, type ReactNode } from "react"
import type {
  AccountSecurityViewModel,
  ActionView,
  LoadView,
  SectionView,
  TeamAccess,
  TeamAccessAction
} from "../presenters/accessPresenter"
import {
  AccessBrand,
  AccountChip,
  ConfirmationDialog,
  FailureNotice,
  SuccessNotice,
  type Confirmation
} from "./AccessPrimitives"

const formatTime = (value: string): string => {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return "Unknown time"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
}

export const SettingsShell = ({
  children,
  user,
  active,
  team,
  onSignOut
}: {
  readonly children: ReactNode
  readonly user: User
  readonly active: "account" | "team"
  readonly team?: { readonly slug: string; readonly displayName: string }
  readonly onSignOut: () => void
}) => (
  <div className="settings-shell">
    <a className="skip-link" href="#main-content">Skip to settings</a>
    <aside className="settings-sidebar" aria-label="Workspace">
      <AccessBrand />
      {team !== undefined && (
        <a className="settings-team" href="/" aria-label={`Current Team: ${team.displayName}`}>
          <span><strong>{team.displayName}</strong><small>/teams/{team.slug}</small></span>
          <Badge>Current</Badge>
        </a>
      )}
      <nav className="settings-nav" aria-label="ATape sections">
        <span className="settings-nav-label">Workspace</span>
        <a href="/"><span aria-hidden="true">⌂</span> Overview</a>
        <span className="settings-nav-label">Settings</span>
        <a className={active === "account" ? "active" : ""} href="/settings/account" aria-current={active === "account" ? "page" : undefined}>
          <span aria-hidden="true">◎</span> Account
        </a>
        {team !== undefined && (
          <a
            className={active === "team" ? "active" : ""}
            href={`/teams/${encodeURIComponent(team.slug)}/settings/access`}
            aria-current={active === "team" ? "page" : undefined}
          >
            <span aria-hidden="true">♢</span> Team &amp; access
          </a>
        )}
      </nav>
      <Button className="settings-signout" variant="ghost" onClick={onSignOut}>Sign out</Button>
    </aside>
    <div className="settings-main">
      <header className="settings-topbar">
        <span>{team?.displayName ?? "ATape"} / <strong>Settings</strong></span>
        <AccountChip displayName={user.displayName} />
      </header>
      {children}
    </div>
  </div>
)

const SectionFailure = ({ section, onRetry }: {
  readonly section: Extract<SectionView<unknown>, { readonly _tag: "Failed" }>
  readonly onRetry: () => void
}) => <div className="settings-section-state"><FailureNotice failure={section.failure} onRetry={onRetry} /></div>

const IdentityRows = ({
  identities,
  providers,
  onRetry
}: {
  readonly identities: SectionView<ReadonlyArray<ExternalIdentity>>
  readonly providers: AccountSecurityViewModel["providers"]
  readonly onRetry: () => void
}) => {
  if (identities._tag === "Failed") return <SectionFailure section={identities} onRetry={onRetry} />
  const providerLabel = (providerId: string) => providers._tag === "Ready"
    ? providers.value.find((provider) => provider.id === providerId)?.label ?? "Sign-in method"
    : "Sign-in method"
  if (identities.value.length === 0) return <div className="empty-row">No connected sign-in methods.</div>
  return identities.value.map((identity) => (
    <div className="settings-row" key={identity.id}>
      <div className="row-identity">
        <Avatar name={identity.displayName} />
        <div className="row-copy">
          <strong>{providerLabel(identity.providerRegistrationId)} <Badge tone="success">Connected</Badge></strong>
          <span>{identity.displayName} · verified {formatTime(identity.lastVerifiedAt)}</span>
        </div>
      </div>
    </div>
  ))
}

const SessionRows = ({
  section,
  onRetry,
  onRevoke
}: {
  readonly section: SectionView<ReadonlyArray<WebSession>>
  readonly onRetry: () => void
  readonly onRevoke: (session: WebSession) => void
}) => {
  if (section._tag === "Failed") return <SectionFailure section={section} onRetry={onRetry} />
  if (section.value.length === 0) return <div className="empty-row">No active browser sessions.</div>
  return section.value.map((session) => (
    <div className="settings-row" key={session.id}>
      <div className="row-identity">
        <span className="row-icon" aria-hidden="true">{session.current === true ? "◉" : "○"}</span>
        <div className="row-copy">
          <strong>
            {session.current === true ? "This browser session" : "Browser session"}
            {session.current === true && <Badge tone="success">Current</Badge>}
          </strong>
          <span>Created {formatTime(session.createdAt)} · last used {formatTime(session.lastUsedAt)}</span>
        </div>
      </div>
      <Button className={session.current === true ? undefined : "quiet-danger-button"} onClick={() => onRevoke(session)}>
        {session.current === true ? "Sign out" : "Revoke"}
      </Button>
    </div>
  ))
}

const CredentialRows = ({
  section,
  onRetry,
  onRevoke
}: {
  readonly section: SectionView<ReadonlyArray<CLICredential>>
  readonly onRetry: () => void
  readonly onRevoke: (credential: CLICredential) => void
}) => {
  if (section._tag === "Failed") return <SectionFailure section={section} onRetry={onRetry} />
  if (section.value.length === 0) return <div className="empty-row">No active CLI credentials.</div>
  return section.value.map((credential) => (
    <div className="settings-row" key={credential.id}>
      <div className="row-identity">
        <span className="row-icon" aria-hidden="true">⌘</span>
        <div className="row-copy">
          <strong>atape-cli</strong>
          <span>Created {formatTime(credential.createdAt)} · last used {formatTime(credential.lastUsedAt)}</span>
        </div>
      </div>
      <Button className="quiet-danger-button" onClick={() => onRevoke(credential)}>Revoke</Button>
    </div>
  ))
}

export const AccountSecurityView = ({
  user,
  team,
  state,
  action,
  onRetry,
  onAction,
  onSignOut
}: {
  readonly user: User
  readonly team?: { readonly slug: string; readonly displayName: string }
  readonly state: LoadView<AccountSecurityViewModel>
  readonly action: ActionView<void>
  readonly onRetry: () => void
  readonly onAction: (input: {
    readonly kind: "revoke-web" | "revoke-all-web" | "revoke-cli" | "revoke-all-cli"
    readonly id?: string
  }) => void
  readonly onSignOut: () => void
}) => {
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    readonly copy: Confirmation
    readonly action: Parameters<typeof onAction>[0]
  }>()
  const pending = action._tag === "Pending"
  useEffect(() => {
    if (action._tag === "Succeeded" || action._tag === "Failed") setPendingConfirmation(undefined)
  }, [action._tag])
  if (state._tag === "Loading") {
    return <SettingsShell user={user} active="account" {...(team === undefined ? {} : { team })} onSignOut={onSignOut}>
      <main className="settings-content" id="main-content" role="status">Loading account security…</main>
    </SettingsShell>
  }
  if (state._tag === "Failed") {
    return <SettingsShell user={user} active="account" {...(team === undefined ? {} : { team })} onSignOut={onSignOut}>
      <main className="settings-content" id="main-content"><FailureNotice failure={state.failure} onRetry={onRetry} /></main>
    </SettingsShell>
  }

  const snapshot = state.value
  const sessions = snapshot.webSessions._tag === "Ready" ? snapshot.webSessions.value : []
  const credentials = snapshot.cliCredentials._tag === "Ready" ? snapshot.cliCredentials.value : []
  const confirm = (copy: Confirmation, selected: Parameters<typeof onAction>[0]) =>
    setPendingConfirmation({ copy, action: selected })

  return (
    <SettingsShell user={user} active="account" {...(team === undefined ? {} : { team })} onSignOut={onSignOut}>
      <main className="settings-content" id="main-content">
        {action._tag === "Failed" && <FailureNotice failure={action.failure} />}
        {action._tag === "Succeeded" && <SuccessNotice>Account access was updated.</SuccessNotice>}
        <header className="settings-heading">
          <Eyebrow>Personal settings</Eyebrow>
          <h1>Account security</h1>
          <p>Review how you sign in and remove access you no longer recognize. ATape does not build a device inventory.</p>
        </header>

        <section className="settings-section" aria-labelledby="signin-methods-title">
          <header><div><h2 id="signin-methods-title">Sign-in methods</h2><p>Connected identities reach this same ATape account.</p></div></header>
          <IdentityRows identities={snapshot.identities} providers={snapshot.providers} onRetry={onRetry} />
          <footer className="section-footer"><p>More methods appear only when this instance enables another Provider.</p></footer>
        </section>

        <section className="settings-section" aria-labelledby="sessions-title">
          <header>
            <div><h2 id="sessions-title">Browser sessions</h2><p>Sessions end after 30 idle days or 180 days total.</p></div>
            <Badge>{sessions.length} active</Badge>
          </header>
          <SessionRows section={snapshot.webSessions} onRetry={onRetry} onRevoke={(session) => confirm({
            title: session.current === true ? "Sign out this browser?" : "Revoke this browser session?",
            description: session.current === true
              ? "You will return to sign-in. Other browser sessions and CLI credentials stay active."
              : "That browser will need to sign in again. Other access stays active.",
            confirmLabel: session.current === true ? "Sign out" : "Revoke session",
            danger: true
          }, { kind: "revoke-web", id: session.id })} />
          {snapshot.webSessions._tag === "Ready" && sessions.length > 0 && (
            <footer className="section-footer">
              <p>This signs the account out in every browser, including this one.</p>
              <Button className="quiet-danger-button" onClick={() => confirm({
                title: "Revoke every browser session?",
                description: "Every browser will be signed out. CLI credentials stay active.",
                confirmLabel: "Revoke all sessions",
                danger: true
              }, { kind: "revoke-all-web" })}>Revoke all</Button>
            </footer>
          )}
        </section>

        <section className="settings-section" aria-labelledby="credentials-title">
          <header>
            <div><h2 id="credentials-title">CLI credentials</h2><p>Only creation and last-use time are retained here; secret values are never shown again.</p></div>
            <Badge>{credentials.length} active</Badge>
          </header>
          <CredentialRows section={snapshot.cliCredentials} onRetry={onRetry} onRevoke={(credential) => confirm({
            title: "Revoke this CLI credential?",
            description: "That CLI login will stop working immediately. Browser sessions are unaffected.",
            confirmLabel: "Revoke credential",
            danger: true
          }, { kind: "revoke-cli", id: credential.id })} />
          {snapshot.cliCredentials._tag === "Ready" && credentials.length > 0 && (
            <footer className="section-footer">
              <p>Use this if a computer is lost or you no longer trust any CLI login.</p>
              <Button className="quiet-danger-button" onClick={() => confirm({
                title: "Revoke every CLI credential?",
                description: "All connected CLIs will stop working and must sign in again. Browser sessions are unaffected.",
                confirmLabel: "Revoke all credentials",
                danger: true
              }, { kind: "revoke-all-cli" })}>Revoke all</Button>
            </footer>
          )}
        </section>
      </main>
      <ConfirmationDialog
        confirmation={pendingConfirmation?.copy}
        pending={pending}
        onCancel={() => setPendingConfirmation(undefined)}
        onConfirm={() => {
          if (pendingConfirmation !== undefined) onAction(pendingConfirmation.action)
        }}
      />
    </SettingsShell>
  )
}

const MemberRow = ({
  member,
  currentUserId,
  owner,
  onlyOwner,
  onAction
}: {
  readonly member: TeamMember
  readonly currentUserId: string
  readonly owner: boolean
  readonly onlyOwner: boolean
  readonly onAction: (copy: Confirmation, action: TeamAccessAction) => void
}) => {
  const current = member.userId === currentUserId
  return (
    <div className="settings-row">
      <div className="row-identity">
        <Avatar name={member.displayName} />
        <div className="row-copy">
          <strong>{member.displayName} {current && <Badge>You</Badge>} <Badge tone="accent">{member.role === "owner" ? "Owner" : "Member"}</Badge></strong>
          <span>Joined {formatTime(member.joinedAt)}</span>
        </div>
      </div>
      <div className="row-actions">
        {current ? (
          <Button
            className="quiet-danger-button"
            disabled={onlyOwner}
            onClick={() => onAction({
              title: "Leave this Team?",
              description: "You will immediately lose access to this Team and its Projects.",
              confirmLabel: "Leave Team",
              danger: true
            }, { kind: "leave" })}
          >Leave Team</Button>
        ) : owner ? (
          <>
            <Button onClick={() => onAction({
              eyebrow: "Confirm role change",
              title: member.role === "owner" ? `Make ${member.displayName} a Member?` : `Make ${member.displayName} an Owner?`,
              description: member.role === "owner"
                ? "They will immediately lose Team administration access."
                : "Owners can manage members, roles, join codes, and Team security.",
              confirmLabel: "Change role"
            }, { kind: "set-role", userId: member.userId, role: member.role === "owner" ? "member" : "owner" })}>
              {member.role === "owner" ? "Make Member" : "Make Owner"}
            </Button>
            <Button className="quiet-danger-button" onClick={() => onAction({
              title: `Remove ${member.displayName}?`,
              description: "They will immediately lose access to this Team and its Projects.",
              confirmLabel: "Remove member",
              danger: true
            }, { kind: "remove-member", userId: member.userId })}>Remove</Button>
          </>
        ) : null}
      </div>
    </div>
  )
}

export const TeamAccessView = ({
  user,
  state,
  action,
  onRetry,
  onAction,
  onReauthenticate,
  onSignOut
}: {
  readonly user: User
  readonly state: LoadView<TeamAccess>
  readonly action: ActionView<void | JoinCodeGrant>
  readonly onRetry: () => void
  readonly onAction: (input: TeamAccessAction) => void
  readonly onReauthenticate: () => void
  readonly onSignOut: () => void
}) => {
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    readonly copy: Confirmation
    readonly action: TeamAccessAction
  }>()
  const [copyStatus, setCopyStatus] = useState("")
  useEffect(() => {
    if (action._tag === "Succeeded" || action._tag === "Failed") setPendingConfirmation(undefined)
  }, [action._tag])
  if (state._tag === "Loading") return <div className="access-page"><main className="access-state-card" role="status">Loading Team access…</main></div>
  if (state._tag === "Failed") return <div className="access-page"><main className="access-state-card"><FailureNotice failure={state.failure} onRetry={onRetry} /></main></div>

  const access = state.value
  const owner = access.team.membership.role === "owner"
  const ownerCount = access.members.filter((member) => member.role === "owner").length
  const current = access.members.find((member) => member.userId === user.id)
  const onlyOwner = current?.role === "owner" && ownerCount === 1
  const joinCode = access.joinCode
  const newGrant = action._tag === "Succeeded" && typeof action.value === "object" && action.value !== null
    ? action.value as JoinCodeGrant
    : undefined
  const pending = action._tag === "Pending"
  const confirm = (copy: Confirmation, selected: TeamAccessAction) => setPendingConfirmation({ copy, action: selected })

  return (
    <SettingsShell
      user={user}
      active="team"
      team={{ slug: access.team.slug, displayName: access.team.displayName }}
      onSignOut={onSignOut}
    >
      <main className="settings-content" id="main-content">
        {action._tag === "Failed" && (
          <FailureNotice
            failure={action.failure}
            {...(action.failure.reason === "fresh_authentication_required"
              ? { onRetry: onReauthenticate, retryLabel: "Confirm sign-in" }
              : {})}
          />
        )}
        <header className="settings-heading">
          <Eyebrow>{access.team.displayName}</Eyebrow>
          <h1>Team &amp; access</h1>
          <p>Review members and keep at least one Owner responsible for this Team.</p>
        </header>

        {owner && joinCode !== undefined && (
          <section className="settings-section" aria-labelledby="join-code-title">
            <header>
              <div><h2 id="join-code-title">Team join code</h2><p>Anyone with an active code can join as a Member.</p></div>
              <Badge tone={joinCode.enabled ? "success" : "neutral"}>{joinCode.enabled ? "Active" : "Disabled"}</Badge>
            </header>
            <div className="join-code-panel">
              <div>
                {newGrant !== undefined ? (
                  <>
                    <div className="join-code"><code>{newGrant.code}</code><span>case-insensitive</span></div>
                    <p className="one-time-note" role="status"><strong>Copy this now.</strong> It will not be shown again.</p>
                  </>
                ) : joinCode.enabled ? (
                  <p><strong>A join code is active.</strong><br /><span className="muted-copy">For safety, its value is shown only immediately after rotation.</span></p>
                ) : <p><strong>New members cannot join by code.</strong></p>}
              </div>
              <div className="join-code-actions">
                {newGrant !== undefined && <Button onClick={() => void navigator.clipboard.writeText(newGrant.code).then(
                  () => setCopyStatus("Join code copied"),
                  () => setCopyStatus("Copy failed; select the code manually")
                )}>Copy</Button>}
                <Button variant={joinCode.enabled ? "secondary" : "primary"} onClick={() => confirm({
                  eyebrow: "Fresh confirmation",
                  title: joinCode.enabled ? "Rotate the Team join code?" : "Enable joining by code?",
                  description: joinCode.enabled
                    ? "The current code will stop working immediately."
                    : "Anyone with the new code can join this Team as a Member.",
                  confirmLabel: joinCode.enabled ? "Rotate code" : "Create new code"
                }, { kind: "rotate-code" })}>{joinCode.enabled ? "Rotate" : "Create new code"}</Button>
                {joinCode.enabled && <Button className="quiet-danger-button" onClick={() => confirm({
                  title: "Disable joining by code?",
                  description: "The current code will stop working immediately. Existing members keep their access.",
                  confirmLabel: "Disable code",
                  danger: true
                }, { kind: "disable-code" })}>Disable</Button>}
              </div>
            </div>
            {copyStatus !== "" && <p className="copy-status" role="status">{copyStatus}</p>}
          </section>
        )}

        <section className="settings-section" aria-labelledby="members-title">
          <header>
            <div><h2 id="members-title">Members</h2><p>Owners manage people and Team security. Members can create and use Projects.</p></div>
            <Badge>{access.members.length} people</Badge>
          </header>
          {access.members.map((member) => <MemberRow
            key={member.userId}
            member={member}
            currentUserId={user.id}
            owner={owner}
            onlyOwner={onlyOwner}
            onAction={confirm}
          />)}
          {onlyOwner && <p className="owner-note"><strong>You are the only Owner.</strong> Make another member an Owner before leaving.</p>}
        </section>
      </main>
      <ConfirmationDialog
        confirmation={pendingConfirmation?.copy}
        pending={pending}
        onCancel={() => setPendingConfirmation(undefined)}
        onConfirm={() => {
          if (pendingConfirmation !== undefined) onAction(pendingConfirmation.action)
        }}
      />
    </SettingsShell>
  )
}
