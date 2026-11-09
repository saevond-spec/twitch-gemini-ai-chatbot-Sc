import test from 'node:test';
import assert from 'node:assert/strict';
import { concatPlaylistText, validateMusicProfile } from '../server/ingress-probe/music-playlist.mjs';
import { buildRelayArgs } from '../server/ingress-probe/sleipnir-relay.mjs';

const url='https://carf-coder.github.io/keynata-commons/release/tracks/classical_duo_24002/classical_duo_24002.mp3';
test('selected track is a real HTTPS MP3 from explicitly allowed CC0 host',()=>{
 const p=validateMusicProfile({autoStart:true,shuffle:false,autoNext:false,volume:22,tracks:[
  {id:'classical_duo_24002',title:'Classical Duo No. 24002',sourceUrl:url}
 ]},'carf-coder.github.io');
 assert.equal(p.selected.length,1);
 assert.equal(p.selected[0].sourceUrl,url);
 assert.match(concatPlaylistText(p.selected,false),/classical_duo_24002\.mp3/);
});
test('selected audio path uses separate 85% game and 22% music and branded overlay',()=>{
 const env={OBS_SLEIPNIR_RELAY_ENABLED:'true',OBS_INGEST_PUBLISH_TOKEN:'test-token-1234567890123456789012345',OBS_SLEIPNIR_STREAM_KEY:'test-key'};
 const args=buildRelayArgs(env,{music:{playlistPath:'/tmp/obs-selected-music.ffconcat',volume:22,autoNext:false},gameVolume:85,overlay:true});
 assert.match(args[args.indexOf('-filter_complex')+1],/volume=0.22/);
 assert.match(args[args.indexOf('-filter_complex')+1],/volume=0.85/);
 assert.ok(args.some(x=>String(x).includes('drawtext=text=')));
 assert.equal(args[args.indexOf('-c:v')+1],'libx264');
});
