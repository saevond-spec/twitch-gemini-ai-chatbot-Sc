/** Generates reviewable dnsmasq + nginx-rtmp settings. Does not deploy/change DNS. */
import { isIP } from 'node:net';
function validPublic(ip) {
  if (typeof ip !== 'string' || isIP(ip) !== 4) return false;
  const n = ip.split('.').map(Number);
  return n[0] > 0 && n[0] < 224 && n[0] !== 10 && n[0] !== 127 &&
    !(n[0] === 172 && n[1] >= 16 && n[1] <= 31) &&
    !(n[0] === 192 && n[1] === 168) &&
    !(n[0] === 169 && n[1] === 254) &&
    !(n[0] === 100 && n[1] >= 64 && n[1] <= 127) &&
    !(n[0] === 198 && n[1] >= 18 && n[1] <= 19) &&
    !(n[0] === 192 && n[1] === 0) &&
    !(n[0] === 198 && n[1] === 51 && n[2] === 100) &&
    !(n[0] === 203 && n[1] === 0 && n[2] === 113);
}
function validPrivate(ip) {
  if (typeof ip !== 'string' || isIP(ip) !== 4) return false;
  const n = ip.split('.').map(Number);
  return n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
    (n[0] === 192 && n[1] === 168);
}
export function generateServerConfig({ receiverPublicIp, receiverPrivateIp, homePublicIp } = {}) {
  if (!validPublic(receiverPublicIp) || !validPrivate(receiverPrivateIp) || !validPublic(homePublicIp) ||
      receiverPublicIp === homePublicIp) throw Error('Require valid VM public/private and home public IPv4');
  const dns = '# Firewall must restrict UDP/TCP 53 to home public IP. NEVER run an open resolver.\n' +
    'port=53\nno-resolv\nserver=1.1.1.1\nserver=1.0.0.1\n' +
    'listen-address=' + receiverPrivateIp + '\nbind-interfaces\n' +
    'address=/contribute.live-video.net/' + receiverPublicIp + '\n';
  const sourceApp = name => '  application ' + name + ' {\n    live on;\n    record off;\n' +
    '    allow publish ' + homePublicIp + ';\n    deny publish all;\n' +
    '    allow play 127.0.0.1;\n    deny play all;\n' +
    '    push rtmp://127.0.0.1:1935/relay/ps5;\n  }\n';
  const nginx = 'load_module modules/ngx_rtmp_module.so;\nworker_processes 2;\n' +
    'pid /run/sweatyobs-nginx.pid;\nevents { worker_connections 1024; }\n' +
    'rtmp {\n server {\n  listen 1935;\n  chunk_size 4096;\n' +
    sourceApp('app') + sourceApp('live') +
    '  application relay {\n    live on;\n    record off;\n' +
    '    allow publish 127.0.0.1;\n    deny publish all;\n' +
    '    allow play 127.0.0.1;\n    deny play all;\n  }\n }\n}\n';
  const firewall = { ingress: [
    { protocol: 'tcp', port: 1935, source: homePublicIp + '/32', purpose: 'PS5 RTMP' },
    { protocol: 'udp', port: 53, source: homePublicIp + '/32', purpose: 'DNS' },
    { protocol: 'tcp', port: 53, source: homePublicIp + '/32', purpose: 'DNS fallback' },
  ] };
  return { dns, nginx, firewall };
}
