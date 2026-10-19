import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestGameModes, gameModeResearchSources } from '../src/chat/gameModeSuggestions.js';

function live(gameName) {
  return { live: true, gameName };
}

test('suggests currently researched NARAKA modes and respects both event deadlines', () => {
  const active = suggestGameModes(live('NARAKA: BLADEPOINT'), Date.parse('2026-10-19T12:00:00Z'));
  assert.match(active, /Survival \(not Immortal War\)/);
  assert.match(active, /Rift Traversal/);
  assert.match(active, /Showdown: Suffer No Demon/);

  const afterShowdown = suggestGameModes(live('NARAKA: BLADEPOINT'), Date.parse('2026-11-03T20:00:00Z'));
  assert.match(afterShowdown, /Crescent Moon Valley Battle/);
  assert.doesNotMatch(afterShowdown, /Suffer No Demon/);

  const afterCrossover = suggestGameModes(live('NARAKA: BLADEPOINT'), Date.parse('2026-11-04T20:00:00Z'));
  assert.match(afterCrossover, /not active at this time/);
  assert.doesNotMatch(afterCrossover, /Crescent Moon Valley Battle/);
});

test('recommends ARC Raiders beta options only inside the official test window', () => {
  const active = suggestGameModes(live('ARC Raiders'), Date.parse('2026-10-20T08:59:00Z'));
  assert.match(active, /PvE matchmaking toggle/);
  assert.match(active, /standard PvPvE/);
  assert.match(active, /lower loot value/);

  const ended = suggestGameModes(live('ARC Raiders'), Date.parse('2026-10-20T09:00:00Z'));
  assert.match(ended, /not active at this time/);
  assert.doesNotMatch(ended, /PvE matchmaking toggle/);
});

test('uses the published Apex Mixtape rotation only within its listed dates', () => {
  const active = suggestGameModes(live('Apex Legends'), Date.parse('2026-10-19T12:00:00Z'));
  assert.match(active, /Mixtape/);
  assert.match(active, /TDM/);
  assert.match(active, /Control/);
  assert.match(active, /Gun Run/);

  const ended = suggestGameModes(live('Apex Legends'), Date.parse('2026-11-04T00:00:00Z'));
  assert.match(ended, /not active at this time/);
  assert.doesNotMatch(ended, /Mixtape/);
});

test('does not guess when the game is offline, unknown, or not a game category', () => {
  assert.match(suggestGameModes({ live: false, gameName: 'Apex Legends' }), /stream is live/);
  assert.match(suggestGameModes(live(''), Date.now()), /has not reported/);
  assert.match(suggestGameModes(live('Just Chatting'), Date.now()), /no game mode/);
  assert.match(suggestGameModes(live('Unknown Game'), Date.now()), /will not guess/);
});

test('keeps source records attached to time-bounded recommendations', () => {
  assert.equal(gameModeResearchSources.length, 4);
  for (const source of gameModeResearchSources) {
    assert.match(source.source, /^https:\/\/(www\.narakathegame\.com|arcraiders\.com|www\.ea\.com)\//);
    assert.ok(Date.parse(source.startsAt) < Date.parse(source.endsAt));
  }
});
