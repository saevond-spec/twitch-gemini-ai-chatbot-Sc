/* OBS setup and authenticated diagnostics. No browser credential persistence. */
(function () {
  'use strict';
  const connection = document.getElementById('connection');
  const requestedState = document.getElementById('requested-state');
  const station = document.getElementById('station');
  const track = document.getElementById('track');
  let socket, retryDelay = 1500, reconnectTimer;
  let latestStateAt = 0;

  function status(value, kind) {
    connection.textContent = value;
    connection.className = 'pill ' + (kind || '');
  }
  function render(state) {
    if (!state || typeof state !== 'object') return;
    latestStateAt = Date.now();
    requestedState.textContent = state.playing === true ? 'Play requested' : state.playing === false ? 'Paused' : 'Unknown';
    const safeStation = state.stationLabel || state.station || 'Unknown';
    station.textContent = String(safeStation).slice(0, 75);
    track.textContent = state.currentTrack ? String(state.currentTrack).slice(0, 160) : 'Not reported';
  }
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(protocol + '//' + location.host + '/ws');
    socket.addEventListener('open', function () {
      retryDelay = 1500;
      status('Connected to bot', 'ok');
    });
    socket.addEventListener('message', function (event) {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if ((payload.type === 'music.init' || payload.type === 'music.state' || payload.type === 'music.control') && payload.state) {
        render(payload.state);
      }
    });
    socket.addEventListener('error', function () { status('Bot connection interrupted', 'fail'); });
    socket.addEventListener('close', function () {
      status('Reconnecting…', '');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(20000, Math.round(retryDelay * 1.7));
    });
  }
  // When the bot is disconnected, cached command state should not look current.
  setInterval(function () {
    if (Date.now() - latestStateAt > 120000) {
      requestedState.textContent = 'Not recently confirmed';
    }
  }, 20000);
  connect();
})();

(function () {
  'use strict';
  const el = id => document.getElementById(id);
  let accessKey = '', snapshot = null, polling = null, busy = false, epoch = 0;
  let ingress = null;
  let musicSettingsDirty = false;
  const message = text => { el('setup-message').textContent = text; };
  function lock() {
    epoch += 1;
    accessKey = ''; snapshot = null;
    clearInterval(polling);
    el('admin-key').value = ''; el('relay-key').value = '';
    el('relay-form').hidden = true; el('diagnostics-panel').hidden = true;
    document.querySelectorAll('[data-receiver-action]').forEach(button => { button.disabled = true; });
    el('agent-state').textContent = 'Unlock to check receiver connection';
    el('agent-progress').textContent = 'Settings locked';
    el('music-track-list').replaceChildren();
    el('music-library-status').textContent = 'Unlock to view your saved track selections.';
    musicSettingsDirty = false;
    ingress = null;
    el('ingest-address').value = 'Unavailable';
    el('ingest-receiver').textContent = 'Unlock to check';
    el('ingest-tunnel').textContent = 'Unlock to check';
    el('ingest-probe').textContent = 'Not checked';
    el('ingest-auth').textContent = 'Not checked';
    el('ingest-relay').textContent = 'Not configured';
    el('refresh-ingest').disabled = true; el('copy-ingest').disabled = true;
    el('ingest-expiry').textContent = 'Temporary route status unavailable while dashboard is locked.';
    el('receiver-timeline').replaceChildren();
    message('Settings locked');
  }
  async function request(path, method = 'GET', body) {
    const response = await fetch('/api/obs-web/' + path, {
      method, cache: 'no-store', headers: { Authorization: 'Bearer ' + accessKey,
        'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) lock();
      throw new Error(data.error || 'Dashboard request failed');
    }
    return data;
  }
  async function refreshIngress() {
    if (!accessKey) return;
    const current = epoch;
    try {
      const data = await request('ingress');
      if (current !== epoch) return;
      ingress = data;
      el('ingest-receiver').textContent = data.available ? data.receiver || 'Unknown' : 'Offline';
      el('ingest-tunnel').textContent = data.available ? data.tunnel || 'Unknown' : 'Unavailable';
      el('ingest-probe').textContent = data.syntheticPassed ? 'Passed: external RTMP publish' : 'Not confirmed';
      el('ingest-auth').textContent = data.authRejectionPassed ? 'Rejected invalid publisher' : 'Not verified';
      el('ingest-relay').textContent = data.relay || 'Unknown';
      el('ingest-address').value = data.ingestReady && data.endpoint ? data.endpoint : 'Unavailable';
      el('copy-ingest').disabled = !(data.ingestReady && data.endpoint);
      el('ingest-expiry').textContent = data.ingestReady
        ? 'Temporary receiver ready for compatible RTMP senders. Expires in approximately ' +
          Math.ceil((data.remainingSeconds || 0) / 60) + ' min. Native PS5 route is still unverified.'
        : (data.reason || 'Receiver not ready or temporary tunnel expired; native PS5 route remains unverified.');
    } catch {
      if (current !== epoch) return;
      ingress = null;
      el('ingest-address').value = 'Unavailable';
      el('copy-ingest').disabled = true;
      el('ingest-receiver').textContent = 'Status unavailable';
      el('ingest-tunnel').textContent = 'Unknown';
      el('ingest-probe').textContent = 'Not confirmed';
      el('ingest-auth').textContent = 'Not verified';
      el('ingest-relay').textContent = 'Status unavailable';
      el('ingest-expiry').textContent = 'Could not reach the cloud diagnostic receiver.';
    }
  }
  el('refresh-ingest').addEventListener('click', refreshIngress);
  el('copy-ingest').addEventListener('click', async () => {
    if (!ingress?.ingestReady || !ingress.endpoint) return;
    try { await navigator.clipboard.writeText(ingress.endpoint); message('Temporary RTMP receiver URL copied. Not a PS5 Broadcast menu setting.'); }
    catch { message('Clipboard unavailable. Copy the displayed address manually.'); }
  });
  function renderMusicSettings(data, force = false) {
    const catalog = data.settings.musicLibrary || [];
    const prefs = data.settings.music || {};
    if (!force && musicSettingsDirty) return;
    const list = el('music-track-list');
    list.replaceChildren();
    if (!catalog.length) {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No approved music tracks are configured on the server. Upload a licensed catalog; no songs have been fabricated.';
      list.append(empty);
    }
    const selected = new Set(prefs.selectedTrackIds || []);
    for (const item of catalog) {
      const label = document.createElement('label');
      label.className = 'check-label';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'music-track-select';
      checkbox.value = item.id;
      checkbox.checked = item.streamApproved && selected.has(item.id);
      checkbox.disabled = !item.streamApproved;
      checkbox.addEventListener('change', () => { musicSettingsDirty = true; });
      const caption = document.createElement('span');
      caption.textContent = item.title + (item.artist ? ' — ' + item.artist : '') +
        (item.streamApproved ? '' : ' (streaming rights unverified)');
      label.append(checkbox, caption);
      list.append(label);
    }
    el('music-autostart').checked = prefs.autoStart === true;
    el('music-shuffle').checked = prefs.shuffle !== false;
    el('music-autonext').checked = prefs.autoNext !== false;
    el('music-volume').value = prefs.volume ?? 22;
    el('music-library-status').textContent = catalog.length
      ? selected.size + ' approved tracks selected. Saved settings are not yet wired to the isolated Sleipnir mixer.'
      : 'Add approved tracks before enabling on-stream playback.';
    musicSettingsDirty = false;
  }
  for (const id of ['music-autostart','music-shuffle','music-autonext']) {
    el(id).addEventListener('change', () => { musicSettingsDirty = true; });
  }
  el('select-all-music').addEventListener('click', () => {
    document.querySelectorAll('.music-track-select').forEach(c => { if (!c.disabled) c.checked = true; });
    musicSettingsDirty = true;
  });
  el('clear-music-selection').addEventListener('click', () => {
    document.querySelectorAll('.music-track-select').forEach(c => { c.checked = false; });
    musicSettingsDirty = true;
  });
  el('save-music-library').addEventListener('click', () => {
    if (!accessKey) return message('Unlock the dashboard before saving music settings.');
    const selectedTrackIds = Array.from(document.querySelectorAll('.music-track-select:checked'), c => c.value);
    action(async () => {
      const data = await request('music/library-settings', 'PUT', {
        selectedTrackIds, autoStart: el('music-autostart').checked,
        shuffle: el('music-shuffle').checked, autoNext: el('music-autonext').checked,
        volume: Number(el('music-volume').value)
      });
      musicSettingsDirty = false;
      renderMusicSettings(data, true);
      return data;
    }, 'Music library preferences saved. Cloud audio mixing is not yet verified.');
  });
  function render(data, loadForm = false) {
    snapshot = data;
    renderMusicSettings(data, loadForm);
    el('relay-form').hidden = false; el('diagnostics-panel').hidden = false;
    if (loadForm) {
      el('relay-url').value = data.settings.relayUrl;
      el('receiver-ip').value = data.settings.receiverAddress;
      fillProfile(data.settings.profile || {});
    }
    el('key-state').textContent = data.settings.keyConfigured ? 'A stream key is saved (hidden).' : 'No stream key saved.';
    el('storage-state').textContent = data.settings.storageError ? 'Encrypted settings could not be loaded. Server configuration needs repair.' :
      data.settings.storage === 'encrypted_redis' ? 'Encrypted settings saved in the existing database; retained across app restarts. Keep the dashboard access key stable.' : data.settings.storage === 'encrypted_file' ? 'Encrypted server file. Persistence across deployments depends on the configured storage volume.' :
      'Session storage only: settings will be lost when the server restarts. Permanent encrypted storage is not configured.';
    el('receiver-control').textContent = data.receiver.reason;
    el('agent-state').textContent = data.receiver.state + ' · ' + data.receiver.reason;
    const media = data.receiver.connected ? data.receiver.media : null;
    el('agent-progress').textContent = data.receiver.connected
      ? 'Processed video frames: ' + data.receiver.frames +
        (media ? ' · media: ' + media.sourceState + ' · local output: ' +
          (media.outputBytes / 1024 / 1024).toFixed(2) + ' MiB' +
          (media.speed ? ' · processing speed: ' + media.speed : '') +
          ' · incoming audio packets: unmeasured' : '') +
        (data.receiver.pending ? ' · command pending: ' + data.receiver.pending.action : '')
      : 'No receiver heartbeat. A saved IP address alone does not connect a receiver.';
    document.querySelectorAll('[data-receiver-action]').forEach(button => {
      button.disabled = !data.receiver.connected || (Boolean(data.receiver.pending) && button.dataset.receiverAction !== 'stop') ||
        (button.dataset.receiverAction === 'reconnect' && !['STREAMING', 'STALLED'].includes(data.receiver.state));
    });
    el('receiver-timeline').replaceChildren();
    for (const event of (data.receiver.events || []).slice().reverse()) {
      const row = document.createElement('li'); row.textContent = new Date(event.at).toLocaleTimeString() + ' · ' + event.action + ' · ' + event.result;
      el('receiver-timeline').append(row);
    }
    el('relay-check').textContent = data.connectionCheck ?
      (data.connectionCheck.reachable ? 'TLS reachable · video untested' : 'Connection failed') : 'Not tested';
    const sample = data.telemetry.fresh ? data.telemetry.sample : null;
    el('receiver-packets').textContent = sample ? sample.ingest.videoPackets + ' / ' + sample.ingest.audioPackets + ' · ' + sample.ingest.state : 'No recent report';
    const relay = sample?.destinations.find(item => item.id === 'sleipnir');
    el('relay-bitrate').textContent = relay ? (relay.bytesPerSecond * 8 / 1000).toFixed(0) + ' kbps · ' + relay.state : 'Unknown';
    el('output-states').textContent = sample?.destinations.length ? sample.destinations.map(item => item.id + ': ' + item.state).join(' · ') : 'No recent report';
    el('telemetry-age').textContent = data.telemetry.receivedAt ? 'Last encoder report: ' + new Date(data.telemetry.receivedAt).toLocaleString() : 'No authenticated encoder report received.';
  }
  function fillProfile(profile) {
    el('ps5-ip').value = profile.ps5Address || '';
    el('quality').value = profile.quality || '720p30';
    el('rotate').checked = profile.rotate180 === true;
    el('overlay').checked = profile.overlay === true;
    el('game-volume').value = profile.gameVolume ?? 85;
    el('game-volume-value').textContent = el('game-volume').value + '%';
    el('stream-title').value = profile.title || ''; el('stream-game').value = profile.game || '';
    el('stream-keywords').value = profile.keywords || '';
  }
  async function action(work, success) {
    if (busy) return;
    busy = true;
    const current = epoch;
    try { const result = await work(); if (current === epoch) { render(result); if (success) message(success); } }
    catch (error) { if (current === epoch) message(error.message); }
    finally { busy = false; }
  }
  el('unlock-form').addEventListener('submit', async event => {
    event.preventDefault();
    accessKey = el('admin-key').value; el('admin-key').value = '';
    await action(async () => { const data = await request('status');
      if (accessKey) { el('relay-url').value = data.settings.relayUrl; el('receiver-ip').value = data.settings.receiverAddress;
      fillProfile(data.settings.profile || {}); }
      return data;
    }, 'Settings unlocked');
    clearInterval(polling);
    if (snapshot && accessKey) {
      el('refresh-ingest').disabled = false;
      void refreshIngress();
      polling = setInterval(() => { if (!document.hidden) { action(() => request('status')); void refreshIngress(); } }, 15000);
    }
  });
  el('lock').addEventListener('click', lock);
  el('relay-form').addEventListener('submit', event => {
    event.preventDefault();
    const body = { relayUrl: el('relay-url').value, streamKey: el('relay-key').value,
      clearKey: el('clear-key').checked, receiverAddress: el('receiver-ip').value.trim(),
      profile: { ps5Address: el('ps5-ip').value.trim(), quality: el('quality').value, rotate180: el('rotate').checked, overlay: el('overlay').checked, gameVolume: Number(el('game-volume').value), title: el('stream-title').value, game: el('stream-game').value, keywords: el('stream-keywords').value } };
    action(async () => { const result = await request('settings', 'PUT', body);
      el('relay-key').value = ''; el('clear-key').checked = false; return result;
    }, 'Settings saved. Start or reconnect the receiver to apply them.');
  });
  el('check-relay').addEventListener('click', () => action(() => request('check', 'POST'), 'Connection check complete. No video was sent.'));
  el('refresh-status').addEventListener('click', () => action(() => request('status'), 'Diagnostics refreshed'));
  el('copy-report').addEventListener('click', async () => {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify({ receiver: snapshot.receiver,
        telemetry: snapshot.telemetry, connectionCheck: snapshot.connectionCheck }, null, 2));
      message('Diagnostic report copied without keys or receiver address.');
    } catch { message('Clipboard unavailable. You can share the diagnostics panel with credentials hidden.'); }
  });
  // Age out the last report even if requests fail or the phone loses connectivity.
  setInterval(() => {
    if (snapshot?.telemetry.receivedAt && Date.now() - Date.parse(snapshot.telemetry.receivedAt) > 90000) {
      snapshot.telemetry.fresh = false; render(snapshot);
    }
  }, 5000);
  document.querySelectorAll('[data-receiver-action]').forEach(button => button.addEventListener('click', () =>
    action(() => request('command', 'POST', { action: button.dataset.receiverAction }), 'Command requested. Wait for the receiver acknowledgement.')));
  document.querySelectorAll('[data-music-action]').forEach(button => button.addEventListener('click', () => {
    if (!accessKey) return message('Unlock the dashboard before controlling music.');
    action(() => request('music', 'POST', { action: button.dataset.musicAction, volume: Number(button.dataset.volume || 22) }), 'Music player command sent. Broadcast audio is not verified.');
  }));
  el('save-music-volume').addEventListener('click', () => {
    if (!accessKey) return message('Unlock the dashboard first.');
    action(() => request('music', 'POST', { action: 'volume', volume: Number(el('music-volume').value) }), 'Music player volume updated.');
  });
  el('game-volume').addEventListener('input', () => { el('game-volume-value').textContent = el('game-volume').value + '%'; });
  el('copy-metadata').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText([el('stream-title').value, el('stream-game').value, '@saevond', el('stream-keywords').value].filter(Boolean).join('\n')); message('Stream description copied.'); }
    catch { message('Clipboard unavailable. Copy the title and game fields manually.'); }
  });
  setInterval(() => {
    if (snapshot?.receiver.lastSeen && Date.now() - Date.parse(snapshot.receiver.lastSeen) >= 30000) {
      snapshot.receiver.connected = false; snapshot.receiver.state = 'OFFLINE'; snapshot.receiver.frames = null;
      snapshot.receiver.reason = 'Receiver report expired'; render(snapshot);
    }
  }, 5000);
  window.addEventListener('pagehide', lock);
})();
