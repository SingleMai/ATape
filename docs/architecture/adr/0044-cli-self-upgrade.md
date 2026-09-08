# ADR-0044: CLI upgrade and startup update choice

Status: Accepted; implemented, awaiting publication.

## Decision

The CLI Upgrade Module exposes `checkCLIUpgrade(current)` and
`upgradeCLI(current)`. The first returns an optional newer stable version and
silences expected check failures. The second checks fresh metadata, installs a
pinned newer CLI release, verifies its executable version, and resumes the
current home's Collector only when it was already running. It preserves that
Collector's interval and concurrency. It never downgrades or reinstalls an equal
version and rejects development builds. Errors distinguish checking,
installation ownership, package installation and post-install sync recovery.
Recovery failures carry a receipt containing the installed version and original
sync parameters. `resumeCLIUpgrade(receipt)` retries only that handoff, retaining
the receipt on repeated failure; it never queries npm or reinstalls the package.
This explicit continuation keeps recovery decisions in the Module rather than
reconstructing lost process state in presentation or repeating the whole upgrade.

The external npm registry and package manager form the `CLIUpgradePlatform`
Seam. Its Node Adapter hides metadata validation, bounded reads, a twelve-hour
private cache, installation ownership, a filesystem installation lock and npm
execution. Startup network requests time out after 1.5 seconds; explicit checks
after ten seconds. npm subprocesses have a three-minute timeout and installed
version verification has a fifteen-second timeout. Effect owns cancellation;
the installation callback's Effect finalizer aborts and joins the owned task.
Cancellation requests SIGTERM, escalates to SIGKILL after one second if needed,
and waits for process completion before releasing the installation lock. The
command's interruption cannot finish before that cleanup. After successful installation, the
existing bounded Collector stop/start handoff completes without interruption.

The Adapter only updates the active npm global installation whose real entry
path matches the running CLI. It pins the verified version and prefix, disables
lifecycle scripts, enforces Node engine requirements, and verifies the installed
binary. It does not infer ownership of pnpm, Homebrew, npx or repository builds.
The old Collector remains running until package installation succeeds.

Presentation waits for one bounded check before reading Projects and opening
the welcome, console or setup flow. If an update is available, it presents an
explicit Upgrade/Skip choice. Skip applies only to this session; Escape exits.
After successful upgrade, presentation requests a restart. The Composition Root
restores the terminal and disposes the old runtime before its Node Adapter opens
the installed executable with the original arguments, working directory and
environment. The parent owns the child lifetime and propagates signals and exit
status. The old process pauses stdin before starting the child so it cannot
consume the new process's keyboard input. A failed installation offers Retry/Skip;
a failed sync handoff offers Resume sync/Skip. Skipping after installation opens
the new executable with sync still stopped. Explicit commands, including JSON
output and background collection, do not present this choice.

## Alternatives and depth

1. Print npm instructions and require manual sync stop/start. This keeps a small
   implementation but shifts package and process knowledge to every user.
2. A universal installer that downloads and replaces executable files itself.
   This duplicates package manager ownership and recovery across distributions.
3. The selected Module delegates acquisition to the owning npm installation and
   hides acquisition and recovery behind a small Interface. This provides Depth and Leverage
   without a general installer framework. Locality keeps rendering in the CLI
   and filesystem/process details in the Node Adapter. Deleting this Module
   would spread comparison, failure policy and sync ordering into callers.

## Verification and limits

Tests call the same Module Interface as presentation. Adapter tests use real
temporary paths and a controlled external npm executable; they never replace
the user's installation. Packaged PTY tests seed a future cached version and
verify blocking selection, Skip, continued navigation and clean noninteractive output.
A real subprocess test verifies restart arguments, environment and exit status.
Regression tests exercise a SIGTERM-resistant installer, lock exclusion while
cancellation is pending, cleanup completion, repeated failed sync recovery, and
the actual presenter Retry/Skip paths. A real PTY exercises Ink teardown and
three successive input handoffs to verify every key reaches the new process.

This increment upgrades the CLI only. Adapter packages retain their existing
explicit upgrade command. Only the selected ATAPE_HOME's Collector is resumed;
other homes are not discovered. Failed npm replacement has no atomic rollback
guarantee. A killed installer can leave a lock requiring manual removal. No
automatic update, restart-after-reboot feature, configuration compatibility or
migration is introduced. Broader package manager support is deferred until an
actual installation path requires it.
