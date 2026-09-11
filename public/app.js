const elements = Object.fromEntries([
  'notice', 'signal', 'connection-state', 'credential-state', 'credentials-form', 'connect-button', 'disconnect-button',
  'smoke-button', 'smoke-results', 'channel-select', 'select-channel', 'channel-number', 'selected-channel',
  'start-button', 'stop-button', 'sync-button', 'next-run', 'last-run', 'meters', 'runs-body', 'refresh-button',
].map((id) => [id, document.getElementById(id)]));
Object.assign(elements, {
  connectionState: elements['connection-state'],
  credentialState: elements['credential-state'],
  credentialsForm: elements['credentials-form'],
  connectButton: elements['connect-button'],
  disconnectButton: elements['disconnect-button'],
  smokeButton: elements['smoke-button'],
  smokeResults: elements['smoke-results'],
  channelSelect: elements['channel-select'],
  selectChannel: elements['select-channel'],
  channelNumber: elements['channel-number'],
  selectedChannel: elements['selected-channel'],
  startButton: elements['start-button'],
  stopButton: elements['stop-button'],
  syncButton: elements['sync-button'],
  nextRun: elements['next-run'],
  lastRun: elements['last-run'],
  runsBody: elements['runs-body'],
  refreshButton: elements['refresh-button'],
});

let currentStatus = null;
let channels = [];

function showNotice(message, error = false, source = 'user') {
  elements.notice.textContent = message;
  elements.notice.dataset.source = source;
  elements.notice.classList.toggle('error', error);
  elements.notice.classList.remove('hidden');
}

function hideNotice() {
  elements.notice.classList.add('hidden');
}

function formatTime(value, fallback = '--') {
  if (!value) return fallback;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body;
}

function renderStatus(status) {
  currentStatus = status;
  const state = status.scheduler.state;
  elements.signal.className = `signal ${state}`;
  elements.signal.querySelector('span').textContent = state.toUpperCase();
  elements.connectionState = elements['connection-state'];
  elements.connectionState.textContent = status.auth.connected ? `Connected / ${status.auth.userId}` : status.auth.reauthorizationRequired ? 'Reconnect required' : 'Not connected';
  elements.connectionState.classList.toggle('connected', status.auth.connected);
  elements.connectButton = elements['connect-button'];
  elements.connectButton.textContent = status.auth.connected ? 'Reconnect TIDAL' : 'Connect TIDAL';
  elements.connectButton.setAttribute('aria-disabled', String(!status.configured));
  elements.disconnectButton = elements['disconnect-button'];
  elements.disconnectButton.disabled = !status.auth.connected;
  elements.smokeButton = elements['smoke-button'];
  elements.smokeButton.disabled = !status.auth.connected || status.scheduler.state === 'syncing';

  const channel = status.channel;
  elements.selectedChannel = elements['selected-channel'];
  elements.channelNumber = elements['channel-number'];
  elements.selectedChannel.textContent = channel ? `${channel.name} / channel ${channel.number}` : 'No channel selected';
  elements.channelNumber.textContent = channel ? `CH ${channel.number}` : 'CH --';
  if (channel && elements.channelSelect) elements.channelSelect.value = channel.id;

  elements.nextRun = elements['next-run'];
  elements.nextRun.textContent = formatTime(status.scheduler.nextRunAt);
  const ready = status.configured && status.auth.connected && Boolean(channel);
  elements.startButton = elements['start-button'];
  elements.stopButton = elements['stop-button'];
  elements.syncButton = elements['sync-button'];
  elements.startButton.disabled = !ready || status.scheduler.enabled;
  elements.stopButton.disabled = !status.scheduler.enabled;
  elements.syncButton.disabled = !ready;

  const run = status.lastRun;
  elements.lastRun = elements['last-run'];
  elements.lastRun.textContent = run ? `Last ${run.status} run: ${formatTime(run.endedAt)}${run.error ? ` / ${run.error}` : ''}` : 'No completed sync yet.';
  document.querySelectorAll('[data-count]').forEach((node) => {
    node.textContent = run?.counts?.[node.dataset.count] ?? 0;
  });
  if (status.scheduler.error) showNotice(status.scheduler.error, true, 'scheduler');
  else if (elements.notice.dataset.source === 'scheduler') hideNotice();
}

function detailMarkup(detail) {
  const name = [detail.artist, detail.title].filter(Boolean).join(' / ') || detail.errorCode || detail.outcome;
  const reason = detail.errorMessage || detail.matchMethod || detail.outcome;
  return `<div class="detail-item"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(reason)}${detail.airplayAt ? ` / ${escapeHtml(formatTime(detail.airplayAt))}` : ''}</small></div>`;
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function renderRuns(runs) {
  elements.runsBody = elements['runs-body'];
  if (!runs.length) {
    elements.runsBody.innerHTML = '<tr><td colspan="8" class="empty">No runs recorded.</td></tr>';
    return;
  }
  elements.runsBody.innerHTML = runs.map((run) => {
    const noteworthy = run.details.filter((item) => item.outcome !== 'synced');
    const details = noteworthy.length
      ? `<details><summary>${noteworthy.length} items</summary><div class="detail-list">${noteworthy.map(detailMarkup).join('')}</div></details>`
      : '<span class="muted">--</span>';
    return `<tr><td>${escapeHtml(formatTime(run.endedAt ?? run.startedAt))}</td><td>${escapeHtml(run.trigger)}</td><td class="status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</td><td>${run.counts.fetched}</td><td>${run.counts.synced}</td><td>${run.counts.skipped}</td><td>${run.counts.failed}</td><td>${details}</td></tr>`;
  }).join('');
}

async function loadSettings() {
  const settings = await api('/api/settings');
  elements.credentialState = elements['credential-state'];
  elements.credentialState.textContent = settings.tidalConfigured
    ? `Saved client ${settings.clientIdMasked}; secret ${settings.clientSecretMasked}. Enter both values to replace them.`
    : 'No credentials saved.';
}

async function loadChannels() {
  try {
    const result = await api('/api/channels');
    channels = result.channels;
    elements.channelSelect = elements['channel-select'];
    elements.channelSelect.innerHTML = '<option value="">Choose a channel</option>' + channels.map((channel) =>
      `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.number)} / ${escapeHtml(channel.name)}</option>`).join('');
    elements.channelSelect.disabled = false;
    elements.selectChannel.disabled = false;
    if (currentStatus?.channel) elements.channelSelect.value = currentStatus.channel.id;
  } catch (error) {
    showNotice(`Could not load SiriusXM channels: ${error.message}`, true);
  }
}

async function refresh() {
  try {
    const [status, result] = await Promise.all([api('/api/status'), api('/api/runs')]);
    renderStatus(status);
    renderRuns(result.runs);
  } catch (error) {
    showNotice(error.message, true);
  }
}

elements.credentialsForm = elements['credentials-form'];
elements.credentialsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  hideNotice();
  const form = event.currentTarget;
  const values = new FormData(form);
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ clientId: values.get('clientId'), clientSecret: values.get('clientSecret') }) });
    form.reset();
    await loadSettings();
    await refresh();
    showNotice('Credentials saved. Connect TIDAL to continue.');
  } catch (error) { showNotice(error.message, true); }
});

elements.disconnectButton.addEventListener('click', async () => {
  try {
    await api('/api/tidal/disconnect', { method: 'POST' });
    await refresh();
    showNotice('TIDAL disconnected and scheduled syncing stopped.');
  } catch (error) { showNotice(error.message, true); }
});

elements.smokeButton.addEventListener('click', async () => {
  if (!window.confirm('This creates, writes to, reads, and deletes one temporary TIDAL playlist. Continue?')) return;
  elements.smokeButton.disabled = true;
  elements.smokeResults = elements['smoke-results'];
  elements.smokeResults.classList.remove('hidden');
  elements.smokeResults.textContent = 'Running live feasibility checks...';
  try {
    const result = await api('/api/tidal/smoke', { method: 'POST' });
    elements.smokeResults.innerHTML = result.checks.map((check) =>
      `<div><span>${escapeHtml(check.name)}</span><strong class="${check.passed ? 'pass' : 'fail'}">${check.passed ? 'PASS' : 'FAIL'} / ${escapeHtml(check.detail ?? '')}</strong></div>`).join('');
  } catch (error) {
    elements.smokeResults.innerHTML = `<strong class="fail">${escapeHtml(error.message)}</strong>`;
  } finally { elements.smokeButton.disabled = false; }
});

elements.selectChannel = elements['select-channel'];
elements.selectChannel.addEventListener('click', async () => {
  const id = elements.channelSelect.value;
  if (!id) return showNotice('Choose a SiriusXM channel first.', true);
  try {
    await api('/api/channel', { method: 'PUT', body: JSON.stringify({ id }) });
    await refresh();
    showNotice('Channel selected. A catch-up sync was requested if TIDAL is connected.');
  } catch (error) { showNotice(error.message, true); }
});

elements.connectButton.addEventListener('click', (event) => {
  if (!currentStatus?.configured) {
    event.preventDefault();
    showNotice('Save TIDAL developer credentials before connecting.', true);
  }
});

for (const [key, path] of [['startButton', '/api/sync/start'], ['stopButton', '/api/sync/stop'], ['syncButton', '/api/sync/now']]) {
  elements[key] = elements[key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)] ?? elements[key];
  elements[key].addEventListener('click', async () => {
    hideNotice();
    try {
      await api(path, { method: 'POST' });
      await refresh();
      showNotice(path.endsWith('/start') ? 'Scheduled syncing started.' : path.endsWith('/stop') ? 'Scheduled syncing stopped.' : 'Sync requested.');
    } catch (error) { showNotice(error.message, true); }
  });
}

elements.refreshButton = elements['refresh-button'];
elements.refreshButton.addEventListener('click', refresh);

const auth = new URLSearchParams(location.search);
if (auth.get('auth') === 'connected') showNotice('TIDAL connected successfully.');
if (auth.get('auth') === 'error') showNotice(`TIDAL authorization failed: ${auth.get('code')}`, true);
if (auth.has('auth')) history.replaceState({}, '', '/');

try {
  await Promise.all([loadSettings(), refresh()]);
} catch (error) {
  showNotice(`Could not initialize the application: ${error.message}`, true);
}
await loadChannels();
setInterval(refresh, 4000);
