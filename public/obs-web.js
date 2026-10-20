/* Read-only OBS web status. Never claims the phone is acting as a PS5 receiver. */
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
