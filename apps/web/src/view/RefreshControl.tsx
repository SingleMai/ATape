import { Button } from "@atape/ui"
import type { ReactNode } from "react"
import type { RefreshCadence, RefreshSettingsView } from "../presenters/memoryPresenter"

const refreshOptions: ReadonlyArray<{
  readonly value: RefreshCadence
  readonly label: string
}> = [
  { value: "manual", label: "Off" },
  { value: "30_seconds", label: "Every 30 sec" },
  { value: "1_minute", label: "Every minute" },
  { value: "5_minutes", label: "Every 5 min" }
]

type Props = {
  readonly settings: RefreshSettingsView
  readonly refreshing: boolean
  readonly refreshFailure?: string | undefined
  readonly status: ReactNode
  readonly onRefresh: () => void
}

export const RefreshControl = ({
  settings,
  refreshing,
  refreshFailure,
  status,
  onRefresh
}: Props) => (
  <div className="refresh-control">
    <div className="refresh-control-actions" role="group" aria-label="Refresh controls">
      <Button className="refresh-now" pending={refreshing} onClick={onRefresh}>
        <span className="refresh-icon" aria-hidden="true">↻</span>
        <span>Refresh</span>
      </Button>
      <label className="refresh-cadence">
        <span>Auto refresh</span>
        <select
          aria-label="Automatic refresh interval"
          value={settings.cadence}
          onChange={(event) => {
            const option = refreshOptions.find(({ value }) => value === event.currentTarget.value)
            if (option !== undefined) settings.setCadence(option.value)
          }}
        >
          {refreshOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    </div>
    <span
      className={`refresh-control-status${refreshFailure === undefined ? "" : " refresh-control-status--error"}`}
      role="status"
      title={refreshFailure}
    >
      {refreshFailure === undefined ? status : "Refresh failed · showing previous data"}
    </span>
  </div>
)
