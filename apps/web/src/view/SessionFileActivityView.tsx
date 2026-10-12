import type { SessionAnalyticsFilter } from "@atape/application"
import type { SessionAnalytics } from "@atape/domain"
import { useId } from "react"
import { formatNumber, t } from "../i18n"

type FileActivity = Extract<SessionAnalytics, { analyticsVersion: 4 }>["fileActivity"]

export function SessionFileActivityView({ report, thread, onFilter }: {
  readonly report: FileActivity | undefined
  readonly thread?: string
  readonly onFilter: (filter: SessionAnalyticsFilter) => void
}) {
  const id = useId()
  const filter = (selection: SessionAnalyticsFilter) => onFilter({ metric: "files", ...selection, ...(thread ? { thread } : {}) })
  return <section aria-labelledby={`${id}-files`}>
    <h2 id={`${id}-files`}>{t("analytics.fileActivity", "Recorded file activity")}</h2>
    {report === undefined ? <p>{t("analytics.fileActivityUnavailable", "This Server does not provide file activity yet.")}</p> : <>
      <dl className="analytics-summary">
        <div><dt>{t("analytics.callsWithActivity", "Calls with usable file activity")}</dt><dd>{formatNumber(report.callsWithActivity)}</dd></div>
        <div><dt>{t("analytics.callsWithoutActivity", "Calls without usable file activity")}</dt><dd>{formatNumber(report.callsWithoutActivity)}</dd></div>
        <div><dt>{t("analytics.uniquePaths", "Distinct recorded paths")}</dt><dd>{formatNumber(report.uniquePaths)}</dd></div>
        {(["read", "edit", "search"] as const).map(operation => <div key={operation}>
          <dt>{t(`analytics.fileOperation.${operation}`)}</dt><dd><button type="button" className="analytics-link"
            aria-label={t("analytics.fileOperationEvidence", "File evidence: {operation}", { operation: t(`analytics.fileOperation.${operation}`) })}
            onClick={() => filter({ operation })}>{formatNumber(report[`${operation}Calls`])}</button></dd>
        </div>)}
      </dl>
      <p className="analytics-note">{t("analytics.fileActivityMeaning", "These are recorded tool calls, including failed or unfinished calls, not confirmed filesystem changes. Search paths describe search scope, not matching files. Repeated updates of a call are counted once.")}</p>
      <p className="analytics-note">{t("analytics.fileActivityCoverage", "Calls without usable file activity include older records, unsupported source signals and paths removed by redaction. This does not establish that no files were used. Counts cover the Session; filters only select evidence.")}</p>
      {report.paths.length === 0 ? <p>{t("analytics.noFilePaths", "No usable file paths were recorded.")}</p> :
        <div className="analytics-table-scroll"><table><thead><tr>
          <th scope="col">{t("analytics.filePath", "Path")}</th><th scope="col">{t("analytics.calls", "Calls")}</th>
          {(["read", "edit", "search"] as const).map(operation => <th key={operation} scope="col">{t(`analytics.fileOperation.${operation}`)}</th>)}
        </tr></thead><tbody>{report.paths.map(item => <tr key={item.key}>
          <th scope="row"><button type="button" className="analytics-link" onClick={() => filter({ file: item.key })}
            aria-label={t("analytics.filePathEvidence", "File evidence: {path}", { path: item.path })}>{item.path}</button></th>
          <td>{formatNumber(item.calls)}</td>
          {(["read", "edit", "search"] as const).map(operation => <td key={operation}><button type="button" className="analytics-link"
            aria-label={t("analytics.filePathOperationEvidence", "File evidence: {operation} · {path}", { operation: t(`analytics.fileOperation.${operation}`), path: item.path })}
            onClick={() => filter({ file: item.key, operation })}>{formatNumber(item[`${operation}Calls`])}</button></td>)}
        </tr>)}</tbody></table></div>}
    </>}
  </section>
}
