# ADR-0047: Informational CLI device and sync monitoring

Status: Accepted

Settings must let users identify synchronization issues before opening their local CLI. No remote execution or control is provided.

Compare two Interfaces: (1) a standalone device registry with registration, identity deduplication and command channels; (2) bounded informational snapshots attached to each authorized CLI login, using the existing bearer HTTP Seam and owner-only inventory. Choose (2): Authentication owns report validation, persistence and receipt time; the Collector monitoring Module owns a scoped 30-second reporting loop and content-free progress projection. This preserves Locality, adds Depth by hiding lifecycle/aging rules, and gives the Web Leverage without exposing local logs or orchestration. A report never confers authority.

The optional CollectorDeviceGateway is a real remote Seam: library-only collection can omit monitoring, while the Node Composition Root supplies the authenticated HTTP Adapter. The monitoring fiber belongs to the collector lifetime, sends independently of content ingestion, and is interrupted on exit. A final best-effort stopped report has a bounded deadline. Report transport failures are logged but do not stop collection. Receipts older than two minutes are stale, not proof of a machine failure. Scope jobs to the authenticated account and instance; only stable failure categories are sent, never raw messages or paths. Bound reports and explicitly indicate truncated jobs.

The current-user read request carries an additive bounded report header, keeping old-server compatibility; ordinary metadata-only requests cannot refresh sync liveness or erase the last sync report. Per-credential inventory avoids new distributed identity semantics. Concurrent collector processes sharing one credential remain last-report-wins; process identity arbitration is deferred.

Official package versions use the existing bounded npm release reader and cache. Version lookup failure means unknown, not current. Update availability is informational and independent of sync health. The Web refreshes while the settings presenter is mounted, with explicit receipt timestamps and manual refresh. See ../../cli-devices.md for shipped scope.
