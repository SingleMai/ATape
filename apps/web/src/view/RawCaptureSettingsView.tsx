import type { RawCapturePolicy, RawCapturePreference, RawCaptureSettings } from "@atape/application"
import type { ActionView, LoadView } from "../presenters/accessPresenter"

type Shared<A> = {
  readonly state: LoadView<A>
  readonly action: ActionView<A>
  readonly reload: () => void
}
const Status = <A,>({ state, action, reload }: Shared<A>) => <>
  {state._tag === "Loading" && <p role="status">Loading Raw capture settings…</p>}
  {state._tag === "Failed" && <p role="alert">{state.failure.message} <button onClick={reload}>Retry</button></p>}
  {action._tag === "Failed" && <p role="alert">{action.failure.message}</p>}
  {action._tag === "Pending" && <p role="status">Saving…</p>}
  {action._tag === "Succeeded" && <p role="status">Saved.</p>}
</>
export const UserRawCaptureSettingsView = (props: Shared<{ readonly preference: RawCapturePreference }> & {
  readonly save: (preference: RawCapturePreference) => void
}) => <section className="settings-section" aria-labelledby="user-raw-title">
  <header><div><h2 id="user-raw-title">Raw source upload</h2>
    <p>Upload original source files for diagnostics. Raw files can be large; enabling also uploads retained local history. Conversation capture and search continue when disabled.</p>
    <p>This preference applies across this instance, only in Teams using Personal. Team Force and Close policies override it.</p></div></header>
  {props.state._tag === "Ready" && <label>Personal preference{" "}
    <select aria-label="Personal Raw upload preference" value={props.state.value.preference}
      disabled={props.action._tag === "Pending"} onChange={e => props.save(e.target.value as RawCapturePreference)}>
      <option value="disable">Disable</option><option value="enable">Enable</option>
    </select></label>}
  <Status {...props} />
</section>

export const TeamRawCaptureSettingsView = (props: Shared<typeof RawCaptureSettings.Type> & {
  readonly owner: boolean
  readonly save: (policy: RawCapturePolicy) => void
}) => <section className="settings-section" aria-labelledby="team-raw-title">
  <header><div><h2 id="team-raw-title">Raw source upload</h2>
    <p>Force uploads Raw for everyone. Personal follows each user's preference. Close disables Raw uploads for this Team.</p>
    <p>Conversation capture and search continue under every policy. Previously uploaded Raw remains available. Enabling also uploads retained local history.</p></div></header>
  {props.state._tag === "Ready" && <>
    <label>Team policy{" "}<select aria-label="Team Raw upload policy" value={props.state.value.teamPolicy}
      disabled={!props.owner || props.action._tag === "Pending"} onChange={e => props.save(e.target.value as RawCapturePolicy)}>
      <option value="force">Force</option><option value="personal">Personal</option><option value="close">Close</option>
    </select></label>
    <p>Raw upload for you: <strong>{props.state.value.enabled ? "Enabled" : "Disabled"}</strong></p>
    {!props.owner && <p>Only Team Owners can change this policy.</p>}
  </>}
  <Status {...props} />
</section>
