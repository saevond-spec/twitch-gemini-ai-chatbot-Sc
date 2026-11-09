import { randomInt } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';

const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const GENRES = new Set(['mixed','club-house','dubstep-bass','pop-trap']);

export function validateMusicProfile(raw, allowedHosts) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Invalid music sync data');
  const volume = raw.volume;
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw Error('Invalid music gain');
  const hosts = new Set((allowedHosts || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean));
  if (!Array.isArray(raw.tracks) || raw.tracks.length > 250) throw Error('Invalid track selection');
  const selected = []; const seen = new Set();
  for (const song of raw.tracks) {
    if (!song || !ID.test(song.id || '') || seen.has(song.id)) continue;
    let url;
    try { url = new URL(song.sourceUrl); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.port || !hosts.has(url.hostname.toLowerCase()) ||
      /[\r\n'\\]/.test(song.sourceUrl)) continue;
    seen.add(song.id);
    selected.push({ id:song.id, title:String(song.title || song.id).slice(0,160),
      genre:GENRES.has(song.genre)?song.genre:'mixed', sourceUrl:url.href });
  }
  const gameVolume = Number.isInteger(raw.gameVolume) && raw.gameVolume >= 0 &&
    raw.gameVolume <= 100 ? raw.gameVolume : 85;
  return { autoStart:raw.autoStart === true, shuffle:raw.shuffle === true,
    autoNext:raw.autoNext === true, volume, selected,
    gameVolume, overlay:raw.overlay === true };
}

export function orderMusicTracks(profile, random = randomInt) {
  const tracks = profile.selected.slice();
  if (profile.shuffle) {
    for (let i=tracks.length-1; i>0; i--) {
      const j=random(i+1);
      [tracks[i],tracks[j]]=[tracks[j],tracks[i]];
    }
  }
  return profile.autoNext ? tracks : tracks.slice(0,1);
}

export function concatPlaylistText(tracks) {
  if (!tracks.length) throw Error('No playable approved tracks');
  // Every URL is validated before this function is called. Avoid untrusted
  // line breaks and quotes that could escape ffconcat's file directive.
  return 'ffconcat version 1.0\n' + tracks.map(song => {
    if (!song.sourceUrl.startsWith('https://') || /[\r\n'\\]/.test(song.sourceUrl)) throw Error('Invalid music source');
    return "file '" + song.sourceUrl + "'\n";
  }).join('');
}

export async function fetchSelectedMusic(env = process.env, fetchImpl = fetch) {
  const secret = env.OBS_MUSIC_SYNC_TOKEN || '';
  if (secret.length < 32 || env.OBS_MUSIC_AUTOPLAY_ENABLED !== 'true') {
    return { status:'DISABLED', profile:null };
  }
  const origin = env.OBS_MUSIC_CONTROL_ORIGIN || 'https://twitch-gemini-ai-chatbot-sc-2.onrender.com';
  const url = new URL('/api/obs-web/music/sync', origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
    return { status:'INVALID_ORIGIN', profile:null };
  }
  try {
    const response = await fetchImpl(url.href,{headers:{authorization:'Bearer '+secret,accept:'application/json'},
      signal:AbortSignal.timeout(7000),redirect:'error',cache:'no-store'});
    if (!response.ok) return {status:'SYNC_HTTP_'+response.status,profile:null};
    const raw = await response.json();
    const profile = validateMusicProfile(raw,env.OBS_MUSIC_ALLOWED_HOSTS);
    if (!profile.autoStart || !profile.selected.length || profile.volume === 0) {
      return {status:'NO_PLAYABLE_SELECTION',profile};
    }
    return {status:'READY',profile};
  } catch { return {status:'SYNC_UNAVAILABLE',profile:null}; }
}

export async function writeMusicPlaylist(profile, path='/tmp/obs-selected-music.ffconcat') {
  const tracks = orderMusicTracks(profile);
  await mkdir('/tmp',{recursive:true});
  await writeFile(path,concatPlaylistText(tracks),{mode:0o600});
  return path;
}
