import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMusicController,
  MUSIC_STATIONS,
} from '../src/music/player.js';

function broadcaster() {
  return { badges: { broadcaster: '1' } };
}

test('stations map only to the official NCS dubstep and house playlists', () => {
  assert.equal(MUSIC_STATIONS.dubstep.playlistId, 'PLRBp0Fe2Gpglq-J-Hv0p-y0wk3lQk570u');
  assert.equal(MUSIC_STATIONS.club.playlistId, 'PLRBp0Fe2GpgmsW46rJyudVFlY6IYjFBIK');
  assert.match(MUSIC_STATIONS.club.label, /Club \/ House/);
});

test('public status gives the player URL and chat controls', () => {
  const controller = createMusicController({ now: () => 1000 });
  const result = controller.handleMusicCommand({}, '!music', 'https://bot.example/music-player');
  assert.match(result, /https:\/\/bot\.example\/music-player/);
  assert.match(result, /!music dubstep/);
  assert.match(result, /!skip/);
  assert.match(result, /mod-only/);
  assert.match(result, /routed into the broadcast/);
});

test('viewers cannot switch stations or skip tracks', () => {
  const events = [];
  const controller = createMusicController({ publisher: event => events.push(event) });
  const viewer = { mod: false, badges: {} };

  assert.match(controller.handleMusicCommand(viewer, '!music club'), /Only the broadcaster or a moderator/);
  assert.match(controller.handleSkipCommand(viewer), /Only the broadcaster or a moderator/);
  assert.equal(events.length, 0);
  assert.equal(controller.getState().station, 'dubstep');
});

test('moderators can switch, pause, resume, and skip', () => {
  const events = [];
  let clock = 0;
  const controller = createMusicController({
    publisher: event => events.push(event),
    now: () => ++clock,
  });

  assert.match(controller.handleMusicCommand({ mod: true }, '!music club'), /Switching/);
  assert.equal(controller.getState().station, 'club');
  assert.equal(events.at(-1).action, 'station');
  assert.equal(events.at(-1).state.playlistId, MUSIC_STATIONS.club.playlistId);

  controller.updatePlayerStatus({ playing: true, currentTrack: 'Example track', videoId: 'abcdefghijk' });
  assert.equal(controller.getState().currentTrack, 'Example track');

  assert.equal(controller.handleMusicCommand(broadcaster(), '!music pause'), 'Stream music paused.');
  assert.equal(controller.getState().playing, false);
  assert.equal(events.at(-1).action, 'pause');

  assert.match(controller.handleMusicCommand(broadcaster(), '!music play'), /Music playback requested/);
  assert.equal(controller.getState().playing, true);
  assert.equal(events.at(-1).action, 'play');

  assert.equal(controller.handleSkipCommand(broadcaster()), 'Skipping to the next track.');
  assert.equal(events.at(-1).action, 'skip');
  assert.equal(controller.getState().currentTrack, '');
});

test('player status is length-limited and ignores malformed video IDs', () => {
  const controller = createMusicController({ now: () => 99 });
  const state = controller.updatePlayerStatus({
    playing: false,
    currentTrack: '  A track   title  ',
    videoId: 'not-a-youtube-id',
  });

  assert.equal(state.playing, false);
  assert.equal(state.currentTrack, 'A track title');
  assert.equal(state.videoId, '');
  assert.equal(state.updatedAt, 99);

  controller.updatePlayerStatus({ playing: true, currentTrack: 'x'.repeat(200), videoId: 'abcdefghijk' });
  assert.equal(controller.getState().currentTrack.length, 160);
  assert.equal(controller.getState().videoId, 'abcdefghijk');
});

test('!song reports current track and pause state', () => {
  const controller = createMusicController();
  controller.updatePlayerStatus({ playing: true, currentTrack: 'Track name', videoId: 'abcdefghijk' });
  assert.equal(controller.handleSongCommand(), 'Now playing on Dubstep: Track name.');

  controller.updatePlayerStatus({ playing: false });
  assert.equal(controller.handleSongCommand(), 'Music is paused on Dubstep.');
});
