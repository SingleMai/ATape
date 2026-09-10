import type {
  CLICredential,
  ExternalIdentity,
  JoinCodeGrant,
  TeamMember,
  User
} from "@atape/domain"
import { useSettingsOverlay } from "../presenters/settingsOverlayContext"
import { Avatar, Badge, Button, Eyebrow } from "@atape/ui"
import { SUPPORTED_LOCALES, type Locale } from "@atape/i18n"
import { useEffect, useState, type ReactNode } from "react"
import { currentLocale, formatDate, setWebLocale, t, type WebMessageKey } from "../i18n"
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
  if (!Number.isFinite(date.valueOf())) return t("time.unknown", "Unknown time")
  return formatDate(date, { dateStyle: "medium", timeStyle: "short" })
}

const relativeTime = (value: string): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000))
  if (!Number.isFinite(minutes)) return t("time.unknown", "Unknown time")
  if (minutes < 1) return t("time.justNow", "just now")
  if (minutes < 60) return t("time.minutesAgoLong", "{count} min ago", { count: minutes })
  if (minutes < 1440) return t("time.hoursAgoLong", "{count} hr ago", { count: Math.floor(minutes / 60) })
  return t("time.daysAgoLong", "{count} days ago", { count: Math.floor(minutes / 1440) })
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
    <nav className="settings-categories" aria-label={t("security.settingsCategories", "Settings categories")}>
      {([ ["account", t("security.account", "Account")], ["credentials", t("security.atapeCli", "atape-cli")] ] as const).map(([key, label]) =>
        <button type="button" key={key} aria-current={section === key ? "page" : undefined}
          onClick={() => openSettings({ section: key })}>{label}</button>
      )}
      {team && <button type="button" aria-current={section === "team" ? "page" : undefined}
        onClick={() => openSettings({ section: "team", teamSlug: team.slug })}>{t("security.teamSettings", "Team settings")}</button>}
      <button type="button" className="settings-modal-signout" onClick={onSignOut}>{t("security.signOut", "Sign out")}</button>
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
    ? providers.value.find((provider) => provider.id === providerId)?.label ?? t("security.signInMethod", "Sign-in method")
    : t("security.signInMethod", "Sign-in method")
  if (identities.value.length === 0) return <div className="empty-row">{t("security.noIdentities", "No connected sign-in methods.")}</div>
  return identities.value.map((identity) => (
    <div className="settings-row" key={identity.id}>
      <div className="row-identity">
        <Avatar name={identity.displayName} src={identity.avatarUrl} />
        <div className="row-copy">
          <strong>{providerLabel(identity.providerRegistrationId)} <Badge tone="success">{t("security.connected", "Connected")}</Badge></strong>
          <span>{t("security.verified", "{name} · verified {time}", { name: identity.displayName, time: formatTime(identity.lastVerifiedAt) })}</span>
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
  if (section.value.length === 0) return <div className="empty-row">{t("security.noDevices", "No connected CLI devices. Sign in with atape login on a device to connect it.")}</div>
  return section.value.map((credential) => (
    <details className="cli-device-details" key={credential.id}>
      <summary className="cli-device-summary">
        <span className="row-icon" aria-hidden="true">⌘</span>
        <span className="cli-device-copy">
          <strong>{credential.device?.name ?? t("security.unidentifiedDevice", "Unidentified device")}</strong>
          <span>{t("security.deviceLine", "{platform} · {sync}", { platform: credential.device?.platform ?? t("security.credentialId", "Credential {id}", { id: credential.id }), sync: credential.lastSuccessAt ? t("security.synced", "Synced {time}", { time: relativeTime(credential.lastSuccessAt) }) : t("security.noSync", "No successful sync reported") })}</span>
          {credential.versionStatus?.startsWith("Update available") && <span className="cli-update-hint">{credential.versionStatus}</span>}
        </span>
        <span className={`cli-device-status${credential.attention ? " cli-attention" : ""}`}>{credential.status}</span>
        <span className="cli-chevron" aria-hidden="true">›</span>
      </summary>
      <div className="cli-device-body">
        <p className={credential.attention ? "cli-issue" : "cli-guidance"}>{credential.guidance}</p>
        {credential.jobs.filter(job => job.guidance).map(job => <p className="cli-guidance" key={`${job.projectId}:${job.adapterId}`}>{job.guidance}</p>)}
        {credential.adapters.length > 0 ? <table className="cli-adapter-table">
          <caption className="visually-hidden">{t("security.adaptersOn", "Adapters on {name}", { name: credential.device?.name ?? credential.id })}</caption>
          <thead><tr><th>{t("security.adapter", "Adapter")}</th><th>{t("security.status", "Status")}</th><th>{t("security.lastSuccess", "Last success")}</th></tr></thead>
          <tbody>{credential.adapters.map(adapter => <tr key={adapter.id}>
            <td><strong>{adapter.packageName}</strong><span>{adapter.version ? `v${adapter.version}` : t("security.versionNotReported", "Version not reported")}{adapter.version && <> · {adapter.versionStatus}</>}</span>
              {adapter.jobs.length > 1 && <details className="cli-project-details"><summary>{t("security.projectCount", "{count} projects", { count: adapter.jobs.length })}</summary>{adapter.jobs.map(job => <p key={job.projectId}>{job.projectName} · {job.state}{job.hasMore ? ` · ${t("security.catchingUp", "Catching up")}` : ""} · {job.lastSuccessAt ? formatTime(job.lastSuccessAt) : t("security.noSuccessfulSync", "No successful sync")}</p>)}</details>}
            </td>
            <td className={adapter.attention ? "cli-attention" : ""}>{adapter.status}</td>
            <td>{adapter.lastSuccessAt ? relativeTime(adapter.lastSuccessAt) : t("security.notReported", "Not reported")}</td>
          </tr>)}</tbody>
        </table> : <p>{t("security.adapters", "Adapters: {value}", { value: credential.device?.adapters === undefined ? t("security.notReported", "Not reported") : t("security.noneInstalled", "None installed") })}</p>}
        {credential.sync?.jobsTruncated && <p>{t("security.jobsTruncated", "Only part of this device’s job list is shown. Run")} <code>atape status</code> {t("security.locallyForAllJobs", "locally for all jobs.")}</p>}
        {credential.device?.adaptersTruncated && <p>{t("security.adaptersTruncated", "Only part of the installed Adapter list is shown. Run")} <code>atape adapters list</code> {t("security.locally", "locally.")}</p>}
        <div className="cli-version-row">
          <div><strong>{t("security.cliVersion", "atape-cli {version}", { version: credential.device ? `v${credential.device.version}` : t("security.versionNotReported", "version not reported") })}</strong><p>{credential.versionStatus}</p></div>
          <details className="cli-upgrade"><summary>{t("security.upgradeGuide", "Upgrade guide")}</summary><p>{t("security.runOnDevice", "Run on this device:")}</p><code>atape upgrade</code><p>{t("security.updateAdapters", "Update Adapters:")}</p><code>atape adapters upgrade --all</code></details>
        </div>
        <div className="cli-device-foot"><span>{t("security.statusReceived", "Status received: {time}", { time: credential.reportedAt ? formatTime(credential.reportedAt) : t("security.notReported", "Not reported") })}</span><span>{t("security.connectedAt", "Connected {time}", { time: formatTime(credential.createdAt) })}</span>
          {credential.device?.versionCheckedAt && <span>{t("security.versionsChecked", "Versions checked: {time}", { time: formatTime(credential.device.versionCheckedAt) })}</span>}
        </div>
        <div className="cli-device-actions"><Button className="quiet-danger-button" onClick={() => onRevoke(credential)}>{t("security.disconnectDevice", "Disconnect device")}</Button></div>
      </div>
    </details>
  ))
}

const localeLabels: Readonly<Record<Locale, WebMessageKey>> = {
  en: "security.locale.en",
  "zh-CN": "security.locale.zh-CN"
}

const LanguageSettings = ({ section }: { readonly section: "account" | "credentials" }) => (
  <section className="settings-section" hidden={section !== "account"} aria-labelledby="language-title">
    <header><div><h2 id="language-title">{t("security.language", "Language")}</h2><p>{t("security.languageBody", "Choose the language for the Web interface.")}</p></div></header>
    <label className="settings-row">
      <span>{t("security.language", "Language")}</span>
      <select
        aria-label={t("security.language", "Language")}
        value={currentLocale()}
        onChange={(event) => {
          setWebLocale(event.target.value as Locale)
          window.location.reload()
        }}
      >
        {SUPPORTED_LOCALES.map((locale) => (
          <option key={locale} value={locale}>{t(localeLabels[locale])}</option>
        ))}
      </select>
    </label>
  </section>
)

export const AccountSecurityView = ({
  user,
  team,
  state,
  action,
  onRetry,
  onAction,
  onSignOut,
  rawCaptureSettings
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
  readonly rawCaptureSettings?: ReactNode
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
      <div className="settings-content" role="status">{t("security.loading", "Loading account security…")}</div>
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
        {action._tag === "Succeeded" && <SuccessNotice>{t("security.updated", "Account access was updated.")}</SuccessNotice>}
        <header className="settings-heading">
          <h1>{section === "account" ? t("security.account", "Account") : t("security.atapeCli", "atape-cli")}</h1>
          <p>{section === "account" ? t("security.accountSubtitle", "Your profile and connected sign-in methods.") : t("security.credentialsSubtitle", "Check your sync devices here. Resolve issues in the local CLI.")}</p>
        </header>
        {section === "account" && <div className="settings-profile-row"><Avatar name={user.displayName} src={user.avatarUrl} /><strong>{user.displayName}</strong></div>}

        <LanguageSettings section={section} />
        {section === "account" && rawCaptureSettings}
        <section className="settings-section" hidden={section !== "account"} aria-labelledby="signin-methods-title">
          <header><div><h2 id="signin-methods-title">{t("security.signInMethods", "Sign-in methods")}</h2><p>{t("security.signInMethodsBody", "Connected identities reach this same ATape account.")}</p></div></header>
          <IdentityRows identities={snapshot.identities} providers={snapshot.providers} onRetry={onRetry} />
        </section>

        <section className="settings-section" hidden={section !== "credentials"} aria-labelledby="credentials-title">
          <header>
            <div><h2 className="visually-hidden" id="credentials-title">{t("security.atapeCli", "atape-cli")}</h2><span>{t("security.deviceCount", "{count, plural, one {# device} other {# devices}}", { count: credentials.length })}</span></div>
            <div className="row-actions cli-toolbar-actions"><Button onClick={onRetry}>{t("security.refresh", "Refresh")}</Button><details className="cli-report-info"><summary aria-label={t("security.aboutDeviceStatus", "About device status")}>ⓘ</summary><p>{t("security.deviceStatusHelp", "Status updates every 30 seconds. Reports older than 2 minutes are marked as expired.")}</p></details></div>
          </header>
          <CredentialRows section={snapshot.cliCredentials} onRetry={onRetry} onRevoke={(credential) => confirm({
            title: t("security.revokeConfirmTitle", "Revoke this CLI credential?"),
            description: t("security.revokeConfirmBody", "That CLI login will stop working immediately. You’ll stay signed in here."),
            confirmLabel: t("security.revokeConfirmLabel", "Revoke credential"),
            danger: true
          }, { kind: "revoke-cli", id: credential.id })} />
          <p className="cli-guidance">{t("security.manageLocalCli", "Manage sync and updates in your local CLI.")}</p>
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
          <strong>{member.displayName} {current && <Badge>{t("security.you", "You")}</Badge>} <Badge tone="accent">{member.role === "owner" ? t("security.owner", "Owner") : t("security.member", "Member")}</Badge></strong>
          <span>{t("security.joined", "Joined {time}", { time: formatTime(member.joinedAt) })}</span>
        </div>
      </div>
      <div className="row-actions">
        {current ? (
          <Button
            className="quiet-danger-button"
            disabled={onlyOwner}
            onClick={() => onAction({
              title: t("security.leaveConfirmTitle", "Leave this Team?"),
              description: t("security.leaveConfirmBody", "You will immediately lose access to this Team and its Projects."),
              confirmLabel: t("security.leaveTeam", "Leave Team"),
              danger: true
            }, { kind: "leave" })}
          >{t("security.leaveTeam", "Leave Team")}</Button>
        ) : owner ? (
          <>
            <Button onClick={() => onAction({
              eyebrow: t("security.roleChangeEyebrow", "Confirm role change"),
              title: member.role === "owner" ? t("security.makeMemberTitle", "Make {name} a Member?", { name: member.displayName }) : t("security.makeOwnerTitle", "Make {name} an Owner?", { name: member.displayName }),
              description: member.role === "owner"
                ? t("security.makeMemberBody", "They will immediately lose Team administration access.")
                : t("security.makeOwnerBody", "Owners can manage members, roles, join codes, and Team security."),
              confirmLabel: t("security.changeRole", "Change role")
            }, { kind: "set-role", userId: member.userId, role: member.role === "owner" ? "member" : "owner" })}>
              {member.role === "owner" ? t("security.makeMember", "Make Member") : t("security.makeOwner", "Make Owner")}
            </Button>
            <Button className="quiet-danger-button" onClick={() => onAction({
              title: t("security.removeTitle", "Remove {name}?", { name: member.displayName }),
              description: t("security.leaveConfirmBody", "You will immediately lose access to this Team and its Projects."),
              confirmLabel: t("security.removeMember", "Remove member"),
              danger: true
            }, { kind: "remove-member", userId: member.userId })}>{t("security.remove", "Remove")}</Button>
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
  onSignOut,
  rawCaptureSettings
}: {
  readonly user: User
  readonly state: LoadView<TeamAccess>
  readonly action: ActionView<void | JoinCodeGrant>
  readonly onRetry: () => void
  readonly onAction: (input: TeamAccessAction) => void
  readonly onReauthenticate: () => void
  readonly onSignOut: () => void
  readonly rawCaptureSettings?: ReactNode
}) => {
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    readonly copy: Confirmation
    readonly action: TeamAccessAction
  }>()
  const [copyStatus, setCopyStatus] = useState("")
  useEffect(() => {
    if (action._tag === "Succeeded" || action._tag === "Failed") setPendingConfirmation(undefined)
  }, [action._tag])
  if (state._tag === "Loading") return <div className="settings-loading" role="status">{t("security.loadingTeamAccess", "Loading Team access…")}</div>
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
              ? { onRetry: onReauthenticate, retryLabel: t("security.confirmSignIn", "Confirm sign-in") }
              : {})}
          />
        )}
        <header className="settings-heading">
          <Eyebrow>{access.team.displayName}</Eyebrow>
          <h1>{t("security.teamAndAccess", "Team & access")}</h1>
          <p>{t("security.teamAndAccessBody", "Review members and keep at least one Owner responsible for this Team.")}</p>
        </header>

        {rawCaptureSettings}
        {owner && joinCode !== undefined && (
          <section className="settings-section" aria-labelledby="join-code-title">
            <header>
              <div><h2 id="join-code-title">{t("security.joinCodeTitle", "Team join code")}</h2><p>{t("security.joinCodeBody", "Anyone with an active code can join as a Member.")}</p></div>
              <Badge tone={joinCode.enabled ? "success" : "neutral"}>{joinCode.enabled ? t("security.active", "Active") : t("security.disabled", "Disabled")}</Badge>
            </header>
            <div className="join-code-panel">
              <div>
                {newGrant !== undefined ? (
                  <>
                    <div className="join-code"><code>{newGrant.code}</code><span>{t("security.caseInsensitive", "case-insensitive")}</span></div>
                    <p className="one-time-note" role="status"><strong>{t("security.copyNow", "Copy this now.")}</strong> {t("security.copyOnce", "It will not be shown again.")}</p>
                  </>
                ) : joinCode.enabled ? (
                  <p><strong>{t("security.joinCodeActive", "A join code is active.")}</strong><br /><span className="muted-copy">{t("security.joinCodeRotationNote", "For safety, its value is shown only immediately after rotation.")}</span></p>
                ) : <p><strong>{t("security.joinCodeDisabled", "New members cannot join by code.")}</strong></p>}
              </div>
              <div className="join-code-actions">
                {newGrant !== undefined && <Button onClick={() => void navigator.clipboard.writeText(newGrant.code).then(
                  () => setCopyStatus(t("security.joinCodeCopied", "Join code copied")),
                  () => setCopyStatus(t("security.copyFailed", "Copy failed; select the code manually"))
                )}>{t("security.copy", "Copy")}</Button>}
                <Button variant={joinCode.enabled ? "secondary" : "primary"} onClick={() => confirm({
                  eyebrow: t("security.freshConfirmation", "Fresh confirmation"),
                  title: joinCode.enabled ? t("security.rotateConfirmTitle", "Rotate the Team join code?") : t("security.enableConfirmTitle", "Enable joining by code?"),
                  description: joinCode.enabled
                    ? t("security.rotateConfirmBody", "The current code will stop working immediately.")
                    : t("security.enableConfirmBody", "Anyone with the new code can join this Team as a Member."),
                  confirmLabel: joinCode.enabled ? t("security.rotateCode", "Rotate code") : t("security.createNewCode", "Create new code")
                }, { kind: "rotate-code" })}>{joinCode.enabled ? t("security.rotate", "Rotate") : t("security.createNewCode", "Create new code")}</Button>
                {joinCode.enabled && <Button className="quiet-danger-button" onClick={() => confirm({
                  title: t("security.disableConfirmTitle", "Disable joining by code?"),
                  description: t("security.disableConfirmBody", "The current code will stop working immediately. Existing members keep their access."),
                  confirmLabel: t("security.disableCode", "Disable code"),
                  danger: true
                }, { kind: "disable-code" })}>{t("security.disable", "Disable")}</Button>}
              </div>
            </div>
            {copyStatus !== "" && <p className="copy-status" role="status">{copyStatus}</p>}
          </section>
        )}

        <section className="settings-section" aria-labelledby="members-title">
          <header>
            <div><h2 id="members-title">{t("security.members", "Members")}</h2><p>{t("security.membersBody", "Owners manage people and Team security. Members can create and use Projects.")}</p></div>
            <Badge>{t("security.peopleCount", "{count} people", { count: access.members.length })}</Badge>
          </header>
          {access.members.map((member) => <MemberRow
            key={member.userId}
            member={member}
            currentUserId={user.id}
            owner={owner}
            onlyOwner={onlyOwner}
            onAction={confirm}
          />)}
          {onlyOwner && <p className="owner-note"><strong>{t("security.onlyOwnerStrong", "You are the only Owner.")}</strong> {t("security.onlyOwnerBody", "Make another member an Owner before leaving.")}</p>}
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
