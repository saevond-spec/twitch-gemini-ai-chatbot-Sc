import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('OBS browser dashboard clearly identifies its limited capability', () => {
  const html=readFileSync('public/obs-web.html','utf8');
  assert.match(html,/not an RTMP receiver/i);
  assert.match(html,/not.*viewer.*hear|Viewer-audible mixing is NOT verified/i);
  assert.match(html,/no APK/i);
  assert.doesNotMatch(html,/stream.key|store.*password|type="password"/i);
});
test('OBS dashboard never uses local stream key persistence or publishing',()=>{
  const client=readFileSync('public/obs-web.js','utf8');
  assert.doesNotMatch(client,/localStorage|indexedDB|rtmps:|RTCPeerConnection|fetch\([^)]*stream.*key/i);
  assert.match(client,/WebSocket/);
  assert.match(client,/music\.init/);
});
test('OBS web route includes CSP and no-store',()=>{
  const app=readFileSync('src/app.js','utf8');
  const route=app.slice(app.indexOf("app.get('/obs-web'"),app.indexOf("app.get('/music-player'"));
  assert.match(route,/Content-Security-Policy/);
  assert.match(route,/no-store/);
  assert.match(route,/obs-web\.html/);
});
