/**
 * Dashboard music preferences. Catalog is supplied by the operator as
 * licensed/approved tracks; never infer rights from the NCS label alone.
 * Track source URLs and local filesystem paths are not sent to the browser.
 */
export function musicCatalogFromEnv(env = process.env) {
  let raw;
  try { raw = JSON.parse(env.OBS_MUSIC_LIBRARY_JSON || '[]'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.slice(0, 250).flatMap(item => {
    if (!item || typeof item !== 'object' ||
        typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) ||
        seen.has(item.id) || typeof item.title !== 'string' ||
        !item.title.trim() || item.title.length > 160) return [];
    seen.add(item.id);
    return [{ id: item.id, title: item.title.trim(),
      artist: typeof item.artist === 'string' ? item.artist.slice(0, 100) : '',
      license: typeof item.license === 'string' ? item.license.slice(0, 180) : 'UNVERIFIED',
      streamApproved: item.streamApproved === true }];
  });
}
export function normalizeMusicPreferences(input = {}, catalog = [], previous = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw Error('Invalid music settings');
  const ids = catalog.filter(x => x.streamApproved).map(x => x.id);
  const rawSelection = input.selectedTrackIds ?? previous.selectedTrackIds ?? ids;
  if (!Array.isArray(rawSelection) || rawSelection.length > 250 ||
      rawSelection.some(id => typeof id !== 'string' || !ids.includes(id))) {
    throw Error('Only approved catalog tracks can be selected');
  }
  const volume = input.volume ?? previous.volume ?? 22;
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw Error('Music volume must be 0–100');
  const bool = (k, fallback) => {
    const v = input[k] ?? previous[k] ?? fallback;
    if (typeof v !== 'boolean') throw Error('Invalid ' + k);
    return v;
  };
  return {
    selectedTrackIds: [...new Set(rawSelection)],
    autoStart: bool('autoStart', true),
    shuffle: bool('shuffle', true),
    autoNext: bool('autoNext', true),
    volume
  };
}
export function publicMusicCatalog(catalog) {
  return catalog.map(({id,title,artist,license,streamApproved}) => ({id,title,artist,license,streamApproved}));
}
