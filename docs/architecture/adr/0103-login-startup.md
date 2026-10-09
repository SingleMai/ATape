# ADR-0103: User login startup and durable sync intent

Status: Accepted

Date: 2026-10-09

Amends [ADR-0100](0100-managed-automatic-updates.md) for login startup. The
[setup guide](../../cli/setup-and-adapters.md) owns supported behavior and
verification limits; this decision does not establish release or OS acceptance.

## Context and constraints

Collection and automatic update checks currently depend on a running CLI or
Collector. The user requested login startup, enabled by default during
initialization and switchable in Settings. Closing the console continues sync;
an explicit Stop must survive logout, reboot, update recovery and later login.
Registration must neither authorize additional capture nor open a terminal or
browser. It uses the current user's permissions, without sudo or enabling linger.

## Interface and alternatives

1. Give launchd/systemd the Collector executable and automatic restart policy.
   This conflicts with the independent updater's bounded pause and version
   selection, and duplicates the existing token/PID ownership Implementation.
2. Have the OS invoke a short login coordinator which recovers any interrupted
   handoff and calls the existing Collector resume Interface. This is selected.
   Native registration and its observed status belong behind a LoginStartup
   Module; the Collector Module owns durable running intent and process locks.
3. Add a permanently running supervisor which reconciles sync and update state.
   That could provide crash supervision but adds another long-lived owner and
   failure policy. Continuous supervision is outside this increment.

The selected Module exposes preference/status, reconciliation and login resume
operations. Its OS Adapter hides descriptor generation, installation identity,
bounded native commands and platform differences. The external OS manager is a
real Seam; controlled command Adapters and native descriptor/manager acceptance
exercise the same Interface. Depth and Leverage keep process choreography out of
Presentation. Locality keeps sync intent inside the existing Collector Module.

## Sync intent and admission

Explicit Start durably records running intent and interval/concurrency before
launching; explicit Stop durably clears it even when no process remains. Resume
reads it under the same short process lock and never turns a stopped intent on.
Maintenance pause, rollback and recovery leave this intent intact. A missing
legacy intent inherits only a confirmed owned running process or a retained
maintenance resume; an absent or stale PID alone does not authorize startup.
An established running intent also retains process metadata through crashes and
maintenance pause. A missing established marker without maintenance resume is
treated as an external Stop. This preserves the Stop operation of an already
open pre-feature console, which deletes that marker but cannot write new intent.
An initial failed Start remains unestablished and can retry. A pre-feature Start
cannot override a newer durable Stop; the user must reopen the current CLI.
Manual npm upgrade pauses and resumes through that same Interface. A retained
upgrade receipt cannot override a later Stop or the current saved schedule.

Login validates the local registration token, configured tools and preference,
then synchronously reconciles pending updates under existing update ownership.
An active updater causes a bounded retry rather than opening collection
admission early. The Coordinator resumes locally validated configured work and
never performs interactive sign-in or depends on network readiness. Collection
keeps its ordinary credential checks and checkpoint/journal recovery.

Registration binds absolute Node and npm installation ownership. The OS invokes
an owner-only, atomically replaced bundled coordinator under `startup/atape.mjs`,
outside managed version directories. This is necessary because an older npm
bootstrap cannot parse a newly introduced internal startup argument. The copy
delegates after admission only when the selected package declares
`atapeRuntime.loginStartupProtocol=atape.login-startup.v1`. The final process holds
update ownership across recovery, renewed admission and resume; a delegated child
acquires its own ownership after the parent hands off. An incapable retained
selection makes startup inert, because its Stop operation cannot maintain the
new durable intent. Reconciliation refreshes the copy from a capable
bundle, and never replaces it with an incapable older selection. Collector launch
resolves the selected runtime each time. Registration
and preference are separate facts: an enabled preference with an unavailable OS
manager must be visible as unavailable, rather than reported installed. Disabling
first persists the preference, so queued old entries cannot resume collection.
It removes future startup registration while retaining current sync intent and
running collection. The existing Stop operation controls current sync.
Registration waits until pending update recovery has completed, closing the first
upgrade window in which an older worker might still restore a pre-feature runtime.

## OS lifetime and security

macOS uses one user LaunchAgent per canonical ATape home with RunAtLoad. Linux
uses a user systemd oneshot with RemainAfterExit=yes. A detached Node child stays
in its systemd cgroup; keeping the successful unit active prevents helper exit
from cleaning up the Collector or independent updater. Failure retries use a
bounded native restart delay. This does not supervise a Collector after a
successful login handoff.
On macOS, detached Collector/updater launches establish separate process groups;
the coordinator and delegated child remain joined and retain ordinary launchd
process-group cleanup. No broad AbandonProcessGroup exemption is needed.

Linux disable never uses --now or stops the active unit: only future enablement
and the owned descriptor are removed, followed by daemon-reload. Normal cgroup
cleanup remains in place at user-manager shutdown. macOS removes only its own
service target. Neither Adapter changes a whole domain or installs a root service.

Descriptors, the coordinator copy and registration metadata use owner-only files,
atomic replacement, safe argv/OS escaping and a whitelist of required environment
values. Explicit redaction values and proxy/CA context stay in private metadata,
outside the OS descriptor. Later shells retain these values unless explicitly
overridden or cleared. They do not persist an entire shell environment,
ATape account credentials, NODE_OPTIONS or conversation data. Unknown files and symlinks are
not overwritten. Missing Node/bootstrap
paths, npm ownership changes or unavailable user managers require visible repair;
opening the CLI reconciles registration again. Replacing/removing Node outside
ATape remains an external installation action, rather than something a copied
JavaScript launcher can repair while Node is absent.

## Verification and limits

Behavior checks must cover default-on initialization, disabled and queued startup,
absent intent, repeat login, Start/Stop races, preserved schedule, maintenance and
recovery ordering, and selected runtime launch. Native Adapter checks cover
descriptor argv/environment round trips, command deadlines, partial registration,
path escaping, unavailable managers and rejection of unknown/symlink files.
Installed-package checks exercise a headless entry without a TTY or browser.

Real plutil/systemd-analyze checks prove descriptor parsing only. Real isolated
OS registration is required to establish native manager and cgroup behavior;
controlled commands are not that evidence. Record each check actually run and
any unverified OS login, power-loss or provider-delivery scenario in the guide.
This increment does not introduce Windows startup, a root boot daemon, continuous
Collector crash supervision, remote maintenance or log recall.
