import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile } from '../src/encoder/receiverControl.js';
import { ObsWebControl } from '../src/encoder/obsWebControl.js';
test('1080p60 is accepted as a requested profile, not proof of active ingest',()=>{
 const p=normalizeProfile({quality:'1080p60',overlay:true});
 assert.equal(p.quality,'1080p60');
 assert.equal(p.overlay,true);
 assert.throws(()=>normalizeProfile({quality:'2160p60'}),/Unknown quality/);
});
test('profile sync remains available even without selected music tracks',()=>{
 const control=new ObsWebControl({env:{OBS_MUSIC_LIBRARY_JSON:'[]',OBS_MUSIC_SYNC_TOKEN:'q'.repeat(40)}});
 control.save({...control.settings,profile:{quality:'1080p60'}});
 assert.equal(control.settings.profile.quality,'1080p60');
 assert.equal(control.snapshot().settings.profile.quality,'1080p60');
});
