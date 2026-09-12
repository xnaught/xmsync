# Repository Guide

## Project specs and features

- These are markdown documents in the `spec` directory.
- Add each new feature written up in `spec/features/` to the pending section of `spec/backlog.md`.
- When a feature is complete, mark it as completed in `spec/backlog.md`.
- The spec we used to make the initial version of this application is in `spec/ORIGINAL-SPEC.md`. This is interesting from an historical perspective, but has likely drifted in terms of accuracy.

## Toolchain And Commands

- Use Node.js 24 or newer. The code depends on native `node:sqlite`, global `fetch`, and `Map.groupBy`.
- This is dependency-free ESM: there is no install step, lockfile, frontend build, lint, format, or typecheck command. Keep explicit `.js` suffixes on relative imports.
- Run from the repository root because the default database path is relative: `data/xmsync.sqlite`.
- Start with `npm start`; use `npm run start:no-open` when browser launch is undesirable. The server is fixed to `127.0.0.1:8787`.
- Run all tests with `npm test`. Run one file with `node --test test/scheduler.test.js`, or one named test with `node --test --test-name-pattern="clock-aligned" test/scheduler.test.js`.

## Architecture

- `src/index.js` owns startup and graceful shutdown; `src/app.js` is the composition root and dependency-injection seam.
- `src/server.js` is a native `node:http` server for both the JSON API and the directly served `public/` assets; there is no web framework or generated frontend output.
- `src/sync-engine.js` owns scanning, matching, playlist adoption/creation, append batching, and persisted write recovery. `src/scheduler.js` serializes runs and schedules the next local wall-clock `:00` or `:30` boundary.
- Tests rely on constructor/options injection for API clients, clocks, timers, and `fetch`; preserve those seams instead of introducing global mocks.

## State And Security

- `data/` is ignored runtime state, not a fixture directory. It can contain SQLite WAL files, TIDAL client credentials, and OAuth tokens in plaintext; do not inspect, modify, or commit it during routine work.
- Use `new Database(':memory:')` in tests. `Database.transaction` callbacks must remain synchronous because commit occurs immediately after the callback returns.
- TIDAL OAuth requires the exact callback `http://localhost:8787/auth/tidal/callback`. A database is permanently bound to the first connected TIDAL user unless local data is deleted.
- Preserve exact localhost same-origin checks on mutating HTTP routes and keep credentials/tokens out of status and error responses. Expected operational failures use `AppError` metadata; unexpected errors are intentionally hidden from clients.

## Sync Invariants

- Airplay identity is the XM play ID, not the track ID. Repeated broadcasts of one track must remain distinct, oldest-first playlist occurrences; writes are chunked at 50 items.
- Playlist names are exactly `{Channel Name} - YYYY-MM-DD`. Date grouping and the yesterday-midnight scan cutoff use the host's local timezone.
- Runs never overlap and retain at most one queued follow-up; a channel-change request replaces an older queued job. Stopping scheduling does not abort an active run.
- A failed pagination scan must not advance the contiguous watermark, but already persisted plays may still sync. `failed` plays are retryable; no-match plays become `skipped`.
- TIDAL mutations deliberately get one network attempt. Persisted `write_batches`, pre-write anchors, and the one-hour idempotency window prevent duplicate appends; never add blind mutation retries or discard ambiguous-write state.

## Live Verification

- `npm test` is isolated: it uses in-memory SQLite and mocked external clients and makes no live XM or TIDAL mutations.
- `npm run tidal:smoke` is an opt-in live gate, not routine verification. It requires the app already running and TIDAL connected, creates and writes an unlisted temporary playlist, then attempts deletion; a cleanup failure can leave that playlist behind.
