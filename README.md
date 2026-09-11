# xmsync

xmsync is a local Node.js 24 application that appends yesterday's and today's SiriusXM airplay from [xmplaylist.com](https://xmplaylist.com) to date-based TIDAL playlists.

## Run

1. Install Node.js 24 LTS.
2. Register `http://localhost:8787/auth/tidal/callback` as the callback URL in a TIDAL developer application.
3. Run `npm start`.
4. Enter the TIDAL client ID and secret, authorize TIDAL, select one channel, and choose **Start**.

The process binds only to `127.0.0.1:8787`. Its SQLite database is created at `data/xmsync.sqlite` and contains credentials and OAuth tokens in plain text. Keep that file private.

## Feasibility Gate

After connecting TIDAL, select **Run feasibility test** in the browser or run `npm run tidal:smoke` while xmsync is running. The opt-in test creates one unlisted temporary playlist, adds the same track twice, verifies both occurrences and append order, and deletes the playlist.

Do not rely on playlist writes until this test passes for the registered TIDAL application. No live credential or mutation test runs as part of `npm test`.

## Test

```text
npm test
```

The application has no third-party runtime dependencies or frontend build step.
