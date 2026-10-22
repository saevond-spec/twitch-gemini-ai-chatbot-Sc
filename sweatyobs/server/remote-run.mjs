import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { validateDestinations } from './multistream.mjs';
import { loadLicensedCatalog } from '../encoder/encoder.mjs';
import { pollRemoteCommands, reportRemoteStatus } from './remoteBridgeClient.mjs';
import { RemoteEncoderAgent } from './remoteEncoderAgent.mjs';
import { RemoteMultistreamRuntime } from './remoteMultistreamRuntime.mjs';

const targetFile = process.env.MULTISTREAM_TARGETS_FILE || '';
if (!isAbsolute(targetFile) || (statSync(targetFile).mode & 0o077) !== 0) {
  throw new Error('MULTISTREAM_TARGETS_FILE must be an absolute chmod-600 file');
}
const destinations = validateDestinations(JSON.parse(readFileSync(targetFile, 'utf8')));
const musicDir = process.env.LICENSED_MUSIC_DIR || '';
if (musicDir && !isAbsolute(musicDir)) throw new Error('LICENSED_MUSIC_DIR must be an absolute host directory');
const stations = musicDir ? loadLicensedCatalog(musicDir) : { club: [], dubstep: [] };
const hostToken = process.env.ENCODER_REMOTE_HOST_TOKEN || '';
const serviceUrl = process.env.ENCODER_SERVICE_URL || '';
if (hostToken.length < 32 || !/^https:\/\/[^\s/]+\/?$/.test(serviceUrl)) {
  throw new Error('Configure a 32+ character ENCODER_REMOTE_HOST_TOKEN and HTTPS encoder API origin');
}

const runtime = new RemoteMultistreamRuntime({
  destinations,
  stations,
  source: process.env.PS5_INGEST_SOURCE || 'rtmp://127.0.0.1:1935/relay/ps5',
});
const agent = new RemoteEncoderAgent({
  runtime,
  poll: (cursor, instanceId) => pollRemoteCommands({ url: serviceUrl, token: hostToken, cursor, instanceId }),
  report: (status, instanceId) => reportRemoteStatus({ url: serviceUrl, token: hostToken, status, instanceId }),
  intervalMs: 1500,
  onError: () => console.error('Remote command service unavailable; retrying. Active streams continue on this host.'),
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  agent.stop();
  console.log('Remote encoder host stopped.');
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
agent.start();
console.log('Remote encoder host ready; waiting for an authenticated phone command. No stream has started.');
