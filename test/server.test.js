import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '../src/database.js';
import { createHttpServer } from '../src/server.js';

test('local API redacts credentials and rejects non-same-origin mutations', async (context) => {
  const database = new Database(':memory:');
  const coordinator = { active: false, current: null, queued: [], errors: new Map(), accountError: null };
  const scheduler = {
    nextRunAt: null,
    stop() { database.setSchedulerEnabled(false); },
    arm() {},
    selectionChanged() { return { requested: [] }; },
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

test('channel selection API validates and atomically saves multiple channels', async (context) => {
  const database = new Database(':memory:');
  const catalog = [
    { id: 'a', deeplink: 'a', name: 'Blend', number: '1' },
    { id: 'b', deeplink: 'b', name: ' blend ', number: '2' },
  ];
  const coordinator = { active: false, current: null, queued: [], errors: new Map(), accountError: null };
  const scheduler = {
    nextRunAt: null, stop() { return { active: null, cancelled: [] }; }, arm() {},
    selectionChanged(added) { return { requested: added.map((channel) => channel.id) }; }, start() {}, syncNow() {},
  };
  const server = createHttpServer({ database, xm: { async listChannels() { return catalog; } }, tidal: {}, coordinator, scheduler });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    database.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const put = (ids) => fetch(`${base}/api/channels`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8787' }, body: JSON.stringify({ ids }),
  });
  const duplicate = await put(['a', 'a']);
  assert.equal(duplicate.status, 400);
  const nullBody = await fetch(`${base}/api/channels`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8787' }, body: 'null',
  });
  assert.equal(nullBody.status, 400);
  const saved = await put(['a', 'b']);
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual(body.channels.map((channel) => channel.id), ['a', 'b']);
  assert.deepEqual(body.channels.map((channel) => channel.playlistLabel), ['Blend (Ch. 1)', 'blend (Ch. 2)']);
  assert.deepEqual(body.catchUpRequested, ['a', 'b']);
  const listed = await (await fetch(`${base}/api/channels`)).json();
  assert.equal(listed.selectionLimit, 10);
  assert.deepEqual(listed.channels.filter((channel) => channel.selected).map((channel) => channel.id), ['a', 'b']);
});
