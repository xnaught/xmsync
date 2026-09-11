import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../src/database.js';
import { createHttpServer } from '../src/server.js';

test('local API redacts credentials and rejects non-same-origin mutations', async (context) => {
  const database = new Database(':memory:');
  const coordinator = { active: false, current: null, queued: null, lastError: null };
  const scheduler = {
    nextRunAt: null,
    stop() { database.setSchedulerEnabled(false); },
    arm() {},
    channelChanged() {},
    start() {},
    syncNow() {},
  };
  const server = createHttpServer({
    database,
    xm: { async listChannels() { return []; } },
    tidal: {},
    coordinator,
    scheduler,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const payload = JSON.stringify({ clientId: 'client-identifier', clientSecret: 'super-secret-value' });

  const rejected = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: payload });
  assert.equal(rejected.status, 403);

  const saved = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8787' },
    body: payload,
  });
  assert.equal(saved.status, 200);
  const savedText = await saved.text();
  assert.doesNotMatch(savedText, /super-secret-value/);
  assert.match(savedText, /supe\*+alue/);

  const statusText = await (await fetch(`${base}/api/status`)).text();
  assert.doesNotMatch(statusText, /super-secret-value|client-identifier/);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
});
