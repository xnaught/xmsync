const ids = ['notice', 'signal', 'connection-state', 'credential-state', 'credentials-form', 'connect-button',
  'disconnect-button', 'smoke-button', 'smoke-results', 'channel-filter', 'channel-picker', 'channel-list',
  'channel-count', 'selection-state', 'save-channels', 'saved-channels', 'start-button', 'stop-button',
  'sync-button', 'next-run', 'queue-status', 'scheduler-errors', 'last-run', 'runs-body', 'run-filter', 'refresh-button'];
const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
let currentStatus = null;
let channels = [];
let selectionLimit = 10;
let savedIds = [];
let stagedIds = new Set();

function showNotice(message, error = false, source = 'user') {
  el.notice.textContent = message;
  el.notice.dataset.source = source;
  el.notice.classList.toggle('error', error);
  el.notice.classList.remove('hidden');
}
function hideNotice() { el.notice.classList.add('hidden'); }
function formatTime(value, fallback = '--') {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : fallback;
}
function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body;
}
function channelName(id) { return channels.find((channel) => channel.id === id)?.name ?? id; }
function dirty() { return savedIds.join('\0') !== [...stagedIds].join('\0'); }

function renderChannelPicker() {
  const query = el['channel-filter'].value.trim().toLocaleLowerCase();
  const visible = channels.filter((channel) => stagedIds.has(channel.id) || !query || `${channel.number} ${channel.name}`.toLocaleLowerCase().includes(query));
  el['channel-list'].innerHTML = visible.length ? visible.map((channel) => {
    const checked = stagedIds.has(channel.id);
    const disabled = !checked && stagedIds.size >= selectionLimit;
    return `<label class="channel-option${channel.available ? '' : ' unavailable'}"><input type="checkbox" value="${escapeHtml(channel.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span><strong>CH ${escapeHtml(channel.number)} / ${escapeHtml(channel.name)}</strong><small>${channel.available ? '' : 'Unavailable in current catalog; saved snapshot retained'}</small></span></label>`;
  }).join('') : '<p class="muted">No channels match this filter.</p>';
  el['channel-count'].textContent = `${stagedIds.size} / ${selectionLimit} selected`;
  el['selection-state'].textContent = dirty() ? 'Unsaved channel changes' : 'Saved selection';
  el['selection-state'].classList.toggle('dirty', dirty());
  el['save-channels'].disabled = !dirty();
}

function renderSelectedChannels(status) {
  const queued = new Map(status.scheduler.queued.map((job, index) => [job.channel.id, index + 1]));
  const errors = new Map(status.scheduler.errors.filter((error) => error.scope === 'channel').map((error) => [error.channelId, error]));
  const latestByChannel = new Map(status.recentByChannel?.map((run) => [run.channelId, run]) ?? []);
  el['saved-channels'].innerHTML = status.selectedChannels.length ? status.selectedChannels.map((channel) => {
    const active = status.scheduler.current?.channel.id === channel.id;
    const queuedPosition = queued.get(channel.id);
    const error = errors.get(channel.id);
    const latest = latestByChannel.get(channel.id);
    const state = active ? 'Syncing' : queuedPosition ? `Queued #${queuedPosition}` : latest ? `${latest.status} / ${formatTime(latest.endedAt)}` : 'Waiting for first run';
    return `<article class="saved-channel"><strong>CH ${escapeHtml(channel.number)} / ${escapeHtml(channel.name)}</strong><span>${escapeHtml(state)}</span>${error ? `<small>${escapeHtml(error.message)}</small>` : ''}</article>`;
  }).join('') : '<p class="muted">No channels selected.</p>';
}

function renderStatus(status) {
  currentStatus = status;
  el.signal.className = `signal ${status.scheduler.state}`;
  el.signal.querySelector('span').textContent = status.scheduler.state.toUpperCase();
  el['connection-state'].textContent = status.auth.connected ? `Connected / ${status.auth.userId}` : status.auth.reauthorizationRequired ? 'Reconnect required' : 'Not connected';
  el['connection-state'].classList.toggle('connected', status.auth.connected);
  el['connect-button'].textContent = status.auth.connected ? 'Reconnect TIDAL' : 'Connect TIDAL';
  el['connect-button'].setAttribute('aria-disabled', String(!status.configured));
  el['disconnect-button'].disabled = !status.auth.connected;
  el['smoke-button'].disabled = !status.auth.connected || status.scheduler.state === 'syncing';
  el['next-run'].textContent = formatTime(status.scheduler.nextRunAt);
  const ready = status.configured && status.auth.connected && status.selectedChannels.length > 0;
  el['start-button'].disabled = !ready || status.scheduler.enabled;
  el['stop-button'].disabled = !status.scheduler.enabled;
  el['sync-button'].disabled = !ready;
  const current = status.scheduler.current;
  const queue = status.scheduler.queued;
  const sweep = status.scheduler.lastSweep;
  el['queue-status'].innerHTML = [current ? `<strong>${escapeHtml(current.channel.name)}, channel ${current.position} of ${current.total}</strong>` : '',
    queue.length ? `<span>Queued: ${queue.map((job) => escapeHtml(job.channel.name)).join(', ')}</span>` : '',
    sweep ? `<span>${escapeHtml(sweep.text)}</span>` : ''].filter(Boolean).join('');
  el['scheduler-errors'].innerHTML = status.scheduler.errors.map((error) => `<p>${escapeHtml(error.scope === 'account' ? 'TIDAL account' : channelName(error.channelId))}: ${escapeHtml(error.message)}</p>`).join('');
  const run = status.lastRun;
  el['last-run'].textContent = run ? `Latest channel run: ${run.channelName} (Ch. ${run.channelNumber ?? '--'}) / ${run.status} / ${formatTime(run.endedAt)}${run.error ? ` / ${run.error}` : ''}` : 'No completed sync yet.';
  document.querySelectorAll('[data-count]').forEach((node) => { node.textContent = run?.counts?.[node.dataset.count] ?? 0; });
  renderSelectedChannels(status);
}

function detailMarkup(detail) {
  const name = [detail.artist, detail.title].filter(Boolean).join(' / ') || detail.errorCode || detail.outcome;
  return `<div class="detail-item"><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail.errorMessage || detail.matchMethod || detail.outcome)}${detail.airplayAt ? ` / ${escapeHtml(formatTime(detail.airplayAt))}` : ''}</small></div>`;
}
function renderRuns(runs) {
  if (!runs.length) { el['runs-body'].innerHTML = '<tr><td colspan="9" class="empty">No runs recorded.</td></tr>'; return; }
  el['runs-body'].innerHTML = runs.map((run) => {
    const noteworthy = run.details.filter((item) => item.outcome !== 'synced');
    const details = noteworthy.length ? `<details><summary>${noteworthy.length} items</summary><div class="detail-list">${noteworthy.map(detailMarkup).join('')}</div></details>` : '<span class="muted">--</span>';
    return `<tr><td data-label="Channel"><strong>${escapeHtml(run.channelName)}</strong><small>CH ${escapeHtml(run.channelNumber ?? '--')}</small></td><td data-label="Time">${escapeHtml(formatTime(run.endedAt ?? run.startedAt))}</td><td data-label="Trigger">${escapeHtml(run.trigger)}</td><td data-label="Status" class="status-${escapeHtml(run.status)}">${escapeHtml(run.status)}</td><td data-label="Fetched">${run.counts.fetched}</td><td data-label="Synced">${run.counts.synced}</td><td data-label="Skipped">${run.counts.skipped}</td><td data-label="Failed">${run.counts.failed}</td><td data-label="Details">${details}</td></tr>`;
  }).join('');
}
async function loadSettings() {
  const settings = await api('/api/settings');
  el['credential-state'].textContent = settings.tidalConfigured ? `Saved client ${settings.clientIdMasked}; secret ${settings.clientSecretMasked}. Enter both values to replace them.` : 'No credentials saved.';
}
async function loadChannels(reset = true) {
  const result = await api('/api/channels');
  channels = result.channels;
  selectionLimit = result.selectionLimit;
  if (reset) {
    savedIds = channels.filter((channel) => channel.selected).sort((a, b) => a.selectedPosition - b.selectedPosition).map((channel) => channel.id);
    stagedIds = new Set(savedIds);
  }
  el['channel-filter'].disabled = false;
  el['channel-picker'].disabled = false;
  el['run-filter'].innerHTML = '<option value="">All channels</option>' + channels.filter((channel) => channel.selected).map((channel) => `<option value="${escapeHtml(channel.id)}">${escapeHtml(channel.name)}</option>`).join('');
  renderChannelPicker();
}
async function refresh() {
  try {
    const query = el['run-filter'].value ? `?channelId=${encodeURIComponent(el['run-filter'].value)}&limit=50` : '?limit=50';
    const [status, result] = await Promise.all([api('/api/status'), api(`/api/runs${query}`)]);
    renderStatus(status); renderRuns(result.runs);
  } catch (error) { showNotice(error.message, true); }
}

el['channel-list'].addEventListener('change', (event) => {
  if (event.target.type !== 'checkbox') return;
  if (event.target.checked) stagedIds.add(event.target.value); else stagedIds.delete(event.target.value);
  renderChannelPicker();
});
el['channel-filter'].addEventListener('input', renderChannelPicker);
el['save-channels'].addEventListener('click', async () => {
  try {
    const result = await api('/api/channels', { method: 'PUT', body: JSON.stringify({ ids: [...stagedIds] }) });
    await loadChannels(true); await refresh();
    const names = result.catchUpRequested.map(channelName);
    showNotice(names.length ? `Channels saved. Catch-up requested for ${names.join(', ')}.` : 'Channels saved.');
  } catch (error) { showNotice(error.message, true); }
});
el['credentials-form'].addEventListener('submit', async (event) => {
  event.preventDefault(); hideNotice(); const values = new FormData(event.currentTarget);
  try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ clientId: values.get('clientId'), clientSecret: values.get('clientSecret') }) }); event.currentTarget.reset(); await loadSettings(); await refresh(); showNotice('Credentials saved. Connect TIDAL to continue.'); } catch (error) { showNotice(error.message, true); }
});
el['disconnect-button'].addEventListener('click', async () => { try { await api('/api/tidal/disconnect', { method: 'POST' }); await refresh(); showNotice('TIDAL disconnected and scheduled syncing stopped.'); } catch (error) { showNotice(error.message, true); } });
el['smoke-button'].addEventListener('click', async () => {
  if (!window.confirm('This creates, writes to, reads, and deletes one temporary TIDAL playlist. Continue?')) return;
  el['smoke-button'].disabled = true; el['smoke-results'].classList.remove('hidden'); el['smoke-results'].textContent = 'Running live feasibility checks...';
  try { const result = await api('/api/tidal/smoke', { method: 'POST' }); el['smoke-results'].innerHTML = result.checks.map((check) => `<div><span>${escapeHtml(check.name)}</span><strong class="${check.passed ? 'pass' : 'fail'}">${check.passed ? 'PASS' : 'FAIL'} / ${escapeHtml(check.detail ?? '')}</strong></div>`).join(''); } catch (error) { el['smoke-results'].innerHTML = `<strong class="fail">${escapeHtml(error.message)}</strong>`; } finally { el['smoke-button'].disabled = false; }
});
el['connect-button'].addEventListener('click', (event) => { if (!currentStatus?.configured) { event.preventDefault(); showNotice('Save TIDAL developer credentials before connecting.', true); } });
for (const [id, path] of [['start-button', '/api/sync/start'], ['stop-button', '/api/sync/stop'], ['sync-button', '/api/sync/now']]) {
  el[id].addEventListener('click', async () => { try { const result = await api(path, { method: 'POST' }); await refresh(); const requested = result.requested?.length ?? result.cancelled?.length ?? 0; showNotice(path.endsWith('/stop') ? `Scheduled syncing stopped; ${requested} queued channel jobs cancelled.` : `${requested} channel syncs requested.`); } catch (error) { showNotice(error.message, true); } });
}
el['refresh-button'].addEventListener('click', refresh);
el['run-filter'].addEventListener('change', refresh);
const auth = new URLSearchParams(location.search);
if (auth.get('auth') === 'connected') showNotice('TIDAL connected successfully.');
if (auth.get('auth') === 'error') showNotice(`TIDAL authorization failed: ${auth.get('code')}`, true);
if (auth.has('auth')) history.replaceState({}, '', '/');
try { await Promise.all([loadSettings(), loadChannels(), refresh()]); } catch (error) { showNotice(`Could not initialize the application: ${error.message}`, true); }
setInterval(refresh, 4000);
