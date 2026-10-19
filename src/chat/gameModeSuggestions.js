const MAX_CATEGORY_LENGTH = 80;

// Official game update notes checked 2026-10-19. These suggestions are
// time-bounded to published event/rotation windows; they are not mode-level
// popularity claims. Twitch category viewership does not identify a specific
// in-game mode.
const GAME_MODE_NOTES = [
  {
    aliases: ['naraka bladepoint'],
    title: 'NARAKA: BLADEPOINT',
    notes: [
      {
        startsAt: '2026-10-09T00:00:00Z',
        endsAt: '2026-11-04T20:00:00Z',
        text: 'Try Survival (not Immortal War) or Rift Traversal for the Legend of Qin Moonfall Gate and Crescent Moon Valley Battle; it runs through Nov 4 at 20:00 UTC.',
        source: 'https://www.narakathegame.com/news/update/20260921/33459_1314537.html',
      },
      {
        startsAt: '2026-10-09T00:00:00Z',
        endsAt: '2026-11-03T20:00:00Z',
        text: 'For a separate challenge, Showdown: Suffer No Demon is live through Nov 3 at 20:00 UTC.',
        source: 'https://www.narakathegame.com/news/update/20260921/33459_1314537.html',
      },
    ],
  },
  {
    aliases: ['arc raiders'],
    title: 'ARC Raiders',
    notes: [
      {
        startsAt: '2026-10-13T09:00:00Z',
        endsAt: '2026-10-20T09:00:00Z',
        text: 'Try the PvE matchmaking toggle for a co-op focused raid, or standard PvPvE for player-versus-player encounters. The beta runs through Oct 20 at 11:00 CEST; PvE has no player-to-player damage and lower loot value.',
        source: 'https://arcraiders.com/news/pve-toggle-what-to-know',
      },
    ],
  },
  {
    aliases: ['apex legends'],
    title: 'Apex Legends',
    notes: [
      {
        startsAt: '2026-09-15T00:00:00Z',
        endsAt: '2026-11-04T00:00:00Z',
        text: 'Try Mixtape: TDM for quick fights, Control for objective play, or Gun Run for a change of pace. EA lists this rotation through Nov 3; check the in-game playlist after that.',
        source: 'https://www.ea.com/games/apex-legends/apex-legends/news/marked-midseason-patch-notes',
      },
    ],
  },
];

function normalizeCategory(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CATEGORY_LENGTH);
}

function categoryKey(value) {
  return normalizeCategory(value)
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function suggestGameModes(streamContext = {}, now = Date.now()) {
  if (!streamContext?.live) {
    return 'I can suggest a mode once your stream is live and Twitch reports the game category.';
  }

  const gameName = normalizeCategory(streamContext.gameName);
  if (!gameName) {
    return 'Twitch has not reported the live game category yet. Try !mode again once it appears.';
  }

  if (categoryKey(gameName) === 'just chatting') {
    return 'There is no game mode to suggest while the live category is Just Chatting.';
  }

  const game = GAME_MODE_NOTES.find(entry => entry.aliases.includes(categoryKey(gameName)));
  if (!game) {
    return 'I do not have current, verified mode research for ' + gameName + ', so I will not guess.';
  }

  const timestamp = Number(now);
  const activeNotes = game.notes.filter(note =>
    timestamp >= Date.parse(note.startsAt) && timestamp < Date.parse(note.endsAt),
  );

  if (!activeNotes.length) {
    return 'My verified event or rotation note for ' + game.title + ' is not active at this time, so I will not recommend a limited-time mode.';
  }

  return 'Mode ideas for ' + game.title + ': ' + activeNotes.map(note => note.text).join(' ');
}

export const gameModeResearchSources = Object.freeze(
  GAME_MODE_NOTES.flatMap(game => game.notes.map(note => Object.freeze({
    game: game.title,
    startsAt: note.startsAt,
    endsAt: note.endsAt,
    source: note.source,
  }))),
);
