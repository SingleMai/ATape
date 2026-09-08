# ADR-0040: Global CLI tools

Status: Accepted; implemented in the v0.4.0 candidate

## Decision

Tool selection belongs to one local ATape installation, across its connected
Projects and Instances. Project setup consumes the current global selection;
it does not configure Adapters. The CLI Experience Module owns impact planning,
installation, authorization checks and atomic configuration through Effect.

ATape has not launched publicly. Maintain one current configuration schema with
global enabledAdapterIds and a toolsConfigured marker for first-use navigation.
Persisted Project registrations contain identity, destination and locator fields,
without tool selections. The Client Module Interface provides an effective
collection view by combining registrations with the global selection. The
Collector and explicit commands consume that same rule.

There are no per-Project overrides, old configuration readers, migration prompts,
scoped enable/disable commands, automatic adoption or migration-triggered restarts.
Remove the former v0.1 local migration Module and XDG startup interception.
Existing development files are not automatically transformed or deleted.

An impact plan names every connected Project and added/removed tool. Its snapshot
is checked again before installation and inside the final configuration
transaction. Package installation alone never enables capture. Failure or
cancellation can leave inert packages installed, but cannot partially apply the
selection. Checkpoints, identities and server history remain unchanged.

Project connection reviews bind the global selection. A concurrent tool change
invalidates that review rather than connecting with unreviewed tools. Explicit
tools configuration offers a read-only preview and an --apply action.

## Presentation and delivery

Home owns Projects, Tools, Settings and a stopped-sync recovery action. Project
details own outcomes and issue-specific recovery, with secondary disconnection.
Accounts and Adapter updates are global flows with a return destination.
Refresh is read-only and available through r. The cassette stays in the shared
header. Presentation does not implement persistence or retries.

Tests exercise existing Client, Project setup and Collector Interfaces: subsequent
Projects, stale plans, failed installation, checkpoint preservation, removed
scoped commands and installed-package terminal navigation. Global Collector/account
isolation, Server deployment and automatic reboot recovery are outside this increment.
