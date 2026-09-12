# CLI synchronization dashboard

Settings → atape-cli shows each authorized installation by its reported hostname, platform/architecture and CLI version. The collapsed row shows identity, sync status and available CLI updates. Expand a device for Adapter package names, installed versions, update availability and synchronization results. Multiple projects using an Adapter share one row with expandable project details; a failed project is never hidden by a successful one. Older reports without package names show their Adapter ID. Disconnect is inside the expanded device, with the existing confirmation dialog. Existing credentials with no report remain identifiable by credential ID. Revocation uses the existing confirmation and authorization flow. No remote CLI control is provided.

## State and reporting

The managed Collector owns a scoped monitoring fiber. It sends a report about every 30 seconds independently of ingestion, so an idle collector still reports. A best-effort exit report is limited to five seconds. Reporting or version lookup failures do not block collection. Authentication stores the server receipt time separately from credential activity. Ordinary API requests and malformed reports never refresh sync liveness or erase the previous sync snapshot.

The Web refreshes every 30 seconds while account settings are mounted and offers a manual Refresh button. Reports older than two minutes show Status expired, retaining the last details. An expired report does not assert that the machine is broken: sleep, network disconnection and stopped processes are all possible. Fresh reports distinguish syncing, up to date, backlog, pending setup, stopped, and jobs needing attention. Version updates are independent of sync health.

The report includes configured project names/IDs, Adapter IDs, last attempt/success times, whether more content remains, and stable failure categories. Raw error messages, source paths, credentials and conversation contents are excluded. Jobs are scoped to the authenticated account and instance. Failed/partial and backlogged jobs are prioritized; at most 20 jobs and 32 Adapters fit in the bounded report. Additional size trimming is explicit in the UI; a truncated report is never labeled fully healthy. Open ATape locally and use Projects → Sync details for the local job list and bounded source diagnostics.

The collector retains successful job timestamps during a run. Managed-collector local status seeds the next report after restart; partial legacy statuses do not establish full success. Unreported or unavailable values are shown as unknown.

## Versions

The CLI checks official npm packages using the existing bounded release reader/cache (up to 12 hours). A running reporter attempts lookup at most hourly. The Web compares numeric stable versions, shows update availability, and directs users to open ATape → Tools and updates locally. It shows the version-check time. Offline devices retain their last reported version knowledge; unavailable registry data is unknown, never asserted current. Third-party Adapter updates are not checked.

## Delivery and limitations

Apply migration 000011 before starting the updated server. Older clients omit the additive report header; older servers ignore it. Device inventory is per credential, so multiple logins on a machine appear separately. Multiple collector processes using one credential are last-report-wins. Login without running collection does not establish live sync state. Force-killed/disconnected processes age out instead of sending a stopped report. This change does not publish packages or deploy an instance.

A future increment can add installation deduplication, process ownership fencing and paginated complete job inventories. No command channel is planned for this dashboard.
