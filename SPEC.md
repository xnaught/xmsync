# XMPlaylist to TIDAL Sync

## Version

- Status: Draft specification for v1 implementation
- Runtime: Node.js 24 LTS
- Interface: Local browser application served by Node.js
- Supported platforms: Windows, macOS, and Linux when support remains straightforward; Windows is the primary development and test platform

## 1. Summary

Build a local Node.js application that reads recent SiriusXM airplay history from the public xmplaylist.com API and appends the corresponding tracks to date-based playlists in the user's TIDAL account.

The user selects one SiriusXM channel. On first start, and on later application restarts, the application imports all plays from the previous local calendar day and the current local calendar day. While scheduled syncing is active, it runs immediately and then at every local clock half-hour (`:00` and `:30`).

For each date containing at least one matchable play, the application creates or reuses an unlisted TIDAL playlist named:

```text
{Channel Name} - YYYY-MM-DD
```

Example:

```text
The Spectrum - 2026-09-11
```

The application is append-only. It does not remove or reorder playlist items, and it preserves separate airplays of the same track as separate playlist entries.

## 2. Goals

- Run entirely on the user's local machine.
- Provide a plain HTML, CSS, and browser JavaScript interface with no frontend framework or bundler.
- Let the user enter TIDAL developer credentials and authorize a TIDAL account.
- Enumerate visible SiriusXM channels from xmplaylist.com.
- Sync exactly one selected channel at a time.
- Build separate TIDAL playlists for yesterday and today using the computer's local time zone.
- Poll for newly played tracks every 30 minutes while scheduled syncing is active.
- Prefer direct TIDAL track IDs supplied by xmplaylist.com.
- Fall back to automatic artist/title matching in TIDAL when a direct ID is unavailable.
- Persist configuration, OAuth tokens, track mappings, playlist mappings, processed airplays, and run history in SQLite.
- Resume the selected channel and scheduler automatically on later launches when configuration and authorization remain valid.
- Remain safe to retry without intentionally duplicating an already processed airplay.
- Report current state, recent run summaries, skipped plays, and actionable errors in the UI.

## 3. Non-Goals

- Syncing multiple channels concurrently.
- Running as a hosted web service or accepting remote network clients.
- Running as an operating-system background service after the Node.js process exits.
- Fetching more than yesterday and today on startup.
- Using xmplaylist paid or authenticated endpoints.
- Manually reviewing or correcting track matches in v1.
- Exactly reconciling a TIDAL playlist with xmplaylist history.
- Undoing manual TIDAL playlist edits.
- Restoring a track that the user manually removed from TIDAL.
- Encrypting credentials or OAuth tokens at rest.
- Packaging the application as a native executable or desktop installer.
- Supporting more than one TIDAL account in the same local data store.

## 4. Confirmed Product Decisions

| Topic | Decision |
| --- | --- |
| Application model | Node.js process serving a browser UI on localhost |
| Frontend | Vanilla HTML, CSS, and JavaScript |
| Node.js baseline | Node.js 24 LTS |
| Active channels | One channel at a time |
| xmplaylist access | Public, unauthenticated API only |
| Initial/restart history | Previous local calendar day plus current local calendar day |
| Date boundaries | Computer's local time zone |
| Poll schedule | Immediate run, then local `:00` and `:30` |
| Restart | Automatically resume when configured and authorized |
| Repeated airplays | Add one playlist item for every airplay, including repeated tracks |
| Playlist visibility | Unlisted |
| Playlist name | `{Channel Name} - YYYY-MM-DD` |
| Empty dates | Do not create an empty playlist |
| Existing playlist | Reuse an owned playlist with the expected name |
| Playlist mutation | Append only; do not reconcile manual edits |
| Direct TIDAL link | Trust a valid, available TIDAL track ID |
| Fallback matching | Automatically use the best artist/title search result |
| Preferred version | Original album version over live, remix, karaoke, or tribute variants |
| Explicit content | Include both explicit and clean catalog results |
| No search result | Skip that play, report it, and continue the run |
| TIDAL country | United States (`US`) |
| Persistence | Local SQLite database |
| Secret storage | Plain text in SQLite is acceptable for v1 |
| Controls | Start, stop, and one-shot Sync now |
| Stopped manual sync | Sync now remains available and does not start the schedule |
| Status UI | Current state plus recent run summaries and errors |

## 5. Runtime Architecture

### 5.1 Process Model

- `npm start` launches one Node.js process.
- The process binds only to a loopback interface and serves both the static UI and a same-origin local API.
- The default application URL is `http://localhost:8787/`.
- The fixed TIDAL OAuth callback is `http://localhost:8787/auth/tidal/callback` and must be registered exactly in the TIDAL developer portal.
- The port remains fixed because OAuth redirect URIs must match their registered value. A port conflict produces a clear startup error rather than selecting a random port.
- The application should open the default browser after the local server is ready. If opening fails, it prints the local URL.
- Closing the browser does not stop the Node.js process or scheduler. Stopping the process stops all scheduled work.

### 5.2 Components

- Local HTTP server and API routes
- Static vanilla web UI
- SQLite persistence layer
- TIDAL OAuth client
- xmplaylist API client
- TIDAL catalog and playlist client
- Track resolver and mapping cache
- Single-channel sync engine
- Clock-aligned scheduler
- Recent-run event/status service

The implementation should prefer a small dependency set. Node.js built-in `fetch`, URL, crypto, and timer APIs are sufficient for external requests, PKCE, and scheduling. A maintained SQLite library and a small local HTTP framework may be used where they reduce implementation risk.

## 6. User Experience

### 6.1 First Launch

1. The application opens its local UI.
2. The setup view asks for the TIDAL client ID and client secret.
3. Saving writes both values to SQLite. API responses never return the saved secret to the browser; they return only a configured/not-configured indicator and a masked display value.
4. The user selects **Connect TIDAL**.
5. The application starts an OAuth 2.1 authorization-code flow with PKCE S256 and redirects the browser to TIDAL.
6. TIDAL redirects to the fixed localhost callback.
7. The Node.js backend verifies OAuth state, exchanges the code, persists tokens, and returns the browser to the application.
8. The application loads visible SiriusXM channels from xmplaylist.com.
9. The user selects one channel and clicks **Start**.
10. The initial sync starts immediately for yesterday and today.
11. Scheduled syncing becomes active for subsequent `:00` and `:30` boundaries.

There is no preview or confirmation screen for proposed track matches in v1.

### 6.2 Later Launches

- Restore the saved TIDAL credentials, selected channel, and scheduler-enabled state.
- Refresh the TIDAL access token if needed.
- If authorization is valid and syncing was enabled, immediately run the yesterday/today catch-up and schedule future half-hour runs.
- If token refresh fails, do not write to TIDAL. Show **TIDAL reauthorization required** and provide a reconnect action.
- If no channel or credentials are configured, remain in setup mode.

### 6.3 Main Screen

The main screen contains:

- TIDAL connection state and reconnect action
- Selected SiriusXM channel, including channel number and name
- Channel selector
- Scheduler state: running, stopped, syncing, or error
- Last completed sync time
- Next scheduled sync time
- **Start**, **Stop**, and **Sync now** controls
- Latest run counts: fetched, already processed, directly matched, search matched, synced, skipped, and failed
- Compact recent-run table
- Expandable details for skipped plays and errors, including airplay time, artist, title, and reason

The browser receives status changes by same-origin server-sent events or lightweight polling. This choice is an implementation detail as long as the screen updates during a run.

### 6.4 Controls

- **Start** enables scheduled syncing and initiates an immediate run unless a run is already active.
- **Stop** disables future scheduled runs. An in-progress run is allowed to finish so that external writes and local state are not interrupted ambiguously.
- **Sync now** requests one immediate run. It works whether the scheduler is running or stopped and does not change the scheduler's enabled state.
- Only one sync run may execute at a time. If Sync now is requested during a run, queue at most one additional run instead of overlapping work.
- Changing the selected channel stops future scheduling for the previous channel and saves the new selection. If an old-channel run is active, that run finishes using its original channel snapshot; the new-channel catch-up replaces any queued generic follow-up and runs next. Otherwise, the new-channel catch-up starts immediately. Scheduling then resumes for the new channel if it was enabled.

## 7. Time and Sync Semantics

### 7.1 Local Date Window

At the start of an initial, Start, restart, channel-change, or manual run, calculate:

- Start: local midnight at the beginning of yesterday
- End: the run's current instant

This intentionally represents between 24 and almost 48 hours. For example, a first sync at 8 PM imports all of yesterday plus today through 8 PM.

xmplaylist timestamps are UTC ISO 8601 instants. Convert each instant to the computer's local time zone to determine its playlist date. Use calendar-aware date handling so daylight-saving transitions do not assume that every local day is exactly 24 hours.

### 7.2 xmplaylist Pagination

- List channels with `GET https://xmplaylist.com/api/station`.
- Fetch a selected channel with `GET https://xmplaylist.com/api/station/{channel}` using the lowercased channel deeplink.
- The first page omits `last`.
- Results are currently returned newest first, 24 per page.
- Initial, Start, restart, channel-change, and manual runs continue through the response's `next` cursor until the oldest result is before yesterday's local midnight or `next` is null.
- Extract the `last` value from the returned URL rather than deriving it from a timestamp.
- xmplaylist currently emits `http://` pagination URLs. The client must preserve the cursor but send the request over HTTPS to the known xmplaylist host.
- Never follow an arbitrary host supplied in `next`.
- Send a stable, descriptive non-empty `User-Agent`; xmplaylist rejects empty user agents.
- The public endpoint allows cursors only within the last 30 days. This application never intentionally requests outside that window.

The client must tolerate additive response fields. In particular, live responses contain `links`, including TIDAL links, even though the current xmplaylist OpenAPI response schema omits that property.

### 7.3 Regular Polls

- Recalculate the next boundary after every run so clock changes do not cause timer drift.
- A run scheduled for `:00` or `:30` starts no earlier than that boundary.
- Maintain a per-channel contiguous scan watermark representing the newest instant through which the application has successfully scanned every intervening xmplaylist page.
- Begin with the current page and paginate until results cross the previous contiguous scan watermark or yesterday's cutoff. Do not stop merely because one known play ID is encountered.
- Advance the scan watermark to the run-start instant only after every required page has been read and persisted. A failed or partial scan leaves the prior watermark unchanged.
- Process pending and retryable plays already in SQLite independently of the pagination stopping condition.
- Route every newly observed play by its local airplay date. A play found shortly after midnight may therefore be appended to yesterday's playlist.
- Sort newly processable plays oldest to newest before resolving and writing them.
- Playlist order is chronological within each write run. Because the application is append-only, an unusually late-arriving historical play is appended when discovered rather than forcing a reorder of manual or existing items.
- A failed scheduled run does not disable the scheduler. The next boundary tries again.

## 8. Track Resolution

### 8.1 Resolution Priority

Resolve each unique xmplaylist track in this order:

1. Reuse a cached successful mapping for the same xmplaylist track ID and identity.
2. Use the direct TIDAL link in `results[].links`.
3. Search the TIDAL catalog by xmplaylist artist and title.
4. If no TIDAL result exists, mark the play skipped, report it, and continue.

Mappings are cached by xmplaylist track ID together with the source title and artists. If xmplaylist ever reuses an ID with changed metadata, do not silently reuse the stale mapping.

### 8.2 Direct TIDAL Link

- Find the link whose `site` is `tidal`.
- Parse a URL shaped like `http[s]://[www.]tidal.com/track/{id}`.
- Treat `{id}` as an opaque non-empty string even when it currently looks numeric.
- Reject unexpected hosts, paths, query-derived IDs, or malformed URLs.
- Validate the ID with the official TIDAL single-track endpoint in the `US` catalog and request its usage rules.
- If TIDAL returns the track and its usage rules permit streaming in the US, trust the ID without comparing title and artist metadata.
- If the ID is missing, nonexistent, or unavailable in the US catalog, continue to fallback search.

### 8.3 Fallback Search

- Query TIDAL search using the xmplaylist title and artist names.
- Include explicit results.
- Request nested track artist and album data, or retrieve those relationships in follow-up calls, so every ranked candidate has enough title, version, artist, and album metadata.
- Normalize case, Unicode punctuation, whitespace, common featuring syntax, and harmless punctuation for comparison while retaining the raw source values.
- Give the greatest weight to exact normalized title and primary-artist agreement.
- Give supporting weight to overlap with all listed artists.
- Penalize `live`, `remix`, `karaoke`, `tribute`, `cover`, `instrumental`, and similar alternate-version terms unless equivalent terms are present in the xmplaylist title.
- Prefer an original album version when multiple candidates otherwise agree.
- Use TIDAL's result order as the final tie-breaker.
- Automatically accept the highest-scoring returned candidate. v1 has no confidence threshold or manual review step.
- If TIDAL returns zero track candidates, mark the play skipped and continue the run.

### 8.4 Repeated Airplays

- Deduplication is by xmplaylist play ID, not by xmplaylist track ID or TIDAL track ID.
- Two different play IDs that resolve to the same TIDAL track produce two playlist entries.
- Multiple occurrences are written in airplay order.
- The feasibility test in Section 14 must confirm that TIDAL permits repeated identical track IDs and preserves request order before full implementation proceeds.

## 9. TIDAL Playlist Behavior

### 9.1 Discovery and Creation

- Name each playlist `{Channel Name} - YYYY-MM-DD` using the channel name returned by xmplaylist and the play's local date.
- Create playlists as `UNLISTED`.
- Use a description similar to:

```text
SiriusXM plays from {Channel Name} on YYYY-MM-DD, synced from xmplaylist.com.
```

- Do not create a playlist until at least one play for that date has resolved to a TIDAL track.
- Prefer the locally stored channel/date-to-playlist-ID mapping.
- If no local mapping exists, enumerate playlists owned by the authenticated user and match the exact expected name.
- If exactly one owned playlist matches, reuse it and persist its ID.
- If multiple owned playlists have the exact expected name, do not guess. Skip writes for that date and show an actionable ambiguity error asking the user to rename extras.
- If none matches, create a new playlist and persist its returned ID.
- Before using a stored playlist mapping, retrieve the playlist and validate that it still exists, is owned by the connected account, and retains the expected name. A missing or renamed playlist invalidates the mapping and restarts exact-name discovery.
- A reused playlist retains its existing visibility. Only playlists created by this application are required to be unlisted; warn in the UI when adopting an existing public playlist.

### 9.2 Writes

- Append only tracks for play IDs that are not already recorded as synced or permanently skipped.
- Submit tracks oldest to newest.
- Use at most 50 items per TIDAL add-items request, matching the current API limit.
- Omit placement metadata for normal append operations, subject to confirmation in the feasibility test.
- Supply the airplay timestamp as per-item `addedAt` if the production API confirms that field is accepted for third-party playlist writes; otherwise omit it.
- Record each returned playlist occurrence/item ID when supplied.
- Handle partial-success responses item by item.
- Never delete, move, or replace playlist entries in v1.
- Never restore an entry solely because the user removed it manually after it was recorded as synced.

### 9.3 Existing Contents

The SQLite play ledger is the authority for what this application has processed. Existing TIDAL contents are not generally used to infer airplay history because repeated tracks are legitimate and cannot be mapped reliably to xmplaylist play IDs.

If an exact-name playlist predates all local state, the application reuses it and appends the selected window. This can duplicate content that was previously added by another tool or by a lost xmsync database. The UI must warn when adopting an existing playlist without a local play ledger.

## 10. OAuth and TIDAL API Use

### 10.1 Authorization

- Use OAuth 2.1 authorization code with PKCE S256.
- Generate cryptographically random `state`, code verifier, and code challenge values for every authorization attempt.
- Store short-lived pending OAuth state server-side and validate it on callback.
- Use the configured client ID and client secret only in the Node.js backend.
- Request the public scopes needed for account identity, owned-playlist discovery, playlist writes, and search: `user.read`, `playlists.read`, `playlists.write`, and `search.read`.
- Verify the scopes actually granted in the token response.
- Persist access token, refresh token, granted scopes, token type, and calculated expiry in SQLite as plain text, as accepted for this local v1.
- Refresh before expiry using `grant_type=refresh_token`.
- If a refresh response does not rotate the refresh token, retain the existing refresh token.
- If refresh is rejected, clear unusable token state and require reconnection.

### 10.2 Relevant Endpoints

The current official TIDAL base URL is `https://openapi.tidal.com/v2`.

- Catalog validation: `GET /tracks/{id}?countryCode=US&include=usageRules`
- Search: `GET /searchResults?filter[query]={query}&explicitFilter=INCLUDE&countryCode=US` with nested track/artist/album includes supported by the live API, followed by relationship reads when required
- Search track pagination when needed: `GET /searchResults/{id}/relationships/tracks`
- Owned playlists: `GET /playlists?filter[owners.id]=me`
- Create playlist: `POST /playlists`
- Read playlist items: `GET /playlists/{id}/relationships/items`
- Add playlist items: `POST /playlists/{id}/relationships/items`

All TIDAL requests use bearer authorization and JSON:API media types as documented by the endpoint.

### 10.3 Mutation Idempotency

- Generate an idempotency key for every playlist-create and add-items mutation.
- Persist the key, target, and exact request payload before sending the request.
- A retry of an uncertain mutation reuses the same key and unchanged payload.
- Mark a mutation complete only after its response has been applied to the SQLite ledger transactionally.
- If an outcome remains ambiguous after TIDAL's documented one-hour idempotency replay period, do not blindly repeat it. Compare the expected batch with the playlist's current suffix where possible; otherwise report an actionable ambiguous-write error to avoid creating duplicate airplays.

## 11. Local API Surface

Exact route naming may change during implementation, but the browser/backend contract must cover:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Configuration, auth, scheduler, current-run, and next-run state |
| `GET` | `/api/settings` | Non-secret settings and masked credential state |
| `PUT` | `/api/settings` | Save client credentials and related local settings |
| `GET` | `/auth/tidal/start` | Begin TIDAL authorization |
| `GET` | `/auth/tidal/callback` | Validate callback and exchange authorization code |
| `POST` | `/api/tidal/disconnect` | Clear OAuth tokens without deleting sync history |
| `GET` | `/api/channels` | Return visible xmplaylist channels |
| `PUT` | `/api/channel` | Select the one active channel |
| `POST` | `/api/sync/start` | Enable scheduler and request immediate sync |
| `POST` | `/api/sync/stop` | Disable future scheduled syncs |
| `POST` | `/api/sync/now` | Request a one-shot sync |
| `GET` | `/api/runs` | Return recent run summaries and details |
| `GET` | `/api/events` | Optional server-sent status events |

Mutating routes accept only same-origin requests and JSON where applicable. Logs and API responses must redact the client secret, access token, refresh token, authorization code, and PKCE verifier.

## 12. Persistence Model

Use one SQLite database under a gitignored local `data` directory. Schema migrations run automatically and transactionally at startup.

The logical model includes:

### `settings`

- TIDAL client ID
- TIDAL client secret
- active xmplaylist channel ID/deeplink/name
- scheduler enabled flag
- schema/application settings version

### `oauth_tokens`

- authenticated TIDAL user ID
- access token
- refresh token
- token type
- granted scopes
- expiry instant
- updated instant

### `playlists`

- xmplaylist channel identity
- local calendar date
- expected playlist name
- TIDAL playlist ID
- adoption/creation source
- created and last-seen instants

Enforce uniqueness for channel plus local date.

### `track_mappings`

- xmplaylist track ID
- source title and artists identity
- TIDAL track ID
- resolution method: `direct_link` or `search`
- resolution timestamp
- last validation state

### `plays`

- xmplaylist play ID as the unique idempotency key
- channel identity
- raw UTC airplay timestamp
- derived local date
- xmplaylist track ID
- source title and artists
- source TIDAL link when present
- resolved TIDAL track ID when present
- match method
- processing status: pending, synced, skipped, or failed/retryable
- TIDAL playlist ID and occurrence/item ID when written
- error code/message
- created and updated instants

### `sync_runs`

- trigger: startup, start, schedule, manual, or channel change
- channel identity
- start/end instants
- status
- fetched/already-known/matched/synced/skipped/failed counts
- summarized error

### `write_batches`

- operation type and target ID
- idempotency key
- exact serialized payload or stable payload hash plus recoverable item list
- pending/completed/ambiguous status
- attempt and response timestamps

### `channel_scan_state`

- xmplaylist channel identity
- contiguous successful scan watermark
- last complete scan instant

### `run_items`

- sync run ID
- xmplaylist play ID when available
- per-run outcome and match method
- immutable artist/title/airplay-time snapshot
- immutable error code/message snapshot

Retain recent run details without an automatic v1 purge. Expected data volume for one channel is small.

Account-bound playlist mappings and play history belong to the authenticated TIDAL user ID stored when the database is first connected. If a later OAuth flow returns a different user ID, reject the connection and show an actionable error requiring the original account or deletion/reset of the local database. v1 does not reuse state across TIDAL accounts.

## 13. Error Handling

- A failure for one track does not stop later tracks unless the failure indicates loss of TIDAL authorization or an unsafe/ambiguous playlist write.
- A play with no TIDAL result is permanently skipped for v1 and shown in run details.
- Network errors, timeouts, `429`, and external `5xx` responses are retryable.
- Use bounded exponential backoff with jitter for transient failures and honor `Retry-After` when present.
- Keep retry counts low enough that one run cannot overlap the next half-hour indefinitely.
- If a run is still active at the next boundary, do not overlap it; queue at most one follow-up run.
- A malformed xmplaylist result is skipped and reported without discarding valid results from the same page.
- A malformed or off-host xmplaylist pagination URL stops pagination and reports an error.
- TIDAL `401` triggers one token refresh and request retry. A second authorization failure requires user reconnection.
- TIDAL `403` reports missing scope/access and stops writes until corrected.
- TIDAL partial item-add responses update successful plays and report skipped/failed items individually.
- Startup database or migration failure prevents syncing and presents a clear fatal error; the application must not silently replace the database.

## 14. Mandatory TIDAL Feasibility Gate

Before implementing the full sync workflow, create a small opt-in smoke test using the user's registered TIDAL application.

The test must prove all of the following with official APIs:

1. TIDAL accepts the registered localhost callback URI and PKCE S256 flow.
2. The token has sufficient public user, playlist read/write, and search access.
3. The app can identify the authenticated TIDAL user and enumerate playlists owned by `me`.
4. The app can search for a track and can retrieve one track plus US usage rules by ID.
5. The app can create one temporary unlisted playlist.
6. The app can add two occurrences of the same track ID in one request or consecutive requests.
7. Reading playlist items returns both occurrences in the expected order.
8. Omitting `positionBefore` appends items in request order.
9. The temporary playlist can be deleted after the test.

This gate is required because the current official OpenAPI document marks these operations as third-party but declares some user operations with both public granular scopes and legacy `r_usr`/`w_usr` scopes that the same document labels internal-only. The user's TIDAL developer application shows playlist read/write permissions enabled, but actual token and endpoint behavior must be verified.

If any required write is unavailable to the registered third-party app, implementation stops at the feasibility result. v1 must not fall back to reverse-engineered private TIDAL endpoints or browser-session credentials without a new specification decision.

## 15. Acceptance Criteria

### Setup and Authorization

- A user can enter and save a TIDAL client ID and secret through the local UI.
- The secret and OAuth tokens are not returned to the browser or written to logs after submission.
- A user can complete TIDAL authorization through the registered localhost callback.
- A valid refresh token allows a later launch to resume without signing in again.

### Channel Selection

- The UI lists current visible channels from the public xmplaylist station endpoint.
- A user can select one channel by name/number.
- Selecting another channel prevents future old-channel runs and starts the new channel's yesterday/today sync after any active run finishes.

### Initial and Restart Sync

- At any local time, a first run fetches from yesterday at local midnight through the current instant.
- Plays are divided into playlists according to their local calendar date.
- No playlist is created for a date with zero resolved tracks.
- A restart re-fetches only yesterday and today and does not duplicate play IDs already marked synced.

### Matching

- A valid xmplaylist TIDAL link is parsed, validated in the US catalog, and used directly.
- A missing or invalid direct link triggers artist/title fallback search.
- Fallback ranking prefers matching original album tracks over unrelated live/remix/karaoke/tribute versions.
- Zero search results skip only that play and appear in run details.

### Playlist Writes

- Playlists created by this application use the exact `{Channel Name} - YYYY-MM-DD` format and are unlisted.
- An exactly matching single owned playlist is reused.
- A reused public playlist remains public and produces a UI warning.
- Different airplays of the same track create different playlist occurrences.
- Re-running a completed window adds no duplicate occurrences for the same xmplaylist play IDs.
- Tracks are appended oldest to newest within each run.
- Manual TIDAL removals and reordering are not undone.

### Scheduling and Controls

- Start performs an immediate sync and schedules the next local `:00` or `:30` run.
- Scheduler calculations remain clock-aligned rather than drifting by 30 minutes from the previous completion.
- Stop prevents future runs but lets an active run complete.
- Sync now performs one run while stopped without enabling the scheduler.
- Two sync runs never execute concurrently.

### Observability and Recovery

- The UI displays current status, last run, next run, counts, skipped plays, and recent errors.
- A transient external failure remains retryable and does not mark an airplay successfully synced.
- Persisted idempotency data allows safe immediate retry after a process or network interruption.
- Sensitive credential and token values are redacted from logs and UI status payloads.

## 16. Test Strategy

### Unit Tests

- Local-date calculation, including midnight and daylight-saving transitions
- Next `:00`/`:30` scheduler boundary calculation
- xmplaylist TIDAL-link parsing and hostile URL rejection
- xmplaylist cursor extraction and HTTPS host enforcement
- Result normalization and fallback scoring
- Alternate-version penalties
- Repeated-airplay handling by play ID
- State transitions and retry classification
- Playlist naming and description generation
- Secret/token redaction

### Integration Tests

- Mocked paginated xmplaylist responses crossing local midnight
- Mocked TIDAL OAuth callback, token refresh, search, playlist creation, and item writes
- Initial yesterday/today import
- Restart with partially processed state
- Contiguous scan-watermark recovery after a failed page fetch
- Duplicate track IDs attached to distinct play IDs
- Reconnection attempt with a different TIDAL user
- Existing playlist discovery and multiple-name ambiguity
- Partial TIDAL item-add response
- Crash/uncertain-response recovery using persisted idempotency keys
- Scheduler overlap prevention and queued Sync now behavior

### Live Tests

- Read-only xmplaylist contract test with a minimal request count
- Opt-in TIDAL feasibility gate from Section 14
- No live credential or mutation test runs automatically in CI

## 17. Implementation Sequence

1. Build and run the TIDAL feasibility smoke test.
2. Scaffold the Node.js local server, static UI, SQLite migrations, and redacted configuration routes.
3. Implement TIDAL PKCE authorization, token persistence, refresh, and disconnect.
4. Implement xmplaylist station listing, recent-play pagination, normalization, and persistence.
5. Implement direct TIDAL-ID validation, fallback search ranking, and mapping cache.
6. Implement playlist discovery/creation, repeated-track writes, idempotency, and play-ledger updates.
7. Implement initial/restart/channel-change windows and clock-aligned scheduling.
8. Implement controls, current status, recent-run details, and error reporting.
9. Add automated tests and complete opt-in live validation.

## 18. Known API Assumptions and Risks

- xmplaylist live responses include a `links` array, but its current OpenAPI response schema does not document it. The application must treat the direct TIDAL link as optional.
- xmplaylist does not document a fixed rate limit or `Retry-After` behavior.
- xmplaylist currently returns newest-first pages of 24 plays, but the application must not hard-code 24 as a contractual page size.
- xmplaylist currently emits insecure `http://` next links; the client will upgrade only known-host pagination requests to HTTPS.
- TIDAL's current OpenAPI scope declarations are internally inconsistent for some third-party user operations. Section 14 is a release blocker.
- TIDAL does not explicitly document repeated identical track behavior, append behavior without `positionBefore`, or preservation of multi-item request order. Section 14 verifies all three.
- TIDAL playlist and total item limits are not specified in the current schema. API errors must be surfaced if encountered.
- Adopting an existing same-name playlist without prior local state can duplicate tracks already added outside this application.
- Append-only behavior means a late-discovered older play may appear after newer entries rather than being inserted into exact historical order.
- A playlist can be created and remain temporarily empty if all writes fail after at least one track resolved. The next retry reuses that playlist; the no-empty-date rule means the app does not create one when zero tracks resolve.
- Plain-text credential/token storage is an explicitly accepted v1 tradeoff. Anyone who can read the SQLite file may be able to use those credentials or tokens.

## 19. References

- [xmplaylist API documentation](https://xmplaylist.com/docs)
- [xmplaylist OpenAPI specification](https://xmplaylist.com/api/spec)
- [TIDAL authorization documentation](https://developer.tidal.com/documentation/api-sdk/api-sdk-authorization)
- [TIDAL application management](https://developer.tidal.com/documentation/api-sdk/api-sdk-manage-apps)
- [TIDAL Web API reference](https://tidal-music.github.io/tidal-api-reference/)
- [TIDAL developer guidelines](https://developer.tidal.com/documentation/guidelines/guidelines-developer-guidelines)
