// Minimal host server to prove nodejs-mobile runs a real server on Android.
const http = require('http');
const fs = require('fs');
const port = 8788;
const flag = process.argv[2] || 'node-ok.txt';

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('OK - nodejs-mobile server running, port ' + port + ' @ ' + new Date().toISOString());
}).listen(port, () => {
  try {
    fs.writeFileSync(flag, 'PORT:' + port + ' OK ' + new Date().toISOString());
  } catch (e) { console.log('write flag fail', e && e.message); }
  console.log('NODEJS-MOBILE: server listening on ' + port);
});

process.on('uncaughtException', (e) => { console.log('uncaught', e && e.message); });
