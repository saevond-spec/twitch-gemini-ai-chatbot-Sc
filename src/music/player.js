export const MUSIC_STATIONS = Object.freeze({
  club: Object.freeze({
    label: 'Club / House',
    playlistId: 'PLRBp0Fe2GpgmsW46rJyudVFlY6IYjFBIK',
  }),
  dubstep: Object.freeze({
    label: 'Dubstep',
    playlistId: 'PLRBp0Fe2Gpglq-J-Hv0p-y0wk3lQk570u',
  }),
});

function cleanText(value, maxLength = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function isModerator(user) {
  return Boolean(user?.mod || user?.badges?.broadcaster);
}

export function createMusicController(options = {}) {
  let publisher = typeof options.publisher === 'function' ? options.publisher : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  let state = {
    station: 'dubstep',
    currentTrack: '',
    videoId: '',
    playing: true,
    updatedAt: now(),
  };

  function getState() {
    const station = MUSIC_STATIONS[state.station] || MUSIC_STATIONS.dubstep;
    return {
      ...state,
      stationLabel: station.label,
      playlistId: station.playlistId,
      playlistUrl: 'https://www.youtube.com/playlist?list=' + station.playlistId,
    };
  }

  function publishControl(action) {
    publisher({ type: 'music.control', action, state: getState() });
  }

  function setPublisher(nextPublisher) {
    publisher = typeof nextPublisher === 'function' ? nextPublisher : () => {};
  }

  function handleMusicCommand(user, message, musicPlayerUrl = '') {
    const parts = String(message || '').trim().toLowerCase().split(/\s+/);
    const action = parts[1] || 'status';

    if (action === 'status') {
      const current = state.currentTrack ? ' Now playing: ' + state.currentTrack + '.' : '';
      const player = musicPlayerUrl ? ' Player page: ' + musicPlayerUrl + '.' : ' Open the /music-player page.';
      return 'Music is ' + (state.playing ? 'on' : 'paused') + ' — ' + getState().stationLabel + '.' + current
        + player + ' Chat: !music dubstep, !music club, !music play, !music pause, !skip, !song. Station changes and skip are mod-only.';
    }

    if (action === 'club' || action === 'dubstep') {
      if (!isModerator(user)) return 'Only the broadcaster or a moderator can change stations or skip tracks.';
      state = { ...state, station: action, currentTrack: '', videoId: '', playing: true, updatedAt: now() };
      publishControl('station');
      return 'Switching the stream music to NCS ' + getState().stationLabel + '.';
    }

    if (action === 'play' || action === 'pause') {
      if (!isModerator(user)) return 'Only the broadcaster or a moderator can control stream music.';
      state = { ...state, playing: action === 'play', updatedAt: now() };
      publishControl(action);
      return action === 'play'
        ? 'Music playback requested. A new player page needs one click on "Enable audio".'
        : 'Stream music paused.';
    }

    return 'Use !music [club|dubstep|play|pause], !skip, or !song.';
  }

  function handleSkipCommand(user) {
    if (!isModerator(user)) return 'Only the broadcaster or a moderator can change stations or skip tracks.';
    state = { ...state, currentTrack: '', videoId: '', updatedAt: now() };
    publishControl('skip');
    return 'Skipping to the next track.';
  }

  function handleSongCommand() {
    const current = state.currentTrack
      ? 'Now playing on ' + getState().stationLabel + ': ' + state.currentTrack + '.'
      : 'NCS ' + getState().stationLabel + ' is selected; the track title will appear once the player starts.';
    return state.playing ? current : 'Music is paused on ' + getState().stationLabel + '.';
  }

  function updatePlayerStatus(payload = {}) {
    if (typeof payload.playing === 'boolean') state.playing = payload.playing;
    if (typeof payload.currentTrack === 'string') {
      const title = cleanText(payload.currentTrack);
      if (title) state.currentTrack = title;
    }
    if (typeof payload.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(payload.videoId)) {
      state.videoId = payload.videoId;
    }
    state.updatedAt = now();
    return getState();
  }

  return {
    getState,
    setPublisher,
    handleMusicCommand,
    handleSkipCommand,
    handleSongCommand,
    updatePlayerStatus,
  };
}

const controller = createMusicController();

export const getMusicState = () => controller.getState();
export const setMusicPublisher = publisher => controller.setPublisher(publisher);
export const handleMusicCommand = (user, message, playerUrl) => controller.handleMusicCommand(user, message, playerUrl);
export const handleSkipCommand = user => controller.handleSkipCommand(user);
export const handleSongCommand = () => controller.handleSongCommand();
export const updateMusicPlayerStatus = payload => controller.updatePlayerStatus(payload);
