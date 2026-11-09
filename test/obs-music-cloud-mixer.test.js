import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMusicProfile, orderMusicTracks, concatPlaylistText, fetchSelectedMusic } from '../server/ingress-probe/music-playlist.mjs';
import { buildRelayArgs } from '../server/ingress-probe/sleipnir-relay.mjs';

const remote={autoStart:true,shuffle:false,autoNext:true,volume:22,overlay:true,gameVolume:85,tracks:[
  {id:'a',title:'Authorized Track A',sourceUrl:'https://audio.example.org/a.mp3',genre:'club-house'},
  {id:'b',title:'Authorized Track B',sourceUrl:'https://audio.example.org/b.mp3',genre:'dubstep-bass'}]};
const env={OBS_SLEIPNIR_RELAY_ENABLED:'true',OBS_INGEST_PUBLISH_TOKEN:'test-token-1234567890123456789012345',
  OBS_SLEIPNIR_STREAM_KEY:'test-stream-key'};
test('approved music selections keep 22 percent mix and autoplay rules',()=>{
 const p=validateMusicProfile(remote,'audio.example.org');
 assert.equal(p.selected.length,2);
 assert.equal(p.volume,22);
 assert.equal(p.overlay,true);
 assert.equal(p.gameVolume,85);
 assert.deepEqual(orderMusicTracks(p).map(x=>x.id),['a','b']);
 const playlist=concatPlaylistText(p.selected);
 assert.match(playlist,/ffconcat version 1.0/);
 assert.match(playlist,/a.mp3/);
 assert.match(playlist,/b.mp3/);
});
test('external music sources require exact HTTPS allowlisted host',()=>{
 const profile=validateMusicProfile({...remote,tracks:[
  {id:'bad',sourceUrl:'http://audio.example.org/a.mp3'},
  {id:'redirect',sourceUrl:'https://evil.example.org/a.mp3'},
  {id:'auth',sourceUrl:'https://user:pass@audio.example.org/a.mp3'},
  {id:'ok',sourceUrl:'https://audio.example.org/a.mp3'}
 ]},'audio.example.org');
 assert.deepEqual(profile.selected.map(t=>t.id),['ok']);
});
test('music mix maps live video, game audio and music at separate gains with overlay',()=>{
 const args=buildRelayArgs({...env,OBS_FORCE_VIDEO_REENCODE:'true'},{music:{playlistPath:'/tmp/approved.ffconcat',volume:22,autoNext:true},overlay:true,gameVolume:85});
 const filter=args[args.indexOf('-filter_complex')+1];
 assert.match(filter,/volume=0.85/);
 assert.match(filter,/volume=0.22/);
 assert.match(filter,/amix=inputs=2/);
 assert.ok(args.includes('-vf'));
 assert.ok(args.some(x=>typeof x==='string' && x.includes('drawbox=')));
 assert.equal(args[args.indexOf('-i')+1],'rtmp://127.0.0.1:1935/secure/'+env.OBS_INGEST_PUBLISH_TOKEN);
});
test('autostart disabled or missing key never downloads music',async()=>{
 const result=await fetchSelectedMusic({OBS_MUSIC_AUTOPLAY_ENABLED:'false',OBS_MUSIC_SYNC_TOKEN:'a'.repeat(40)},()=>{throw Error('must not call')});
 assert.equal(result.status,'DISABLED');
});
test('music sync fails closed with unavailable source and no streaming URL exposure',async()=>{
 const p=await fetchSelectedMusic({OBS_MUSIC_AUTOPLAY_ENABLED:'true',OBS_MUSIC_SYNC_TOKEN:'a'.repeat(40),OBS_MUSIC_ALLOWED_HOSTS:'audio.example.org'},
  async()=>({ok:true,json:async()=>remote}));
 assert.equal(p.status,'READY');
 assert.equal(p.profile.selected.length,2);
 const bad=await fetchSelectedMusic({OBS_MUSIC_AUTOPLAY_ENABLED:'true',OBS_MUSIC_SYNC_TOKEN:'a'.repeat(40)},async()=>{throw Error('offline')});
 assert.equal(bad.status,'SYNC_UNAVAILABLE');
});
