# Multi-Channel Sync

## Status

Completed.

## Problem

xmsync currently stores one selected SiriusXM channel and submits one channel to the sync coordinator for each Start, startup, scheduled, channel-change, or manual trigger. A user who listens to several channels must repeatedly replace the selection, and only the currently selected channel receives later scheduled updates.

The per-channel sync path is already a useful foundation:

- Each `SyncEngine.run()` receives a channel snapshot.
- Scan watermarks are keyed by channel.
- Plays record their channel.
- TIDAL playlist mappings are keyed by channel and local date.
- Run history records channel identity.
- Playlist names already include the channel name.

The remaining configuration, coordinator, status API, and UI are single-channel. Write recovery also relies on globally unique raw XM play IDs and globally enumerates pending batches, which is not sufficiently isolated for multiple channels.

## Goals

- Allow the user to select between one and ten visible xmplaylist channels.
- Apply Start, Stop, startup resume, scheduled boundaries, and Sync now to all selected channels.
- Run selected channels serially through the existing sync engine and shared TIDAL client.
- Continue with later channels after a channel-local failure.
- Immediately request catch-up only for newly added channels.
- Stop future work for a removed channel while allowing its active run to finish.
- Preserve all local state when a channel is deselected so that reselecting it resumes safely.
- Keep every channel's dated TIDAL playlists distinct, including when channels have the same display name.
- Expose per-channel progress, failures, and run history clearly.
- Preserve all existing scan, matching, ordering, append, and mutation-safety invariants independently for every channel.

## Non-Goals

- Running multiple channel syncs concurrently.
- More than ten selected channels.
- Independent schedules or Start/Stop controls per channel.
- A manual Sync now action for only a subset of selected channels.
- Combining multiple channels into one TIDAL playlist.
- Deleting TIDAL playlists or local history when a channel is deselected.
- Synchronizing multiple xmsync computers concurrently.
- Changing the half-hour schedule or the yesterday-and-today scan window.

## Product Decisions

| Concern | Decision |
| --- | --- |
| Selection size | One to ten channels for syncing; an empty selection is allowed while editing configuration |
| Schedule | One global enabled state and one local `:00`/`:30` timer |
| Start | Enable scheduling and request all selected channels immediately |
| Stop | Disable scheduling and cancel queued schedule/start/startup work; do not abort an active run |
| Sync now | Request all selected channels without changing schedule state |
| Startup resume | If scheduling was enabled, request all selected channels and resume the timer |
| Execution | One channel at a time through one shared TIDAL client |
| Channel-local failure | Record it and continue with later channels |
| Account-wide failure | Stop the remaining queued sweep |
| Added selection | Request immediate catch-up for newly added channels only when TIDAL is connected |
| Removed selection | Remove future queued work; let an active run finish |
| Deselected state | Preserve plays, watermarks, mappings, runs, and write-recovery state |
| Playlist collision | Add `(Ch. {number})` to a colliding channel label |

Saving an empty selection disables scheduled syncing, cancels queued non-manual work, and leaves an active channel run alone. Start and Sync now require at least one selected channel.

## Channel Selection

### Selection UI

Replace the single `<select>` with a filterable checkbox list of visible xmplaylist channels. Each row shows channel number and name. The panel also shows the selected count and the limit, for example `3 / 10 selected`.

Selection changes are staged locally and committed with one **Save channels** action. The complete selected ID list is sent in one request so additions and removals become visible atomically. The UI must:

- Disable additional unchecked rows at ten selections.
- Keep selected channels visible when filtering the catalog.
- Distinguish saved selection from unsaved checkbox edits.
- Report channels that disappeared from the latest xmplaylist catalog rather than silently removing them.
- Show which newly added channels received an immediate catch-up request.

A previously selected channel that is temporarily absent from `GET /api/channels` remains selected and schedulable from its persisted snapshot. It can still be explicitly removed. This avoids accidental data loss or schedule changes during an xmplaylist catalog problem.

### Validation

The server is authoritative. A selection update must:

1. Require a JSON array of channel IDs.
2. Reject duplicate IDs.
3. Reject more than ten IDs.
4. Fetch the current xmplaylist channel catalog once.
5. Accept IDs found in that catalog or already selected persisted channel IDs being retained.
6. Require newly added IDs to exist in the current catalog.
7. Commit the complete selected set and channel snapshots in one synchronous SQLite transaction.

All selection mutation routes retain the existing exact-localhost same-origin enforcement.

## Playlist Identity and Naming

The ordinary playlist name remains:

```text
{Channel Name} - YYYY-MM-DD
```

If two channels in the current full xmplaylist catalog have the same trimmed, case-insensitive display name, their resolved playlist labels include the channel number:

```text
{Channel Name} (Ch. {Channel Number}) - YYYY-MM-DD
```

The collision check uses the full fetched catalog, not only the selected set. This prevents playlist identity from changing merely because another channel is selected or deselected.

The resolved playlist label is persisted with the channel snapshot when that channel is first selected. It is stable on later runs and while deselected. If a legacy or already persisted channel owns the plain label, adding a newly colliding channel gives the new channel the numbered label rather than renaming or invalidating existing playlists. When multiple colliding channels are first selected in the same request, all receive numbered labels.

The persisted label, rather than the mutable catalog display name, is used in both the managed playlist name and description. Catalog name and number remain separately stored for display. xmsync does not rename old playlists when xmplaylist metadata changes; changing a persisted playlist label is outside this feature.

Playlist mappings remain unique by channel and local date. A TIDAL playlist ID must not be actively mapped to more than one channel/date pair. Exact-name discovery, adoption, creation recovery, and safe playlist bootstrap all use the resolved label and channel/date identity.

Examples:

- `80s on 8 - 2026-09-12`
- `The Blend (Ch. 16) - 2026-09-12`

## Scheduling and Coordination

### Channel jobs

Keep `SyncEngine.run(trigger, channel)` as the unit of execution. A global action expands the selected channel snapshots into channel jobs in persisted selection order. A job contains:

- Trigger.
- Immutable channel snapshot, including resolved playlist label.
- In-memory sweep ID used for status grouping.
- Position and total channel count in the originating sweep.

There is no need for a persisted sweep table. Existing `sync_runs` rows remain one row per channel, which preserves useful counts and failure details without combining unrelated channel outcomes. The coordinator retains an in-memory summary of the latest sweep for aggregate status until the next sweep or process restart.

### Coordinator queue

Replace the coordinator's single queued slot with a FIFO queue deduplicated by channel ID:

- Exactly one engine run is active globally.
- At most one additional queued job exists for a channel.
- A new global request enqueues each selected channel that is neither queued nor the same requested occurrence already represented by the active sweep.
- Repeated requests while work is active coalesce to at most one follow-up per channel.
- A channel that already finished in the active sweep may be queued once for a later manual or scheduled request.
- Jobs already waiting in the current sweep keep their FIFO position, preventing repeated requests from starving later channels.
- Trigger priority for a coalesced queued job is `manual`, `channel_added`, `start`, `startup`, then `schedule`, so an explicit user request is not reported as a background boundary.
- Removing a selection deletes that channel's queued jobs. It does not mutate the active job's immutable snapshot.
- Adding a selection enqueues only each newly added channel with trigger `channel_added` when TIDAL is connected.

The queue is in memory. A process exit does not need to persist unstarted jobs because startup resume or the next scheduled boundary scans all selected channels from their persisted watermarks and play ledgers.

### Timer behavior

The half-hour timer remains armed while channel work is active. If a boundary occurs during a long sweep, it submits a scheduled sweep to the coordinator; deduplication retains at most one follow-up job per channel. This preserves clock alignment without overlap.

After a boundary fires, the scheduler immediately calculates and arms the next local half-hour boundary. Local wall-clock and daylight-saving behavior remains unchanged.

### Stop behavior

Stop disables the global scheduler and removes queued jobs whose trigger is `schedule`, `start`, or `startup`. It does not:

- Abort the active channel.
- Remove queued manual Sync now jobs.
- Remove an immediate `channel_added` catch-up requested by a saved selection change.
- Delete selected channels or their state.

The UI states this behavior rather than implying that Stop cancels an in-progress network operation.

## Failure Isolation

Failures are classified by scope.

### Channel-local failures

The coordinator records the completed channel run and proceeds to the next queued channel after:

- xmplaylist scan or pagination failure for one channel.
- Malformed airplay data.
- Track resolution failure that is not authorization or rate-limit related.
- Playlist discovery, adoption, bootstrap, or naming conflict for one channel/date.
- A failed or ambiguous playlist mutation whose persisted batch is scoped to one channel/date.

An ambiguous mutation remains blocked and is never blindly retried. Continuing another channel is safe only because play identity and write batches are channel-scoped.

### Sweep-stopping failures

The coordinator drops all currently queued TIDAL-dependent jobs after:

- TIDAL authorization loss or required reauthorization.
- An exhausted TIDAL `429` and active account-wide cooldown.

These conditions affect the shared TIDAL account rather than one channel, including jobs queued by a later overlapping trigger. Pending plays and unstarted channel jobs remain recoverable on a later manual or scheduled sweep. The scheduler does not issue more TIDAL work during an active cooldown.

An unexpected coordinator or database failure also stops the current pump rather than repeatedly attempting later jobs in a potentially invalid process state.

Failures from an earlier channel must remain visible even if a later channel succeeds. A channel's latest error clears only after a later successful run of that same channel. An account-wide authorization error clears after successful reauthorization; a rate-limit error clears after cooldown and a later successful TIDAL request.

## Persistence

### Selected channels

Add a channel configuration table with at least:

- Stable xmplaylist channel ID as primary key.
- Deeplink.
- Current display name.
- Channel number.
- Persisted playlist label.
- Selected flag or selected position.
- First-selected and last-updated timestamps.

Rows are retained when deselected. The selected position provides deterministic sweep order and can be replaced atomically with the selection.

The singleton `settings.channel_*` fields are no longer authoritative. The global `scheduler_enabled`, TIDAL credentials, account binding, and OAuth state remain singleton settings.

### Channel-qualified play identity

Treat an airplay's durable identity as `(channel_id, play_id)`, not raw `play_id`. Rebuild the `plays` primary key accordingly and pass channel ID to every play lookup and update. This protects against xmplaylist issuing station-local play IDs and makes the multi-channel invariant explicit.

`run_items.play_id` may remain descriptive because its parent run already identifies the channel, but joins to `plays` must use both the run's channel and play ID.

### Channel-qualified write recovery

Every new `write_batches` row must include `channel_id` and `local_date`. Pending and ambiguous batch queries must be scoped by channel. Batch play references resolve through `(channel_id, play_id)`, and create-playlist recovery uses channel/date plus expected name rather than expected name alone.

The following must never happen across channels:

- One channel recovering another channel's pending add batch.
- An ambiguous batch excluding a same-ID play from another channel.
- A same-name playlist creation batch being adopted for another channel.
- One playlist mapping being silently reused by two channel/date identities.

### Run history

Continue storing one `sync_runs` row per channel. Add channel number or obtain it from the retained channel row for display. Recent-run queries should support a channel filter and a configurable limit so ten active channels do not crowd useful history out immediately.

## Database Migration

Introduce a real transactional migration from schema version 1 rather than treating every supported nonzero version as current.

The migration must:

1. Create the retained channel configuration table.
2. Copy the legacy singleton channel into it as the only selected channel, preserving its existing plain playlist label.
3. Preserve scheduler state, credentials, account binding, OAuth tokens, playlist mappings, track mappings, scan state, runs, and run items.
4. Rebuild `plays` with the composite `(channel_id, play_id)` primary key and equivalent indexes and statuses.
5. Add channel/date ownership to write batches and infer active legacy batch ownership from mapped playlist IDs, referenced plays, or the legacy selected channel.
6. Preserve completed write-batch history even when ownership is not operationally needed.
7. Fail startup transactionally with an actionable error if a pending or ambiguous legacy batch cannot be assigned safely; never discard or guess ambiguous mutation state.
8. Advance `PRAGMA user_version` only after all migration steps succeed.

This migration must compose with the proposed Safe TIDAL Playlist Bootstrap migration, including its `recovered` play status and run count. Implementation should use an ordered migration chain so either feature can be introduced without rebuilding tables twice in one release or losing the other's columns.

## API Changes

### `GET /api/channels`

Return the current xmplaylist catalog merged with persisted selection state:

```json
{
  "channels": [
    {
      "id": "string",
      "deeplink": "string",
      "name": "80s on 8",
      "number": "8",
      "selected": true,
      "selectedPosition": 0,
      "playlistLabel": "80s on 8",
      "available": true
    }
  ],
  "selectionLimit": 10
}
```

Persisted selected channels absent from the live catalog are included with `available: false`.

### `PUT /api/channels`

Replace the complete selected set atomically:

```json
{
  "ids": ["channel-a", "channel-b"]
}
```

Return the saved selected channel snapshots plus `catchUpRequested` channel IDs. An empty array is valid and disables scheduled syncing. Replace the singular `PUT /api/channel`; no backward-compatibility alias is required because the application has no documented external API consumers.

### Sync controls

`POST /api/sync/start` and `POST /api/sync/now` return enough information to explain coalescing:

```json
{
  "requested": ["channel-a", "channel-b"],
  "started": ["channel-a"],
  "queued": ["channel-b"],
  "coalesced": []
}
```

`POST /api/sync/stop` returns whether an active channel remains and which queued channels were cancelled.

### Status

Replace singular `channel` and `scheduler.queued` fields with:

- `selectedChannels`: persisted snapshots in sweep order.
- `scheduler.current`: current channel job, trigger, sweep position, and total.
- `scheduler.queued`: ordered channel jobs.
- `scheduler.errors`: latest uncleared error per channel plus any account-wide error.
- `scheduler.lastSweep`: in-memory trigger, start/end times, requested/completed/failed channel IDs, and aggregate completion text.
- `scheduler.nextRunAt`: the next global boundary.
- `lastRun`: latest completed channel run, including channel name and number.

The scheduler's aggregate state is:

- `syncing` while one channel is active.
- `error` when idle with a current account-wide error or one or more latest channel errors.
- `running` when enabled, idle, and at least one channel is selected.
- `stopped` when disabled.

The API must not include credentials, OAuth tokens, raw TIDAL error bodies, or other secrets in these responses.

### Run history

`GET /api/runs` retains channel identity on every row and accepts optional `channelId` and bounded `limit` query parameters. Unknown channel IDs return an empty result rather than exposing internal query details.

## User Interface and Reporting

The control deck remains global. Its labels make the scope explicit:

- Start starts scheduled syncing for all selected channels.
- Stop stops future scheduled work.
- Sync now requests all selected channels.

While syncing, show the current channel and sweep progress, for example `80s on 8, channel 2 of 4`. Show the queued channel names rather than only a generic queued flag.

The selected-channel panel lists saved channels with compact state indicators:

- Syncing.
- Queued.
- Last completed time.
- Latest success, partial, or failed status.
- Latest channel-specific error when present.

The existing last-run meters represent the explicitly named latest channel run; they are not summed across unrelated runs. The recent-runs table adds a Channel column and a channel filter. Mobile layouts must keep channel identity visible without requiring horizontal scrolling to infer which run failed.

The UI uses `scheduler.lastSweep` to report transient aggregate outcomes such as `8 of 10 channels completed; 2 failed` while retaining the actionable error for each failed channel. After restart, per-channel run history remains authoritative and no prior aggregate sweep is reconstructed.

## Sync Invariants

For each selected channel independently:

- Scan only yesterday and today in the host's local time zone.
- Maintain a contiguous per-channel watermark and do not advance it after incomplete pagination.
- Persist valid plays even when a later page fails.
- Identify an airplay by channel ID plus XM play ID.
- Preserve repeated broadcasts as distinct oldest-first playlist occurrences.
- Resolve tracks and reuse track mappings using the existing source-identity rules.
- Group plays by local airplay date.
- Use a separate mapped TIDAL playlist for every channel/date.
- Append in batches of at most 50.
- Retry failed plays and keep no-match plays terminally skipped.
- Give each TIDAL mutation exactly one network attempt.
- Retain persisted idempotency keys, pre-write anchors, the one-hour replay window, and ambiguous-write blocking.

Across all channels:

- Never overlap sync engine runs.
- Use one shared TIDAL request pacer and cooldown.
- Do not allow one channel's ledger or write batch to affect another channel.
- Do not let repeated triggers starve a channel already waiting in the FIFO.

## Interaction With Other Features

### TIDAL rate-limit handling

The existing phrase "run-wide backpressure" becomes queue-wide for an exhausted `429`. The current channel run records the failure, the shared cooldown is established, and all currently queued TIDAL-dependent jobs are dropped. No later selected channel sends TIDAL requests until a future trigger after cooldown.

### Safe TIDAL playlist bootstrap

Bootstrap remains channel/date-local and uses the persisted resolved playlist label. Owned-playlist discovery should be reusable across dates and, where practical without stale ownership assumptions, across channels in one sweep. Reconciliation and recovered play identity use `(channel_id, play_id)`. A bootstrap conflict for one channel/date does not prevent other dates or channels, while authorization loss and exhausted rate limits stop the sweep.

## Acceptance Criteria

- The user can atomically save between zero and ten selected channels.
- The API rejects duplicate, unknown newly added, or more than ten channel IDs.
- Start, startup resume, each half-hour boundary, and Sync now request every selected channel exactly once unless coalesced with already represented work.
- Selected channels run serially and no two engine runs overlap.
- A channel-local failure does not prevent a later selected channel from running.
- TIDAL authorization loss or an exhausted `429` prevents later channels in that sweep from making TIDAL requests.
- Repeated triggers retain at most one queued follow-up per channel and do not starve channels already waiting.
- A boundary reached during a long active sweep is represented as a coalesced follow-up rather than silently missed.
- Adding channels requests immediate catch-up only for those additions when TIDAL is connected.
- Removing a channel prevents future queued work while allowing an active run to finish from its snapshot.
- Saving an empty selection disables scheduling without deleting channel state.
- Reselecting a channel reuses its watermark, play ledger, playlist mappings, playlist label, and unresolved write state.
- Ordinary playlist names retain the existing `{Channel Name} - YYYY-MM-DD` format.
- Same-name channels receive stable, distinct numbered playlist labels and cannot adopt each other's playlists.
- The same raw XM play ID can exist independently on two channels.
- Pending and ambiguous write batches are recovered only in their owning channel/date context.
- Playlist mutations remain single-attempt and never gain blind retries.
- Status identifies the active and queued channels and retains failures from more than one channel.
- Run history visibly identifies its channel and can be filtered by channel.
- A schema-version-1 database migrates without losing configuration, authorization, playlists, plays, mappings, recovery state, or run history.

## Verification

Automated tests must cover:

### Database

- Atomic selection replacement, ordering, empty selection, and the ten-channel limit.
- Preservation of deselected channel rows and all related state.
- Legacy singleton-channel migration.
- Composite play identity with the same raw play ID on two channels.
- Channel/date-scoped pending and ambiguous write batches.
- Transaction rollback and unchanged schema version after a failed migration.
- Migration composition with the `recovered` state when Safe TIDAL Playlist Bootstrap is present.

### Coordinator and scheduler

- All selected channels run once for Start, startup, schedule, and Sync now.
- Strict global serialization.
- FIFO order and one queued follow-up per channel.
- Repeated manual and scheduled requests coalescing without starvation.
- A half-hour boundary during an active sweep queuing follow-up work.
- Adding and removing selections while another channel is active.
- Stop cancelling only schedule/start/startup work and not aborting the active run.
- Channel-local failure continuation.
- Sweep cancellation after auth loss or exhausted `429`.
- Per-channel errors remaining visible after later successes.

### Sync engine and recovery

- Independent scans, watermarks, plays, and dated playlists for two channels.
- Two channels with the same raw play ID.
- Same-name channel playlist-label isolation.
- A pending add or create batch never being considered by another channel.
- An ambiguous write in one channel not corrupting or blocking an unrelated channel.
- Existing repeated-airplay ordering and 50-item chunking for each channel.
- Shared TIDAL pacing across consecutive channel runs.

### HTTP API and UI

- Atomic multi-channel validation and exact same-origin rejection.
- Persisted-but-unavailable channels appearing without silent deselection.
- Start and Sync now readiness with zero, one, and ten selected channels.
- Status shapes for active, queued, partial, failed, and account-wide error states.
- Run channel filtering and bounded limits.
- Accessible selection controls, selected-count feedback, mobile layout, and disabled eleventh selection.
- Current channel, queue order, sweep progress, and per-channel failures rendering correctly.

The full isolated test suite must pass. Live TIDAL verification remains opt-in and must not mutate real user playlists beyond the existing temporary smoke-test contract.
