# Multi-Channel Rate-Limit Hardening

## Status

Implemented.

## Problem

Multi-channel sync correctly runs channels serially through one shared TIDAL client, so the existing request pacing, bounded retries, cooldown, and single-attempt mutation behavior remain in effect. The xmplaylist client also retains its existing bounded retry behavior. However, the interaction between API errors and the new cross-channel coordinator has three gaps:

- The coordinator treats every HTTP `429` as account-wide. An exhausted xmplaylist `429` therefore cancels later channels even though xmplaylist failures are channel-local.
- `SyncEngine.run()` preserves its first error. An earlier channel-local scan error can therefore hide a later TIDAL authorization failure or exhausted `429`, preventing the coordinator from dropping queued TIDAL-dependent jobs.
- TIDAL pacing reserves request times before sleeping without serializing the complete request attempt. A concurrent caller that is already waiting can reach the network after another request establishes a cooldown, and delayed timers can compress previously reserved request starts.

These gaps do not justify increasing request throughput or retrying mutations. The fix must strengthen service attribution and shared backpressure while preserving the existing safety invariants.

## Goals

- Distinguish xmplaylist rate limits from TIDAL account-wide rate limits without relying on HTTP status alone.
- Continue later channel jobs after an xmplaylist `429` exhausts its bounded retries.
- Drop all queued TIDAL-dependent jobs after any TIDAL authorization failure or exhausted TIDAL `429`, even when an earlier channel-local error occurred in the same run.
- Enforce TIDAL request spacing and cooldown across all callers of the shared client, including sync, feasibility smoke tests, and overlapping local HTTP requests.
- Preserve TIDAL bounded read retries, `Retry-After` handling, fallback cooldown, token-refresh coalescing, and one-attempt mutation behavior.
- Preserve xmplaylist bounded retries and serial channel scans.
- Add regression tests that exercise failures through the real engine/coordinator boundary rather than only testing components in isolation.

## Non-Goals

- Adding an undocumented xmplaylist requests-per-second policy.
- Running channel syncs concurrently.
- Retrying TIDAL playlist mutations.
- Aborting an active HTTP request or active channel run.
- Persisting cooldown state across process restarts.
- Changing scheduling frequency, channel selection limits, scan pagination, or playlist batching.
- Coordinating request limits across multiple xmsync processes or computers.

## Error Attribution

Operational errors emitted by an external API client must carry internal service attribution. Extend `AppError` with an optional `service` value and use the stable values `tidal` and `xmplaylist`.

Each client is responsible for attaching its service to every error crossing its public API boundary, including:

- HTTP failures.
- Invalid or malformed responses.
- Request timeout and network failures produced by the shared request helper.
- Locally generated cooldown errors.
- Off-host or otherwise invalid pagination links.

This includes validation performed outside the shared request helper. For example, xmplaylist cursor validation currently occurs in the sync engine after a page is returned, so those errors must either be attributed where they are created or moved behind the attributed client boundary. An attribution helper must fill only a missing `service`; it must never overwrite an origin already attached by another boundary.

Service attribution is internal control-flow metadata. It is not added to status responses or otherwise exposed unless a future public API explicitly requires it. Existing public error codes and messages remain unchanged.

The implementation must not classify a failure by matching an error-code prefix. Explicit metadata avoids coupling coordinator behavior to error-code spelling and ensures wrapped network errors retain their origin.

## Failure Scope

Add one shared failure-classification function used by the coordinator and, where needed, by the sync engine. It classifies errors as follows:

| Condition | Scope | Coordinator behavior |
| --- | --- | --- |
| `service === 'tidal'` and `status === 429` | Account | Record the account error and cancel all queued jobs |
| TIDAL authorization loss or required reauthorization | Account | Record the account error and cancel all queued jobs |
| xmplaylist HTTP failure, including `429` | Channel | Record the channel error and continue the queue |
| TIDAL non-auth failure other than `429` | Channel | Preserve the existing run and mutation-safety behavior, then continue when safe |
| Expected local application error | Channel | Record the channel error and continue the queue |
| Unexpected coordinator or database error | Process | Stop the pump and cancel queued jobs |

Authorization classification remains explicit through `authRequired`; TIDAL client boundaries must attach `service: 'tidal'` to those errors as well. The coordinator must never use bare `status === 429` as an account-wide test.

An exhausted xmplaylist `429` still receives the existing bounded retry and `Retry-After` behavior before reaching the coordinator. Continuing the queue does not retry that failed channel again in the same sweep.

## Run Error Precedence

`SyncEngine.run()` must retain useful channel-local diagnostics while guaranteeing that account-wide TIDAL backpressure reaches the coordinator.

Replace first-error-wins behavior with explicit precedence:

1. Unexpected process/invariant failure.
2. TIDAL authorization failure or exhausted TIDAL `429`.
3. Unsafe or ambiguous mutation failure.
4. Other expected channel-local error.

When a new error has higher precedence than the current run error, it becomes the returned run error and the persisted run's top-level error. Existing run-item rows continue to preserve earlier failures, so replacing the top-level error does not erase the xmplaylist scan diagnostic.

An unexpected process or invariant failure must also short-circuit the remainder of the current channel run. In particular, an unexpected scan or database failure must not be recorded as if it were an ordinary channel-local scan failure and followed by additional TIDAL work.

In particular:

- A scan failure followed by a TIDAL `429` returns the TIDAL `429`.
- A scan failure followed by TIDAL authorization loss returns the authorization failure.
- A TIDAL account-wide failure is never replaced by a later generic item-failure error.
- A lone xmplaylist failure remains the run's top-level channel-local error.

Once a TIDAL authorization failure or exhausted `429` is observed, the engine stops further TIDAL work in the current channel. Unprocessed plays remain pending, while any play already associated with the failed operation retains the existing retryable failure state.

## Serialized TIDAL Request Gate

Replace request-time reservation with one client-wide asynchronous gate for TIDAL API request attempts. OAuth token endpoint requests remain outside this gate, matching the existing policy.

For every catalog or playlist API attempt, including retries, the gate must:

1. Wait for the previous gated attempt to receive a response or fail.
2. Re-read the current clock after acquiring the gate.
3. Reject locally without calling `fetch` when `blockedUntil` is still active.
4. Wait until the previous actual request start plus `TIDAL_REQUEST_INTERVAL_MS`.
5. Re-read `blockedUntil` after any wait and reject locally if a cooldown became active.
6. Record the actual request start time immediately before calling `fetch`.
7. Keep the gate until the attempt receives a response or throws, then release it for the next waiter.

Holding the gate through the response intentionally permits only one in-flight TIDAL API attempt per application process. This is consistent with serial sync execution and prevents a queued caller from starting before a prior response can establish account-wide cooldown.

The gate must be exception-safe: timeout, network, parsing, or caller errors cannot leave later requests permanently blocked. Queue order should be FIFO so smoke-test or UI traffic cannot repeatedly overtake sync traffic.

`fetchWithRetry` must continue to invoke the gate for every read retry. The implementation may add an attempt wrapper to the retry policy instead of forcing pacing into `beforeAttempt`, but it must not change:

- Three attempts for ordinary TIDAL reads.
- One attempt for TIDAL mutations.
- Two attempts for OAuth token requests.
- The existing retryable status set and maximum in-run `Retry-After` delay.
- Mutation `unsafeWrite` classification.

When an attempt returns final HTTP `429`, the shared client establishes `blockedUntil` before releasing the gate. Every already queued caller then observes the cooldown and fails without reaching the network.

## XM Request Behavior

xmplaylist requests retain the existing shared request helper behavior:

- At most three attempts.
- A 15-second timeout per attempt.
- Retries for `429`, `500`, `502`, `503`, and `504`.
- Short `Retry-After` handling and bounded exponential backoff.

Channel scans remain serial because the coordinator awaits one complete `SyncEngine.run()` before starting the next. This feature does not add a speculative xmplaylist pacing interval. The channel catalog endpoints may still overlap a scan; adding a global xmplaylist request gate requires separate evidence of an API quota and is outside this change.

## Implementation Steps

1. Add optional service attribution to `AppError` and a small helper for attaching attribution to errors at an API-client boundary without replacing existing metadata.
2. Attribute all TIDAL and xmplaylist client errors, including errors originating in `fetchWithRetry` and `responseJson`.
3. Introduce shared failure-scope and precedence helpers with direct unit coverage.
4. Update `SyncEngine.run()` to promote account-wide TIDAL failures over earlier channel-local failures and stop further TIDAL work.
5. Update `RunCoordinator` to cancel queued jobs only for explicitly classified account-wide TIDAL failures or unexpected process failures.
6. Replace the TIDAL timestamp-reservation pacer with the serialized, exception-safe request-attempt gate.
7. Add component and integration regression tests described below.
8. Run the complete isolated test suite. Do not run the live TIDAL smoke test as routine verification.

## Acceptance Criteria

- One shared TIDAL client continues to serve all selected channels.
- Channel runs remain FIFO and never overlap.
- TIDAL API request attempts are separated by at least `TIDAL_REQUEST_INTERVAL_MS`, measured from actual request start times.
- Only one TIDAL API attempt is in flight at a time within the process.
- Every read retry passes through the same request gate.
- A final TIDAL `429` establishes cooldown before another queued caller can reach the network.
- Requests submitted during cooldown fail locally and make no TIDAL network call.
- TIDAL reads retain three attempts and mutations retain exactly one attempt.
- An xmplaylist `429` exhausts its existing retries, fails only that channel, and does not cancel later channels.
- A TIDAL `429` or authorization failure cancels every currently queued channel job.
- A prior xmplaylist or other channel-local error cannot mask a later TIDAL account-wide failure.
- Earlier channel-local diagnostics remain available in run-item history when a higher-priority error becomes the top-level run error.
- Unexpected process or invariant failures stop the current channel before additional external work and cancel queued channel jobs.
- Public status and error responses do not expose new internal service metadata or credentials.
- Existing write-batch, idempotency, and ambiguous-mutation behavior is unchanged.
- The full isolated test suite passes.

## Verification

Automated tests must cover:

- An xmplaylist `429` returned by `SyncEngine.run()` remains channel-local and the coordinator starts the next queued channel.
- A TIDAL `429` returned by `SyncEngine.run()` records an account error and prevents later queued channels from starting.
- Identical HTTP `429` statuses from xmplaylist and TIDAL receive different coordinator behavior based on explicit service attribution.
- An xmplaylist scan failure followed by a TIDAL `429` returns the TIDAL failure while retaining the scan run item.
- An xmplaylist scan failure followed by TIDAL authorization loss returns the authorization failure and clears the queue.
- A lower-priority later failure cannot replace an already observed account-wide TIDAL failure.
- Network, timeout, malformed-response, cooldown, and invalid-pagination errors retain the service attribution of the client boundary that emitted them.
- An unexpected scan or database failure performs no later TIDAL work in that channel and causes the coordinator to clear its queue.
- Two concurrent TIDAL reads are FIFO, never overlap, and begin at least 500 milliseconds apart under a fake clock.
- If the first of two concurrent TIDAL reads returns a final `429`, the second rejects from cooldown without calling `fetch`.
- A delayed timer does not compress actual request starts below the configured interval.
- A timeout or network exception releases the request gate so a later request can proceed according to retry and cooldown policy.
- Every retry attempt is paced through the gate.
- Long `Retry-After`, fallback cooldown, token refresh, and single-attempt mutation tests continue to pass.
- XM retry counts and short/long `Retry-After` behavior remain unchanged.

Use in-memory SQLite and injected clocks, timers, sleep functions, and `fetch` implementations. The full `npm test` suite is the required verification gate. Live TIDAL or xmplaylist calls are neither required nor appropriate for this change.

At proposal review, the existing isolated suite passes on Node.js 24 and covers sequential TIDAL pacing, long `Retry-After`, single-attempt rate-limited mutations, stopping resolution after a TIDAL `429`, and coordinator handling of authorization loss. It does not cover concurrent TIDAL callers, service-specific `429` handling, cross-phase error precedence, or process-failure short-circuiting; those remain required feature regressions above.
