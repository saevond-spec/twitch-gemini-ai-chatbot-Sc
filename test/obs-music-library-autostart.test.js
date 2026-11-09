import test from 'node:test';
import assert from 'node:assert/strict';
import { musicCatalogFromEnv, normalizeMusicPreferences } from '../src/encoder/obsMusicLibrary.js';
import { ObsWebControl } from '../src/encoder/obsWebControl.js';

const library = JSON.stringify([
  { id:'one',title:'Approved Example A',artist:'Artist A',license:'Owned master',streamApproved:true },
  { id:'two',title:'Approved Example B',artist:'Artist B',license:'Licensed for livestreams',streamApproved:true },
  { id:'no-rights',title:'Unverified Example',streamApproved:false }
]);
test('track catalog is explicit and only licensed entries are selectable', () => {
  const c=musicCatalogFromEnv({OBS_MUSIC_LIBRARY_JSON:library});
  assert.equal(c.length,3);
  assert.equal(c[2].streamApproved,false);
  assert.throws(()=>normalizeMusicPreferences({selectedTrackIds:['no-rights']},c),/approved/);
  assert.throws(()=>normalizeMusicPreferences({selectedTrackIds:['unknown']},c),/approved/);
  assert.equal(normalizeMusicPreferences({},c).selectedTrackIds.length,2);
});
test('autoplay selected, shuffle and auto-next default on at 22 percent', () => {
  const c=musicCatalogFromEnv({OBS_MUSIC_LIBRARY_JSON:library});
  assert.deepEqual(normalizeMusicPreferences({},c),{
    selectedTrackIds:['one','two'],autoStart:true,shuffle:true,autoNext:true,volume:22
  });
  assert.deepEqual(normalizeMusicPreferences({selectedTrackIds:['two','two'],autoStart:false,shuffle:false,autoNext:false,volume:0},c),{
    selectedTrackIds:['two'],autoStart:false,shuffle:false,autoNext:false,volume:0
  });
});
test('dashboard retains selected track settings when regular stream settings are saved', () => {
  const c=new ObsWebControl({env:{OBS_MUSIC_LIBRARY_JSON:library, ADMIN_API_KEY:'x'.repeat(40)}});
  assert.equal(c.snapshot().settings.music.selectedTrackIds.length,2);
  c.save({...c.settings,music:{selectedTrackIds:['one'],autoStart:true,shuffle:true,autoNext:true,volume:22}});
  c.save({...c.settings,profile:{...c.settings.profile,overlay:true}});
  assert.deepEqual(c.snapshot().settings.music.selectedTrackIds,['one']);
  assert.equal(c.snapshot().settings.musicLibrary[0].title,'Approved Example A');
  assert.equal(c.snapshot().settings.musicRelayVerified,false);
});
test('invalid volume, wrong type and unverifiable rights fail closed', () => {
  const c=musicCatalogFromEnv({OBS_MUSIC_LIBRARY_JSON:library});
  for(const value of [101,-1,1.5,'22']) assert.throws(()=>normalizeMusicPreferences({volume:value},c),/volume/);
  assert.throws(()=>normalizeMusicPreferences({autoStart:'yes'},c),/autoStart/);
});
