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
    volumePercent: 22,
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
    const action = parts[0] === '!play' ? 'play' : (parts[1] || 'status');

    if (action === 'status') {
      const current = state.currentTrack ? ' Now playing: ' + state.currentTrack + '.' : '';
      const player = musicPlayerUrl ? ' Player page: ' + musicPlayerUrl + '.' : ' Open the /music-player page.';
      return 'Music player is ' + (state.playing ? 'set to play' : 'paused') + ' — ' + getState().stationLabel + '.' + current
        + ' Music volume: ' + state.volumePercent + '%. Viewers hear it only when player audio is routed into the broadcast.' + player + ' Chat: !play, !music dubstep, !music club, !music play, !music pause, !skip, !song, !volume <0-100>. Station changes, skip and volume are mod-only.';
    }

    if (action === 'club' || action === 'dubstep') {
      if (!isModerator(user)) return 'Only the broadcaster or a moderator can change stations or skip tracks.';
      state = { ...state, station: action, currentTrack: '', videoId: '', playing: true, updatedAt: now() };
      publishControl('station');
      return 'Switching the player to NCS ' + getState().stationLabel + '.';
    }

    if (action === 'play' || action === 'pause') {
      if (!isModerator(user)) return 'Only the broadcaster or a moderator can control stream music.';
      state = { ...state, playing: action === 'play', updatedAt: now() };
      publishControl(action);
      return action === 'play'
        ? 'Playback requested. A new player page needs one click on "Enable audio"; its sound also needs to be routed into the broadcast.'
        : 'Stream music paused.';
    }

    return 'Use !play, !music [club|dubstep|play|pause], !skip, or !song.';
  }

  function handleSkipCommand(user) {
    if (!isModerator(user)) return 'Only the broadcaster or a moderator can change stations or skip tracks.';
    state = { ...state, currentTrack: '', videoId: '', updatedAt: now() };
    publishControl('skip');
    return 'Skipping to the next player track.';
  }

  function handleVolumeCommand(user, message = '!volume') {
    const parts = String(message).trim().split(/\s+/);
    if (parts.length === 1) return 'Stream music volume is ' + state.volumePercent + '%. Moderators: !volume <0-100>.';
    if (!isModerator(user)) return 'Only the broadcaster or a moderator can change the music volume.';
    if (parts.length !== 2 || !/^(?:100|[1-9]?\d)$/.test(parts[1])) {
      return 'Usage: !volume <0-100> (music only; does not change game audio).';
    }
    const percent = Number(parts[1]);
    state = { ...state, volumePercent: percent, updatedAt: now() };
    publishControl('volume');
    return 'Stream music volume set to ' + percent + '%. Game audio is unchanged.';
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
    handleVolumeCommand,
    updatePlayerStatus,
  };
}

const controller = createMusicController();

export const getMusicState = () => controller.getState();
export const setMusicPublisher = publisher => controller.setPublisher(publisher);
export const handleMusicCommand = (user, message, playerUrl) => controller.handleMusicCommand(user, message, playerUrl);
export const handleSkipCommand = user => controller.handleSkipCommand(user);
export const handleSongCommand = () => controller.handleSongCommand();
export const handleVolumeCommand = (user, message) => controller.handleVolumeCommand(user, message);
export const updateMusicPlayerStatus = payload => controller.updatePlayerStatus(payload);
