import { randomUUID } from 'node:crypto';
import { AppError } from './errors.js';

export async function runTidalSmokeTest(tidal) {
  const checks = [];
  let playlistId = null;
  let gateError = null;
  try {
    const user = await tidal.currentUser();
    checks.push({ name: 'Authenticated user', passed: Boolean(user?.id), detail: user?.id });

    const playlists = await tidal.allOwnedPlaylists();
    checks.push({ name: 'Owned playlist read', passed: Array.isArray(playlists), detail: `${playlists.length} found` });

    const track = await tidal.searchTrack({ title: 'Dreams', artists: ['Fleetwood Mac'] });
    const secondTrack = await tidal.searchTrack({ title: 'Billie Jean', artists: ['Michael Jackson'] });
    checks.push({ name: 'Catalog search', passed: Boolean(track?.id && secondTrack?.id), detail: [track?.id, secondTrack?.id].filter(Boolean).join(', ') });
    if (!track?.id || !secondTrack?.id) throw new AppError('SMOKE_SEARCH_FAILED', 'The smoke-test catalog search returned no track.');

    const validated = await tidal.validateTrack(track.id);
    const secondValidated = await tidal.validateTrack(secondTrack.id);
    checks.push({ name: 'Track usage rules', passed: validated === track.id && secondValidated === secondTrack.id, detail: validated && secondValidated ? 'US streaming permitted' : 'Unavailable' });
    if (!validated || !secondValidated) throw new AppError('SMOKE_TRACK_UNAVAILABLE', 'A smoke-test track is not streamable in the US catalog.');

    const name = `xmsync feasibility ${new Date().toISOString()}`;
    const created = await tidal.createPlaylist(name, 'Temporary xmsync API feasibility test. Safe to delete.', randomUUID());
    playlistId = created?.data?.id;
    checks.push({ name: 'Unlisted playlist create', passed: Boolean(playlistId), detail: playlistId });
    if (!playlistId) throw new AppError('SMOKE_CREATE_FAILED', 'TIDAL did not return the temporary playlist ID.');

    const added = await tidal.addPlaylistItems(playlistId, [{ trackId: track.id }, { trackId: secondTrack.id }, { trackId: track.id }], randomUUID());
    const successful = (added.data ?? []).filter((item) => item.id === track.id);
    checks.push({ name: 'Repeated track write', passed: successful.length === 2, detail: `${successful.length} occurrences returned` });

    let items = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      items = await tidal.playlistItems(playlistId);
      if (items.length >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const suffix = items.slice(-3);
    const ordered = suffix.length === 3 && suffix[0].id === track.id && suffix[1].id === secondTrack.id && suffix[2].id === track.id &&
      suffix[0].meta?.itemId !== suffix[2].meta?.itemId;
    checks.push({ name: 'Append order and occurrences', passed: ordered, detail: `${suffix.length} ordered items read` });
  } catch (error) {
    gateError = error;
    checks.push({ name: 'Feasibility gate', passed: false, detail: error.message });
  } finally {
    if (playlistId) {
      try {
        await tidal.deletePlaylist(playlistId, randomUUID());
        checks.push({ name: 'Temporary playlist cleanup', passed: true, detail: playlistId });
      } catch (error) {
        checks.push({ name: 'Temporary playlist cleanup', passed: false, detail: error.message });
      }
    }
  }
  const passed = !gateError && checks.every((check) => check.passed);
  return { passed, checks, error: gateError?.message ?? null };
}
