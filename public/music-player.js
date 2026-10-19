const statusNode = document.getElementById('connection-status');
const titleNode = document.getElementById('track-title');
const stationNode = document.getElementById('station-name');
const linkNode = document.getElementById('playlist-link');
const enableButton = document.getElementById('enable-audio');

let player = null;
let playerReady = false;
let stateReceived = false;
let userEnabledAudio = false;
let playbackStarted = false;
let autoplayBlocked = false;
let pendingSkip = false;
let activePlaylistId = '';
let musicState = null;
let socket = null;
let reconnectTimer = null;
let embedErrors = 0;

function setStatus(message) {
  statusNode.textContent = message;
}

function renderState() {
  if (!musicState) return;
  stationNode.textContent = musicState.stationLabel + (musicState.playing ? ' · playing' : ' · paused');
  titleNode.textContent = musicState.currentTrack || (musicState.playing ? 'Ready to play' : 'Music paused');
  if (/^[A-Za-z0-9_-]{10,80}$/.test(musicState.playlistId || '')) {
    linkNode.href = 'https://www.youtube.com/playlist?list=' + musicState.playlistId;
  }
  enableButton.disabled = !playerReady || !stateReceived || userEnabledAudio || playbackStarted;
  enableButton.textContent = playbackStarted
    ? 'Audio playing'
    : userEnabledAudio
      ? 'Audio enabled'
      : autoplayBlocked
        ? 'Tap to start audio'
        : 'Auto-start pending';
}

function sendPlayerStatus(playing) {
  if (!player || !socket || socket.readyState !== WebSocket.OPEN) return;
  let data = {};
  try { data = player.getVideoData() || {}; } catch {}
  const title = typeof data.title === 'string' ? data.title : '';
  const videoId = typeof data.video_id === 'string' ? data.video_id : '';
  socket.send(JSON.stringify({
    type: 'music.player.status',
    playing: Boolean(playing),
    currentTrack: title.slice(0, 160),
    videoId: videoId,
  }));
}

function cueCurrentStation() {
  if (!playerReady || !musicState || !musicState.playlistId) return;
  activePlaylistId = musicState.playlistId;
  embedErrors = 0;
  try {
    player.cuePlaylist({ list: activePlaylistId, listType: 'playlist', index: 0 });
    setStatus('Station loaded. Use Twitch chat to start, pause, or skip tracks.');
  } catch {
    setStatus('Could not load that playlist. Open the official NCS playlist link to check it.');
  }
}

function enableAudio() {
  userEnabledAudio = true;
  autoplayBlocked = false;
  renderState();
  if (!playerReady || !musicState) return;
  if (!activePlaylistId || activePlaylistId !== musicState.playlistId) {
    cueCurrentStation();
  } else if (musicState.playing) {
    if (pendingSkip) {
      pendingSkip = false;
      player.nextVideo();
    } else {
      player.playVideo();
    }
  } else {
    setStatus('Audio is ready. Music is paused; a moderator can use !music play.');
  }
}

function onPlayerStateChange(event) {
  if (!window.YT || !player) return;
  if (event.data === window.YT.PlayerState.CUED) {
    player.setLoop(true);
    player.setShuffle(true);
    if (musicState && musicState.playing) {
      setStatus('Trying to start playback automatically. If your browser blocks it, tap the audio button.');
      player.playVideo();
    } else {
      setStatus('Player ready. Chat can change stations or skip tracks.');
    }
    return;
  }
  if (event.data === window.YT.PlayerState.PLAYING) {
    embedErrors = 0;
    playbackStarted = true;
    autoplayBlocked = false;
    renderState();
    setStatus('Music is playing in the browser tab.');
    window.setTimeout(function () {
      if (!player || player.getPlayerState() !== window.YT.PlayerState.PLAYING) return;
      let data = {};
      try { data = player.getVideoData() || {}; } catch {}
      if (musicState && typeof data.title === 'string' && data.title) {
        musicState.currentTrack = data.title;
        renderState();
      }
      sendPlayerStatus(true);
    }, 300);
    return;
  }
  if (event.data === window.YT.PlayerState.PAUSED) {
    playbackStarted = false;
    renderState();
    setStatus('Music paused.');
    sendPlayerStatus(false);
  }
}

function applyControl(message) {
  if (message.state) {
    musicState = message.state;
    stateReceived = true;
    renderState();
  }
  if (!playerReady || !musicState) return;

  if (message.action === 'station') {
    pendingSkip = false;
    cueCurrentStation();
  } else if (message.action === 'play') {
    if (!activePlaylistId || activePlaylistId !== musicState.playlistId) cueCurrentStation();
    else {
      player.playVideo();
      setStatus('Trying to resume playback. Tap the audio button if your browser blocks it.');
    }
  } else if (message.action === 'pause') {
    player.pauseVideo();
    setStatus('Music is paused.');
  } else if (message.action === 'skip') {
    if (playbackStarted || userEnabledAudio) {
      player.nextVideo();
    } else {
      pendingSkip = true;
      setStatus('Skip queued. Tap the audio button to start on the next track.');
    }
  }
}

function handleSocketMessage(event) {
  let message;
  try { message = JSON.parse(event.data); } catch { return; }

  if (message.type === 'music.init' || message.type === 'music.state') {
    musicState = message.state || musicState;
    stateReceived = Boolean(musicState);
    renderState();
    if (playerReady && musicState && (!activePlaylistId || activePlaylistId !== musicState.playlistId)) cueCurrentStation();
  } else if (message.type === 'music.control') {
    applyControl(message);
  }
}

function connectSocket() {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(scheme + '//' + window.location.host + '/ws');
  socket.addEventListener('open', function () {
    setStatus('Connected to SweatyClanker chat controls.');
  });
  socket.addEventListener('message', handleSocketMessage);
  socket.addEventListener('error', function () {
    setStatus('Chat controls are reconnecting; on-screen player controls still work.');
  });
  socket.addEventListener('close', function () {
    if (reconnectTimer) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connectSocket, 2500);
  });
}

function createYouTubePlayer() {
  player = new window.YT.Player('youtube-player', {
    width: '760',
    height: '428',
    videoId: '',
    playerVars: {
      autoplay: 0,
      controls: 1,
      enablejsapi: 1,
      playsinline: 1,
      rel: 0,
      origin: window.location.origin,
    },
    events: {
      onReady: function (event) {
        playerReady = true;
        event.target.getIframe().setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen');
        if (musicState) cueCurrentStation();
        renderState();
      },
      onStateChange: onPlayerStateChange,
      onAutoplayBlocked: function () {
        autoplayBlocked = true;
        renderState();
        setStatus('Your browser blocked automatic sound. Tap the audio button once.');
      },
      onError: function () {
        embedErrors += 1;
        if (embedErrors <= 3 && player) {
          setStatus('That NCS video cannot be embedded; skipping to the next playlist track…');
          window.setTimeout(function () { if (player) player.nextVideo(); }, 900);
        } else {
          setStatus('The playlist could not be embedded. Use the official NCS playlist link to check availability.');
        }
      },
    },
  });
}

window.onYouTubeIframeAPIReady = createYouTubePlayer;
enableButton.addEventListener('click', enableAudio);
connectSocket();

const api = document.createElement('script');
api.src = 'https://www.youtube.com/iframe_api';
api.async = true;
document.head.appendChild(api);
