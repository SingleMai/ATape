# ADR-0024: Claude Origin Project Attribution

- Status: Accepted design; see ADR-0029 for the implemented subset
- Date: 2026-09-07

Claude Code can change working directory and relocate a transcript during the same Session. ATape attributes the conversation using its Session Origin CWD and the user's explicit local Project binding. Once established, the attribution remains fixed across `/cd`, resume, and transcript relocation. Collection continues after `/cd`, including subsequent conversation content; a directory change alone does not split, migrate, stop, or degrade the Captured Session.

A Directory Project matches its explicitly bound directory scope after filesystem path resolution. A Git Project matches the bound repository identity, including linked worktrees whose paths are outside the configured checkout. Paths locate Git repositories; directory containment alone does not prove Git Project membership. Discovery does not choose a destination by fuzzy matching among all configured Projects.

## Consequences

- One Captured Session remains a continuous conversation in its original Project, even when Claude later works in another directory. The capture unit is the conversation, not a per-message file-access boundary.
- A transcript's current location and latest record CWD are insufficient to reconstruct its origin. A newly discovered Session needs trustworthy origin evidence; missing evidence follows the existing reported-and-skipped attribution policy.
- Establishing origin must distinguish a fork's own start from any copied prefix. Automatic continuation inherits the logical conversation's established origin; a genuinely new fork needs evidence for its own origin. The exact source-field rules require current-version fixtures.
- Source identity and committed attribution must survive relocation and retries. The identity and checkpoint decisions specify the representation and recovery rules; file paths must not silently reassign already captured history.
- Raw retains the source's working-directory changes, subject to the existing Collector redaction policy.

## Alternatives considered

Using the latest CWD would move a conversation as the user works. Rejecting multi-directory Sessions or stopping at `/cd` would make ordinary continuation produce incomplete capture. The chosen origin rule keeps attribution predictable under the user's explicit Project configuration.
