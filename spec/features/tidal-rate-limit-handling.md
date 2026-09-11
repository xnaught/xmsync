# TIDAL Rate-Limit Handling

## Status

Implemented.

## Problem

Synchronizing tracks from the previous day can require a large number of TIDAL API requests in a short period. TIDAL may respond with HTTP `429 Too Many Requests`, causing track resolution to fail.

The problem was amplified by the historical-sync workflow:

- Each uncached track can require direct-link validation followed by catalog search.
- Some search results require additional relationship or track-detail requests.
- Read requests can be retried after transient failures.
- After one track exhausted its retries with a `429`, the sync continued resolving later tracks, generating more requests while TIDAL was already applying backpressure.

TIDAL's published API reference does not specify a numeric request quota, so the client cannot target a documented requests-per-second limit.

## Resolution

TIDAL API traffic is now proactively paced and an exhausted rate limit is treated as run-wide backpressure.

### Request pacing

- API request starts are separated by at least 500 milliseconds by default.
- Retry attempts pass through the same pacing mechanism instead of bypassing it.
- The interval is defined by `TIDAL_REQUEST_INTERVAL_MS` in `src/constants.js`.
- OAuth token requests are not part of the catalog and playlist request stream and are not paced by this mechanism.

### HTTP 429 behavior

- Read requests retain their bounded retry policy.
- Short `Retry-After` values are honored before retrying.
- A `Retry-After` longer than the maximum in-run delay is not truncated into an early retry. The response is returned to the TIDAL client and the sync stops.
- The TIDAL client suppresses additional API calls until the reported cooldown expires.
- If TIDAL omits `Retry-After`, a 30-second fallback cooldown is used.
- Empty or malformed error bodies preserve the HTTP `429` status and retryable classification.

### Sync behavior

- An exhausted `429` while resolving a track records that track as failed and stops the current run.
- Later unresolved tracks remain pending for a future scheduled or manual run.
- A `429` during playlist discovery, recovery, or preparation stops processing later batches and dates.
- The run reports the TIDAL rate-limit error instead of replacing it with a generic item-failure error.

### Mutation safety

Playlist creation, item addition, and deletion still receive exactly one network attempt. The rate-limit changes do not introduce blind retries for mutations.

Persisted write batches, idempotency keys, pre-write anchors, and ambiguous-write recovery remain responsible for handling uncertain playlist mutation outcomes.

## Expected Outcome

Normal syncs issue requests at a conservative rate. Large historical syncs take longer, but are less likely to trigger TIDAL throttling. If throttling still occurs, the app stops generating additional load and safely resumes retryable work during a later run.

## Verification

Automated tests cover:

- Minimum spacing between TIDAL API requests.
- Avoiding an early retry when `Retry-After` exceeds the in-run wait limit.
- Suppressing requests during an active cooldown.
- Preserving single-attempt mutation behavior on `429`.
- Stopping historical track resolution after the first exhausted `429`.

The full test suite passes with these behaviors enabled.
