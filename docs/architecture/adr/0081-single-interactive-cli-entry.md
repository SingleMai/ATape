# ADR-0081: One interactive ATape entry

- Status: Accepted
- Date: 2026-09-13
- Current guide: [CLI setup and Adapters](../../cli/setup-and-adapters.md)

## Alternatives and decision

Keeping explicit business commands alongside the console preserves scripting, but
maintains two Presentation Interfaces, duplicate help and command recovery paths.
Hiding those commands from help still leaves their Implementation and compatibility
cost. The user requested removal of that surface, rather than a compatibility layer.

Use `atape` as the only public operational entry. Keep help/version and session
language/no-browser flags. Projects, Tools and Settings own user navigation;
application Modules retain business rules behind their existing Effect Interfaces.
This reduces the Interface users must learn and improves Locality of presentation.
No new production Seam or workflow engine is introduced.

Remove business command parsing, handlers, command-only rendering and their tests.
Integration maintenance (trusted package/path installation, original-source refresh,
preview/confirmed cleanup) lives under Tools. Language persistence lives in Settings.
Diagnostics display all source failures retained in the bounded report, with
pagination; report truncation remains explicit. Cleanup retains one inactive version
per package and rechecks eligibility at apply through the existing Module Interface.

The process owner's token-bound internal Collector entry remains private and absent
from help. It is not an automation API. Exiting the console leaves background sync
running. Unsupported terminals, CI and redirected input/output fail without mutation;
Windows and public one-shot/JSON collection are no longer supported. No compatibility
aliases, external supervisor Interface or reboot persistence is added.

## Verification and consequences

Verify the installed executable through a PTY for setup, authorization, maintenance,
status, stop and terminal cleanup. Test invalid public input before network/persistence.
Module and Adapter contract tests exercise collection directly; test fixtures may
seed disposable integrations but are never shipped as hidden user commands. Release
Adapter tests must distinguish source Host checks from installed executable checks.

This supersedes the explicit-command retention in [ADR-0036](0036-ink-cli-experience.md)
and the public command grammar/cleanup flags in [ADR-0080](0080-cli-input-and-adapter-slot-lifetime.md).
Their Effect ownership, installation leases and Collector lifetime rules remain.
Publication, integration and deployment are separate actions.
