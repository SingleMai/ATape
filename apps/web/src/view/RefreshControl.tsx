import { Button } from "@atape/ui"
import type { ReactNode } from "react"
import type { RefreshCadence, RefreshSettingsView } from "../presenters/memoryPresenter"
import { t, type WebMessageKey } from "../i18n"

const refreshOptions: ReadonlyArray<{
  readonly value: RefreshCadence
  readonly labelKey: WebMessageKey
}> = [
  { value: "manual", labelKey: "refresh.off" },
  { value: "30_seconds", labelKey: "refresh.every30Sec" },
  { value: "1_minute", labelKey: "refresh.everyMinute" },
  { value: "5_minutes", labelKey: "refresh.every5Min" }
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
    <div className="refresh-control-actions" role="group" aria-label={t("refresh.controls", "Refresh controls")}>
      <Button className="refresh-now" pending={refreshing} onClick={onRefresh}>
        <span className="refresh-icon" aria-hidden="true">↻</span>
        <span>{t("refresh.refresh", "Refresh")}</span>
      </Button>
      <label className="refresh-cadence">
        <span>{t("refresh.autoRefresh", "Auto refresh")}</span>
        <select
          aria-label={t("refresh.interval", "Automatic refresh interval")}
          value={settings.cadence}
          onChange={(event) => {
            const option = refreshOptions.find(({ value }) => value === event.currentTarget.value)
            if (option !== undefined) settings.setCadence(option.value)
          }}
        >
          {refreshOptions.map((option) => (
            <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
          ))}
        </select>
      </label>
    </div>
    <span
      className={`refresh-control-status${refreshFailure === undefined ? "" : " refresh-control-status--error"}`}
      role="status"
      title={refreshFailure}
    >
      {refreshFailure === undefined ? status : t("refresh.failed", "Refresh failed · showing previous data")}
    </span>
  </div>
)
