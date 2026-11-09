import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTerminalCommand, terminalResponse, OBS_TERMINAL_COMMANDS } from '../src/encoder/obsBackendTerminal.js';
test('terminal allows only read-only documented diagnostics',()=>{
 assert.deepEqual(OBS_TERMINAL_COMMANDS,['help','status','ingress','quality','receiver']);
 for(const name of OBS_TERMINAL_COMMANDS) {
   assert.equal(normalizeTerminalCommand(' '+name.toUpperCase()+' '),name);
   const response=terminalResponse(name,{snapshot:{settings:{profile:{quality:'1080p60'}},receiver:{connected:false,state:'OFFLINE'},telemetry:{fresh:false}}});
   assert.equal(response.command,name);
   assert.ok(response.lines.length>=2);
 }
});
test('shell commands and injection payloads are rejected',()=>{
 for(const input of ['ls','cat /etc/passwd','status; rm -rf /','$(id)','process.env','status\nquality','/bin/sh','exec','start','stop','status --verbose',null,{},'x'.repeat(1000)])
   assert.throws(()=>normalizeTerminalCommand(input),/Unknown terminal command/);
});
test('terminal does not expose secrets or start a livestream',()=>{
 const result=terminalResponse('status',{snapshot:{settings:{relayUrl:'rtmps://secret-key',streamKey:'SENSITIVE',profile:{quality:'1080p60'}},receiver:{connected:false},telemetry:{fresh:false}}});
 assert.doesNotMatch(JSON.stringify(result),/SENSITIVE|secret-key/);
 assert.match(JSON.stringify(result),/responding/);
});
