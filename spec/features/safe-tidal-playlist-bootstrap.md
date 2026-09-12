# Safe TIDAL Playlist Bootstrap

## Status

Proposed.

## Problem

xmsync stores its settings, playlist mappings, airplay ledger, and write-recovery state in a local SQLite database. The application is often run sequentially from different computers, so a computer may start with a fresh database while the authenticated TIDAL account already contains playlists created by xmsync on another computer.

The current exact-name adoption behavior is unsafe in this situation:

- The fresh database scans yesterday and today and has no record of previously handled xmplaylist play IDs.
- The application adopts a single owned playlist with the expected name.
- Existing playlist contents are not reconciled with the scanned airplays.
- Every newly scanned, matchable airplay is appended, including airplays already added by another computer.

This can create duplicate playlist occurrences even though the computers did not run concurrently.

## Goals

- Safely resume yesterday's and today's playlists from a fresh or otherwise missing local ledger.
- Infer a conservative resume frontier from the existing playlist's ordered track contents.
- Preserve manual playlist additions, removals, and reordering without deleting, moving, or restoring entries.
- Represent inferred prior work explicitly in local state and run reporting.
- Keep ordinary adoption conflicts isolated to one date while preserving run-wide handling for authorization loss, TIDAL rate limits, and ambiguous mutations.
- Use the existing TIDAL request pacing, retry, cooldown, and mutation-safety behavior.

## Non-Goals

- Sharing or synchronizing the SQLite database between computers.
- Exporting or importing application state.
- Recovering dates older than the existing yesterday-and-today scan window.
- Supporting computers configured with different local time zones.
- Preventing duplicates when multiple xmsync instances run concurrently.
- Reconstructing historical write batches or idempotency keys from TIDAL.
- Deleting, moving, replacing, or otherwise normalizing existing playlist items.

## Definitions

### Unknown playlist

An unknown playlist is an owned TIDAL playlist with the expected channel/date name for which the local database has no playlist mapping and no `synced` or `recovered` play rows for that channel and date.

This behavior is not limited to a completely empty database. It applies whenever xmsync encounters an otherwise eligible playlist whose prior state is unknown locally.

### Managed playlist identity

An unknown playlist is eligible for bootstrap only when all of the following are true:

- Exactly one playlist owned by the authenticated TIDAL user has the expected name `{Channel Name} - YYYY-MM-DD`.
- Its description exactly equals `SiriusXM plays from {Channel Name} on YYYY-MM-DD, synced from xmplaylist.com.`.
- Its access type is not `PUBLIC`.

The exact description distinguishes an xmsync-managed playlist from an unrelated playlist that happens to have the same name. Bootstrap does not modify the playlist's name, description, or visibility.

### Recovery frontier

The recovery frontier is the latest XM airplay selected by the reconciliation algorithm as already represented by an item in the existing TIDAL playlist. Airplays at or before this frontier are treated as previously handled. Matchable airplays after it remain eligible to append.

## Bootstrap Trigger

Normal local state remains authoritative when a valid playlist mapping and terminal play ledger already exist. Bootstrap is considered only when playlist discovery finds an unknown exact-name playlist.

If no exact-name playlist exists, xmsync creates a new unlisted playlist using the existing behavior. If a valid local mapping exists, xmsync validates and uses it through the existing behavior without reconstructing its ledger from playlist contents.

## Discovery and Eligibility

For each date containing at least one processable play:

1. Prefer a valid local channel/date playlist mapping as today.
2. If no mapping exists, discover owned playlists by exact expected name.
3. If no exact-name playlist exists, create a new unlisted playlist as today.
4. If multiple exact-name playlists exist, block bootstrap for that date because xmsync cannot choose safely.
5. If exactly one exists, validate its ownership, exact description, and access type.
6. If the description differs or the playlist is public, block bootstrap for that date.
7. If eligible, read all playlist items in TIDAL order and run reconciliation before persisting the mapping or appending items.

A failed eligibility check must not persist a playlist mapping. Otherwise, a later run could bypass bootstrap and append without a recovered ledger.

## Reconciliation Inputs

Reconciliation uses two ordered sequences:

- **XM sequence:** scanned plays for the channel and local date that resolved to a TIDAL track, ordered oldest-first by airplay time and then XM play ID.
- **Playlist sequence:** existing TIDAL track items in playlist order. Non-track resources, malformed items, and user-added items that do not participate in a match remain untouched and may be ignored by the matcher.

The TIDAL track ID is used only to align the sequences. The XM play ID remains the identity of an airplay in the local ledger. Repeated occurrences of the same TIDAL track are retained as separate sequence elements.

## Reconciliation Algorithm

The application computes a longest common subsequence between the playlist track IDs and the resolved XM track IDs.

The selected alignment must follow these deterministic rules in order:

1. Maximize the number of matched playlist/XM elements while preserving both sequences' order.
2. Among equally large alignments, choose the alignment whose final matched XM element is earliest.
3. If still tied, choose the lexicographically earliest sequence of matched XM indexes.
4. If still tied, choose the lexicographically earliest sequence of matched playlist indexes.

Choosing the earliest equally plausible frontier favors a possible duplicate append over silently omitting an airplay.

If the playlist is empty, bootstrap is blocked because xmsync cannot distinguish a never-populated playlist from one the user intentionally cleared. If the playlist is non-empty but the longest common subsequence is empty, bootstrap is also blocked because no resume frontier can be established.

When a non-empty alignment exists:

- The last matched XM play becomes the recovery frontier.
- Every scanned play for the date at or before the frontier receives the terminal `recovered` status and is not appended by this or a later run.
- Recovery supersedes provisional resolved, skipped, or failed outcomes from the current run for plays through the frontier. Those plays count only as recovered in final run totals.
- A recovered play selected by the alignment stores the playlist ID and the matched TIDAL occurrence/item ID when TIDAL supplies one.
- Other recovered plays store the playlist ID without inventing a TIDAL track ID or occurrence ID that was not established.
- An item missing before the frontier is presumed to have been skipped previously or removed manually and is not restored.
- Existing unmatched playlist items are preserved as manual or otherwise unknown additions.
- Processable, successfully resolved plays after the frontier are appended oldest-first through the normal write-batch path.

The adopted playlist mapping and all recovered play transitions must be committed in one synchronous SQLite transaction before the first new append. If the process stops after recovery but before append, the next run must retain the recovered frontier and append only still-processable later plays.

## Inference Limitations

TIDAL playlist items contain track identity but do not contain the originating XM play ID. Reconciliation therefore infers prior handling; it cannot prove it.

- A manual addition that uses the same track as an XM airplay can participate in the alignment and move the frontier.
- Repeated airplays can produce multiple equally large alignments. The earliest-frontier rules reduce the risk of silently omitting later airplays but may cause duplicate appends.
- A track resolving to a different TIDAL catalog ID on the new computer may not align with the item chosen by the previous computer.

The managed name and description are treated as the user's assertion that xmsync may perform this inference. Blocking empty and no-match playlists prevents writes when there is no evidence at all. This feature does not claim perfect reconstruction from arbitrary manually edited contents.

## Examples

In these examples, each letter represents a TIDAL track ID in chronological or playlist order.

### Manual removal

- XM sequence: `A B C D`
- Playlist sequence: `A C`
- Selected match: `A C`
- Frontier: `C`
- Result: `A`, `B`, and `C` are recovered; only `D` is appended. `B` is not restored.

### Manual addition

- XM sequence: `A B C D`
- Playlist sequence: `A X B C`
- Selected match: `A B C`
- Frontier: `C`
- Result: `X` remains untouched and only `D` is appended.

### Repeated track ambiguity

- XM sequence: `A B A C`
- Playlist sequence: `A`
- Two one-item alignments are possible.
- The first `A` is selected because it produces the earliest frontier.
- Result: the first `A` is recovered and `B A C` is appended.

### No evidence

- XM sequence: `A B C`
- Playlist sequence: `X Y`
- The longest common subsequence is empty.
- Result: the date is blocked and the playlist is not mutated.

## Persistence and Reporting

The persistence model must support a terminal `recovered` play status. Recovered plays are not returned by the processable-play query.

The database migration must preserve existing settings, tokens, playlist mappings, plays, run history, and write batches. It must add the recovered play state and recovered run count transactionally; startup must fail rather than silently replace a database if migration cannot complete.

Each sync run must record a `recovered` count separately from `synced`:

- `recovered` means the run inferred that an airplay had already been handled before this computer adopted the playlist.
- `synced` continues to mean the run successfully added a new playlist occurrence.
- A later run encountering a recovered play counts it as already processed under the existing behavior.

Successful bootstrap must produce date-level run details containing:

- Playlist name and ID.
- Recovery frontier play ID and airplay time.
- Number of recovered plays.
- Number of playlist items participating in the selected alignment.
- Number of later plays appended by the run.

Run details should not require one verbose warning row per recovered play. The UI must expose the recovered count and distinguish recovery from newly written items.

## Conflict and Failure Behavior

The following conditions block only the affected date and produce an actionable run error without mutating or mapping the conflicting playlist:

- Multiple owned playlists have the exact expected name.
- The single exact-name playlist has a missing or different description.
- The single exact-name playlist is public.
- The existing playlist is empty.
- No playlist item can be aligned with a resolved XM airplay for the date.

The application retries a blocked date during each later scheduled or manual run. Correcting the playlist, changing its visibility, or renaming it out of the way allows normal automatic recovery on the next run. A blocked yesterday playlist must not prevent a safe today playlist from being created, recovered, or appended during the same run.

Authorization failures, exhausted TIDAL rate limits, and unsafe or ambiguous mutations retain their existing broader behavior. In particular, a `429` stops further TIDAL processing for the run rather than being treated as a date-local adoption conflict.

Suggested error codes are:

- `PLAYLIST_NAME_AMBIGUOUS`
- `PLAYLIST_DESCRIPTION_MISMATCH`
- `PLAYLIST_PUBLIC_BOOTSTRAP_BLOCKED`
- `PLAYLIST_BOOTSTRAP_EMPTY`
- `PLAYLIST_BOOTSTRAP_NO_MATCH`

## TIDAL Request Volume and Rate Limits

All discovery and reconciliation requests must use `TidalClient.request()` and therefore the existing TIDAL traffic controls:

- Request attempts are proactively paced by `TIDAL_REQUEST_INTERVAL_MS`.
- Read retries pass through the same pacing mechanism.
- Playlist enumeration and playlist-item pagination remain serial.
- An exhausted `429` establishes the existing cooldown and stops additional sync work.
- Playlist mutations continue to receive exactly one network attempt.
- Persisted write batches and pre-write anchors remain responsible for ambiguous-write recovery.

The feature must avoid unnecessary TIDAL reads:

- Owned playlists are enumerated at most once per run when discovery is required, and the result is reused across dates.
- Each bootstrap candidate's items are fetched once for reconciliation.
- A reconciliation snapshot may be reused as the first append's pre-write snapshot only when doing so preserves the existing persisted-anchor and ambiguous-write guarantees.
- The local longest-common-subsequence calculation makes no TIDAL requests.

## Concurrent Instances

Concurrent xmsync instances remain explicitly unsupported. There is no remote lease or cross-computer idempotency key coordination. Two fresh databases can read the same frontier and append the same later airplays with different idempotency keys.

This feature guarantees safe sequential handoff only. The limitation must be documented in user-facing help or setup guidance.

## Expected Outcome

A user can stop xmsync on one computer, configure and authorize it on another computer in the same local time zone, select the same channel, and safely resume the existing xmsync-managed playlists for yesterday and today. The new computer reconstructs a conservative local ledger from playlist order, preserves prior and manual contents, and appends only airplays after the inferred frontier.

## Acceptance Criteria

- A fresh database does not blindly append the full scan window to an existing exact-name playlist.
- A single owned, non-public playlist with the exact expected name and description is eligible for automatic bootstrap.
- Multiple exact-name playlists, a description mismatch, or a public playlist blocks only that date and performs no mutation.
- An empty eligible playlist performs no mutation and reports an actionable bootstrap error.
- A non-empty playlist with no common TIDAL track ID performs no mutation and reports an actionable bootstrap error.
- Reconciliation computes a maximum ordered match and applies the deterministic earliest-frontier tie-break rules.
- Different XM airplays resolving to the same TIDAL track remain distinct reconciliation elements.
- Every scanned play through the selected frontier becomes terminal local history and is never appended by a later run.
- Missing expected items before the frontier are not restored.
- Existing unmatched playlist items are not deleted, moved, or replaced.
- Matchable plays after the frontier append oldest-first using batches of at most 50 items.
- Playlist mapping and recovered play state commit atomically before any append.
- A crash after local recovery and before append does not cause recovered plays to be appended after restart.
- Recovered and newly synced counts are reported separately.
- A conflict for yesterday does not prevent safe processing for today.
- Unresolved conflicts are retried on later runs.
- Owned-playlist discovery occurs at most once in a run.
- Every new TIDAL read is paced and receives the existing bounded read-retry behavior.
- An exhausted `429` stops further TIDAL work and preserves retryable bootstrap state for a later run.
- Playlist mutations retain one network attempt and existing ambiguous-write protections.
- No behavior claims safety for concurrently running computers.

## Verification

Automated tests must cover:

- Fresh-database adoption of a complete yesterday playlist without duplicate writes.
- Fresh-database adoption of a partial today playlist followed by appending only the later suffix.
- Manual removals before the frontier without restoration.
- Manual additions before and after recognized items without mutation.
- Repeated track IDs with deterministic earliest-frontier selection.
- Deterministic tie-breaking for multiple maximum alignments.
- Empty, no-match, description-mismatch, public, and duplicate-name conflicts.
- Date-local conflict isolation between yesterday and today.
- Atomic mapping and recovered-ledger persistence.
- Restart after recovery but before append.
- Terminal treatment and reporting of recovered plays.
- One owned-playlist enumeration per run.
- Multi-page playlist-item reads through the existing request pacer.
- A `429` during discovery or item pagination stopping later TIDAL work.
- Preservation of single-attempt mutation and ambiguous-write recovery behavior.

The full isolated test suite must pass. Live TIDAL verification is optional and must not use a real user playlist destructively; the existing opt-in smoke-test safety rules continue to apply.
