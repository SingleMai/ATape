import type { RawCapturePolicy, RawCapturePreference, RawCaptureSettings } from "@atape/application"
import type { ActionView, LoadView } from "../presenters/accessPresenter"
import { t } from "../i18n"

type Shared<A> = {
  readonly state: LoadView<A>
  readonly action: ActionView<A>
  readonly reload: () => void
}
const Status = <A,>({ state, action, reload }: Shared<A>) => <>
  {state._tag === "Loading" && <p role="status">{t("rawCapture.loading", "Loading Raw capture settings…")}</p>}
  {state._tag === "Failed" && <p role="alert">{t(state.failure.messageKey)} <button onClick={reload}>{t("rawCapture.retry", "Retry")}</button></p>}
  {action._tag === "Failed" && <p role="alert">{t(action.failure.messageKey)}</p>}
  {action._tag === "Pending" && <p role="status">{t("rawCapture.saving", "Saving…")}</p>}
  {action._tag === "Succeeded" && <p role="status">{t("rawCapture.saved", "Saved.")}</p>}
</>
export const UserRawCaptureSettingsView = (props: Shared<{ readonly preference: RawCapturePreference }> & {
  readonly save: (preference: RawCapturePreference) => void
}) => <section className="settings-section" aria-labelledby="user-raw-title">
  <header><div><h2 id="user-raw-title">{t("rawCapture.title", "Raw source upload")}</h2>
    <p>{t("rawCapture.userBody", "Upload original source files for diagnostics. Raw files can be large; enabling also uploads retained local history. Conversation capture and search continue when disabled.")}</p>
    <p>{t("rawCapture.userNote", "This preference applies across this instance, only in Teams using Personal. Team Force and Close policies override it.")}</p></div></header>
  {props.state._tag === "Ready" && <label>{t("rawCapture.personalPreference", "Personal preference")}{" "}
    <select aria-label={t("rawCapture.personalPreferenceLabel", "Personal Raw upload preference")} value={props.state.value.preference}
      disabled={props.action._tag === "Pending"} onChange={e => props.save(e.target.value as RawCapturePreference)}>
      <option value="disable">{t("rawCapture.disable", "Disable")}</option><option value="enable">{t("rawCapture.enable", "Enable")}</option>
    </select></label>}
  <Status {...props} />
</section>

export const TeamRawCaptureSettingsView = (props: Shared<typeof RawCaptureSettings.Type> & {
  readonly owner: boolean
  readonly save: (policy: RawCapturePolicy) => void
}) => <section className="settings-section" aria-labelledby="team-raw-title">
  <header><div><h2 id="team-raw-title">{t("rawCapture.title", "Raw source upload")}</h2>
    <p>{t("rawCapture.teamBody", "Force uploads Raw for everyone. Personal follows each user's preference. Close disables Raw uploads for this Team.")}</p>
    <p>{t("rawCapture.teamNote", "Conversation capture and search continue under every policy. Previously uploaded Raw remains available. Enabling also uploads retained local history.")}</p></div></header>
  {props.state._tag === "Ready" && <>
    <label>{t("rawCapture.teamPolicy", "Team policy")}{" "}<select aria-label={t("rawCapture.teamPolicyLabel", "Team Raw upload policy")} value={props.state.value.teamPolicy}
      disabled={!props.owner || props.action._tag === "Pending"} onChange={e => props.save(e.target.value as RawCapturePolicy)}>
      <option value="force">{t("rawCapture.force", "Force")}</option><option value="personal">{t("rawCapture.personal", "Personal")}</option><option value="close">{t("rawCapture.close", "Close")}</option>
    </select></label>
    <p>{t("rawCapture.forYou", "Raw upload for you:")} <strong>{props.state.value.enabled ? t("rawCapture.enabled", "Enabled") : t("rawCapture.disabled", "Disabled")}</strong></p>
    {!props.owner && <p>{t("rawCapture.ownerOnly", "Only Team Owners can change this policy.")}</p>}
  </>}
  <Status {...props} />
</section>
