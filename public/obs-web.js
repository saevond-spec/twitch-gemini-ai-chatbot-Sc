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
  const message = text => { el('setup-message').textContent = text; };
  function lock() {
    epoch += 1;
    accessKey = ''; snapshot = null;
    clearInterval(polling);
    el('admin-key').value = ''; el('relay-key').value = '';
    el('relay-form').hidden = true; el('diagnostics-panel').hidden = true;
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
  function render(data, loadForm = false) {
    snapshot = data;
    el('relay-form').hidden = false; el('diagnostics-panel').hidden = false;
    if (loadForm) {
      el('relay-url').value = data.settings.relayUrl;
      el('receiver-ip').value = data.settings.receiverAddress;
    }
    el('key-state').textContent = data.settings.keyConfigured ? 'A stream key is saved (hidden).' : 'No stream key saved.';
    el('storage-state').textContent = data.settings.storageError ? 'Encrypted settings could not be loaded. Server configuration needs repair.' :
      data.settings.storage === 'encrypted_file' ? 'Encrypted server file. Persistence across deployments depends on the configured storage volume.' :
      'Session storage only: settings will be lost when the server restarts. Permanent encrypted storage is not configured.';
    el('receiver-control').textContent = data.receiver.reason;
    el('relay-check').textContent = data.connectionCheck ?
      (data.connectionCheck.reachable ? 'TLS reachable · video untested' : 'Connection failed') : 'Not tested';
    const sample = data.telemetry.fresh ? data.telemetry.sample : null;
    el('receiver-packets').textContent = sample ? sample.ingest.videoPackets + ' / ' + sample.ingest.audioPackets + ' · ' + sample.ingest.state : 'No recent report';
    const relay = sample?.destinations.find(item => item.id === 'sleipnir');
    el('relay-bitrate').textContent = relay ? (relay.bytesPerSecond * 8 / 1000).toFixed(0) + ' kbps · ' + relay.state : 'Unknown';
    el('output-states').textContent = sample?.destinations.length ? sample.destinations.map(item => item.id + ': ' + item.state).join(' · ') : 'No recent report';
    el('telemetry-age').textContent = data.telemetry.receivedAt ? 'Last encoder report: ' + new Date(data.telemetry.receivedAt).toLocaleString() : 'No authenticated encoder report received.';
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
      if (accessKey) { el('relay-url').value = data.settings.relayUrl; el('receiver-ip').value = data.settings.receiverAddress; }
      return data;
    }, 'Settings unlocked');
    clearInterval(polling);
    if (snapshot && accessKey) polling = setInterval(() => { if (!document.hidden) action(() => request('status')); }, 15000);
  });
  el('lock').addEventListener('click', lock);
  el('relay-form').addEventListener('submit', event => {
    event.preventDefault();
    const body = { relayUrl: el('relay-url').value, streamKey: el('relay-key').value,
      clearKey: el('clear-key').checked, receiverAddress: el('receiver-ip').value.trim() };
    action(async () => { const result = await request('settings', 'PUT', body);
      el('relay-key').value = ''; el('clear-key').checked = false; return result;
    }, 'Settings saved here. Receiver configuration has not changed.');
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
  window.addEventListener('pagehide', lock);
})();
