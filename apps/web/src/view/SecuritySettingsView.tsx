import type {
  CLICredential,
  ExternalIdentity,
  JoinCodeGrant,
  TeamMember,
  User
} from "@atape/domain"
import { useSettingsOverlay } from "../presenters/settingsOverlayContext"
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

const relativeTime = (value: string): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000))
  if (!Number.isFinite(minutes)) return "Unknown time"
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`
  return `${Math.floor(minutes / 1440)} days ago`
}

const SettingsShell = ({
  children,
  active,
  team,
  onSignOut
}: {
  readonly children: ReactNode
  readonly active: "account" | "team"
  readonly team?: { readonly slug: string; readonly displayName: string }
  readonly onSignOut: () => void
}) => {
  const { target, openSettings } = useSettingsOverlay()
  const section = active === "team" ? "team" : target.section
  return <div className="settings-modal-layout">
    <nav className="settings-categories" aria-label="Settings categories">
      {([ ["account", "Account"], ["credentials", "atape-cli"] ] as const).map(([key, label]) =>
        <button type="button" key={key} aria-current={section === key ? "page" : undefined}
          onClick={() => openSettings({ section: key })}>{label}</button>
      )}
      {team && <button type="button" aria-current={section === "team" ? "page" : undefined}
        onClick={() => openSettings({ section: "team", teamSlug: team.slug })}>Team settings</button>}
      <button type="button" className="settings-modal-signout" onClick={onSignOut}>Sign out</button>
    </nav>
    <div className="settings-modal-content" key={section}>{children}</div>
  </div>
}

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
        <Avatar name={identity.displayName} src={identity.avatarUrl} />
        <div className="row-copy">
          <strong>{providerLabel(identity.providerRegistrationId)} <Badge tone="success">Connected</Badge></strong>
          <span>{identity.displayName} · verified {formatTime(identity.lastVerifiedAt)}</span>
        </div>
      </div>
    </div>
  ))
}

const CredentialRows = ({
  section,
  onRetry,
  onRevoke
}: {
  readonly section: AccountSecurityViewModel["cliCredentials"]
  readonly onRetry: () => void
  readonly onRevoke: (credential: CLICredential) => void
}) => {
  if (section._tag === "Failed") return <SectionFailure section={section} onRetry={onRetry} />
  if (section.value.length === 0) return <div className="empty-row">No connected CLI devices. Sign in with atape login on a device to connect it.</div>
  return section.value.map((credential) => (
    <details className="cli-device-details" key={credential.id}>
      <summary className="cli-device-summary">
        <span className="row-icon" aria-hidden="true">⌘</span>
        <span className="cli-device-copy">
          <strong>{credential.device?.name ?? "Unidentified device"}</strong>
          <span>{credential.device?.platform ?? `Credential ${credential.id}`} · {credential.lastSuccessAt ? `Synced ${relativeTime(credential.lastSuccessAt)}` : "No successful sync reported"}</span>
          {credential.versionStatus?.startsWith("Update available") && <span className="cli-update-hint">{credential.versionStatus}</span>}
        </span>
        <span className={`cli-device-status${credential.attention ? " cli-attention" : ""}`}>{credential.status}</span>
        <span className="cli-chevron" aria-hidden="true">›</span>
      </summary>
      <div className="cli-device-body">
        <p className={credential.attention ? "cli-issue" : "cli-guidance"}>{credential.guidance}</p>
        {credential.jobs.filter(job => job.guidance).map(job => <p className="cli-guidance" key={`${job.projectId}:${job.adapterId}`}>{job.guidance}</p>)}
        {credential.adapters.length > 0 ? <table className="cli-adapter-table">
          <caption className="visually-hidden">Adapters on {credential.device?.name ?? credential.id}</caption>
          <thead><tr><th>Adapter</th><th>Status</th><th>Last success</th></tr></thead>
          <tbody>{credential.adapters.map(adapter => <tr key={adapter.id}>
            <td><strong>{adapter.packageName}</strong><span>{adapter.version ? `v${adapter.version}` : "Version not reported"}{adapter.version && <> · {adapter.versionStatus}</>}</span>
              {adapter.jobs.length > 1 && <details className="cli-project-details"><summary>{adapter.jobs.length} projects</summary>{adapter.jobs.map(job => <p key={job.projectId}>{job.projectName} · {job.state}{job.hasMore ? " · Catching up" : ""} · {job.lastSuccessAt ? formatTime(job.lastSuccessAt) : "No successful sync"}</p>)}</details>}
            </td>
            <td className={adapter.attention ? "cli-attention" : ""}>{adapter.status}</td>
            <td>{adapter.lastSuccessAt ? relativeTime(adapter.lastSuccessAt) : "Not reported"}</td>
          </tr>)}</tbody>
        </table> : <p>Adapters: {credential.device?.adapters === undefined ? "Not reported" : "None installed"}</p>}
        {credential.sync?.jobsTruncated && <p>Only part of this device’s job list is shown. Run <code>atape status</code> locally for all jobs.</p>}
        {credential.device?.adaptersTruncated && <p>Only part of the installed Adapter list is shown. Run <code>atape adapters list</code> locally.</p>}
        <div className="cli-version-row">
          <div><strong>atape-cli {credential.device ? `v${credential.device.version}` : "version not reported"}</strong><p>{credential.versionStatus}</p></div>
          <details className="cli-upgrade"><summary>Upgrade guide</summary><p>Run on this device:</p><code>atape upgrade</code><p>Update Adapters:</p><code>atape adapters upgrade --all</code></details>
        </div>
        <div className="cli-device-foot"><span>Status received: {credential.reportedAt ? formatTime(credential.reportedAt) : "Not reported"}</span><span>Connected {formatTime(credential.createdAt)}</span>
          {credential.device?.versionCheckedAt && <span>Versions checked: {formatTime(credential.device.versionCheckedAt)}</span>}
        </div>
        <div className="cli-device-actions"><Button className="quiet-danger-button" onClick={() => onRevoke(credential)}>Disconnect device</Button></div>
      </div>
    </details>
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
    readonly kind: "revoke-cli" | "revoke-all-cli"
    readonly id?: string
  }) => void
  readonly onSignOut: () => void
}) => {
  const { target } = useSettingsOverlay()
  const section = target.section === "team" ? "account" : target.section
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    readonly copy: Confirmation
    readonly action: Parameters<typeof onAction>[0]
  }>()
  const pending = action._tag === "Pending"
  useEffect(() => {
    if (action._tag === "Succeeded" || action._tag === "Failed") setPendingConfirmation(undefined)
  }, [action._tag])
  if (state._tag === "Loading") {
    return <SettingsShell active="account" {...(team === undefined ? {} : { team })} onSignOut={onSignOut}>
      <div className="settings-content" role="status">Loading account security…</div>
    </SettingsShell>
  }
  if (state._tag === "Failed") {
    return <SettingsShell active="account" {...(team === undefined ? {} : { team })} onSignOut={onSignOut}>
      <div className="settings-content"><FailureNotice failure={state.failure} onRetry={onRetry} /></div>
    </SettingsShell>
  }

  const snapshot = state.value
  const credentials = snapshot.cliCredentials._tag === "Ready" ? snapshot.cliCredentials.value : []
  const confirm = (copy: Confirmation, selected: Parameters<typeof onAction>[0]) =>
    setPendingConfirmation({ copy, action: selected })

  return (
    <SettingsShell active="account" {...(team === undefined ? {} : { team })} onSignOut={onSignOut}>
      <div className="settings-content">
        {action._tag === "Failed" && <FailureNotice failure={action.failure} />}
        {action._tag === "Succeeded" && <SuccessNotice>Account access was updated.</SuccessNotice>}
        <header className="settings-heading">
          <h1>{section === "account" ? "Account" : "atape-cli"}</h1>
          <p>{section === "account" ? "Your profile and connected sign-in methods." : "Check your sync devices here. Resolve issues in the local CLI."}</p>
        </header>
        {section === "account" && <div className="settings-profile-row"><Avatar name={user.displayName} src={user.avatarUrl} /><strong>{user.displayName}</strong></div>}

        <section className="settings-section" hidden={section !== "account"} aria-labelledby="signin-methods-title">
          <header><div><h2 id="signin-methods-title">Sign-in methods</h2><p>Connected identities reach this same ATape account.</p></div></header>
          <IdentityRows identities={snapshot.identities} providers={snapshot.providers} onRetry={onRetry} />
        </section>

        <section className="settings-section" hidden={section !== "credentials"} aria-labelledby="credentials-title">
          <header>
            <div><h2 className="visually-hidden" id="credentials-title">atape-cli</h2><span>{credentials.length} {credentials.length === 1 ? "device" : "devices"}</span></div>
            <div className="row-actions cli-toolbar-actions"><Button onClick={onRetry}>Refresh</Button><details className="cli-report-info"><summary aria-label="About device status">ⓘ</summary><p>Status updates every 30 seconds. Reports older than 2 minutes are marked as expired.</p></details></div>
          </header>
          <CredentialRows section={snapshot.cliCredentials} onRetry={onRetry} onRevoke={(credential) => confirm({
            title: "Revoke this CLI credential?",
            description: "That CLI login will stop working immediately. You’ll stay signed in here.",
            confirmLabel: "Revoke credential",
            danger: true
          }, { kind: "revoke-cli", id: credential.id })} />
          <p className="cli-guidance">Manage sync and updates in your local CLI.</p>
        </section>
      </div>
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
        <Avatar name={member.displayName} src={member.avatarUrl} />
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
  if (state._tag === "Loading") return <div className="settings-loading" role="status">Loading Team access…</div>
  if (state._tag === "Failed") return <div className="settings-loading"><FailureNotice failure={state.failure} onRetry={onRetry} /></div>

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
      active="team"
      team={{ slug: access.team.slug, displayName: access.team.displayName }}
      onSignOut={onSignOut}
    >
      <div className="settings-content">
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
      </div>
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
