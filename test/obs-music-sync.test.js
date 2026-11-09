import test from 'node:test';
import assert from 'node:assert/strict';
import { musicCatalogFromEnv, receiverMusicProfile } from '../src/encoder/obsMusicLibrary.js';
import { ObsWebControl } from '../src/encoder/obsWebControl.js';

const catalog=JSON.stringify([
  {id:'house',title:'House Track',genre:'club-house',streamApproved:true,sourceUrl:'https://audio.example.org/house.mp3',credit:'Author A'},
  {id:'bass',title:'Bass Track',genre:'dubstep-bass',streamApproved:true,sourceUrl:'https://audio.example.org/bass.mp3'},
  {id:'unapproved',title:'Not yet licensed',streamApproved:false,sourceUrl:'https://audio.example.org/no.mp3'}]);
test('approved selected music tracks sync with genre without exposing unapproved audio',()=>{
 const c=musicCatalogFromEnv({OBS_MUSIC_LIBRARY_JSON:catalog});
 const p=receiverMusicProfile({selectedTrackIds:['house','unapproved'],autoStart:true,shuffle:true,autoNext:true,volume:22},c);
 assert.equal(p.tracks.length,1);
 assert.equal(p.tracks[0].genre,'club-house');
 assert.equal(p.tracks[0].sourceUrl,'https://audio.example.org/house.mp3');
});
test('dashboard snapshot exposes titles and not private source URLs or sync token',()=>{
 const c=new ObsWebControl({env:{OBS_MUSIC_LIBRARY_JSON:catalog,OBS_MUSIC_SYNC_TOKEN:'x'.repeat(40)}});
 const x=JSON.stringify(c.snapshot());
 assert.equal(c.musicSyncToken.length,40);
 assert.equal(x.includes('audio.example.org'),false);
 assert.equal(x.includes('xxxxxxxxxxxxxxxx'),false);
 assert.equal(c.snapshot().settings.musicLibrary.length,3);
});
