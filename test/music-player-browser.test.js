import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const playerSource = readFileSync(new URL('../public/music-player.js', import.meta.url), 'utf8');

function setupPlayerPage() {
  const elements = new Map();
  function node() {
    return {
      textContent: '',
      disabled: true,
      href: '',
      handlers: {},
      addEventListener(type, handler) { this.handlers[type] = handler; },
      click() { this.handlers.click?.(); },
      setAttribute() {},
    };
  }

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, node());
      return elements.get(id);
    },
    createElement() { return {}; },
    head: { appendChild() {} },
  };

  const sockets = [];
  class FakeWebSocket {
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.handlers = {};
      this.sent = [];
      sockets.push(this);
    }
    addEventListener(type, handler) { this.handlers[type] = handler; }
    send(message) { this.sent.push(message); }
    emit(type, event) { this.handlers[type]?.(event); }
  }

  let player;
  class FakeYouTubePlayer {
    constructor(_element, options) {
      this.options = options;
      this.calls = [];
      this.state = 5;
      player = this;
    }
    getIframe() { return { setAttribute() {} }; }
    cuePlaylist() { this.calls.push('cuePlaylist'); }
    setLoop(value) { this.calls.push(['setLoop', value]); }
    setShuffle(value) { this.calls.push(['setShuffle', value]); }
    playVideo() { this.calls.push('playVideo'); }
    pauseVideo() { this.calls.push('pauseVideo'); }
    nextVideo() { this.calls.push('nextVideo'); }
    getPlayerState() { return this.state; }
    getVideoData() { return { title: 'NCS test track', video_id: 'abcdefghijk' }; }
  }

  const window = {
    location: { protocol: 'https:', host: 'bot.example' },
    setTimeout() { return 1; },
    clearTimeout() {},
    YT: {
      Player: FakeYouTubePlayer,
      PlayerState: { CUED: 5, PLAYING: 1, PAUSED: 2 },
    },
  };
  vm.runInNewContext(playerSource, { window, document, WebSocket: FakeWebSocket });
  window.onYouTubeIframeAPIReady();
  player.options.events.onReady({ target: { getIframe: () => ({ setAttribute() {} }) } });

  const socket = sockets[0];
  socket.emit('message', {
    data: JSON.stringify({
      type: 'music.init',
      state: {
        stationLabel: 'Dubstep',
        playlistId: 'PLRBp0Fe2Gpglq-J-Hv0p-y0wk3lQk570u',
        playing: true,
        currentTrack: '',
      },
    }),
  });

  return { elements, player, socket };
}

test('player tries audible autoplay and offers a one-tap fallback when blocked', () => {
  const { elements, player } = setupPlayerPage();
  const button = elements.get('enable-audio');
  const status = elements.get('connection-status');

  player.options.events.onStateChange({ data: 5 });
  assert.ok(player.calls.some(call => Array.isArray(call) && call[0] === 'setLoop' && call[1] === true));
  assert.ok(player.calls.includes('playVideo'), 'cued playlist should attempt to start automatically');

  player.options.events.onAutoplayBlocked();
  assert.equal(status.textContent, 'Your browser blocked automatic sound. Tap the audio button once.');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Tap to start audio');

  button.click();
  assert.equal(player.calls.filter(call => call === 'playVideo').length, 2);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'Audio enabled');
});

test('730-day simulation covers autoplay, blocked starts, Twitch chat controls, and station changes', () => {
  const playlistIds = {
    dubstep: 'PLRBp0Fe2Gpglq-J-Hv0p-y0wk3lQk570u',
    club: 'PLRBp0Fe2GpgmsW46rJyudVFlY6IYjFBIK',
  };
  let websiteFallbacks = 0;
  let twitchControls = 0;
  let blockedAutoplayEvents = 0;

  for (let day = 0; day < 730; day += 1) {
    const { elements, player, socket } = setupPlayerPage();
    const button = elements.get('enable-audio');
    const initialPlayCalls = player.calls.filter(call => call === 'playVideo').length;

    function receiveControl(action, playing, playlistId, stationLabel) {
      twitchControls += 1;
      socket.emit('message', {
        data: JSON.stringify({
          type: 'music.control',
          action,
          state: {
            stationLabel,
            playlistId,
            playing,
            currentTrack: '',
          },
        }),
      });
    }

    function allowPlayback() {
      player.state = 1;
      player.options.events.onStateChange({ data: 1 });
      assert.equal(button.textContent, 'Audio playing');
    }

    function blockPlaybackAndUseWebsiteFallback() {
      blockedAutoplayEvents += 1;
      player.options.events.onAutoplayBlocked();
      assert.equal(elements.get('connection-status').textContent,
        'Your browser blocked automatic sound. Tap the audio button once.');
      assert.equal(button.disabled, false, 'blocked playback must leave the website fallback usable');
      assert.equal(button.textContent, 'Tap to start audio');
      button.click();
      websiteFallbacks += 1;
      allowPlayback();
    }

    // Opening the page loads the default playing station and attempts autoplay.
    player.options.events.onStateChange({ data: 5 });
    assert.equal(player.calls.filter(call => call === 'playVideo').length, initialPlayCalls + 1);
    if (day % 2 === 0) blockPlaybackAndUseWebsiteFallback();
    else allowPlayback();

    // Exercise pause and resume through the Twitch chat control WebSocket.
    receiveControl('pause', false, playlistIds.dubstep, 'Dubstep');
    assert.ok(player.calls.includes('pauseVideo'));
    player.state = 2;
    player.options.events.onStateChange({ data: 2 });
    assert.equal(elements.get('connection-status').textContent, 'Music paused.');

    receiveControl('play', true, playlistIds.dubstep, 'Dubstep');
    if (day % 3 === 0) blockPlaybackAndUseWebsiteFallback();
    else allowPlayback();

    // Skip is a moderator chat action while music is playing.
    receiveControl('skip', true, playlistIds.dubstep, 'Dubstep');
    assert.ok(player.calls.includes('nextVideo'));

    // Switch stations. A blocked start must reset stale "Audio playing" state
    // and restore the one-tap fallback, even after a prior successful tap.
    const nextStation = day % 2 === 0 ? 'club' : 'dubstep';
    receiveControl('station', true, playlistIds[nextStation],
      nextStation === 'club' ? 'Club / House' : 'Dubstep');
    player.options.events.onStateChange({ data: 5 });
    if (day % 4 === 0) blockPlaybackAndUseWebsiteFallback();
    else allowPlayback();

    assert.ok(player.calls.some(call => Array.isArray(call) && call[0] === 'setLoop' && call[1] === true));
    assert.ok(player.calls.some(call => Array.isArray(call) && call[0] === 'setShuffle' && call[1] === true));
  }

  assert.equal(twitchControls, 730 * 4);
  assert.ok(websiteFallbacks > 0);
  assert.ok(blockedAutoplayEvents > 0);
});
