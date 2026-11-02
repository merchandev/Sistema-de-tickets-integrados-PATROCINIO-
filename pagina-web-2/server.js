require('dotenv').config();
const express = require('express');
const path = require('node:path');

const PORT = parseInt(process.env.PORT || '3002', 10);
const CENTRAL_API_URL = process.env.CENTRAL_API_URL ?? 'http://localhost:4000';
const SOURCE_WEB = 'pagina-web-2';

const app = express();

app.get('/config-client.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    window.ENTRADAS_CONFIG = {
      CENTRAL_API_URL: ${JSON.stringify(CENTRAL_API_URL)},
      SOURCE_WEB: ${JSON.stringify(SOURCE_WEB)},
      SITE_LABEL: "PÁGINA WEB 2 (Proyecto Independiente #2)"
    };
  `);
});

const http = require('node:http');
const upstream = process.env.CENTRAL_INTERNAL_URL;
const salesKey = process.env.WEB_PROXY_KEY_FILE ? require('node:fs').readFileSync(process.env.WEB_PROXY_KEY_FILE, 'utf8').trim() : '';
function salesHeaders(req) { return {...req.headers, 'x-sales-source':SOURCE_WEB, 'x-sales-key':salesKey}; }
app.get('/health', (_req, res) => res.json({ok:true}));
if (upstream) app.use(['/api/public', '/socket.io'], (req, res) => {
  const target = new URL(upstream);
  const proxy = http.request({hostname:target.hostname, port:target.port, path:req.originalUrl, method:req.method, headers:salesHeaders(req)}, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  proxy.on('error', () => { if (!res.headersSent) res.status(502).json({ok:false}); else res.end(); });
  req.pipe(proxy);
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 [PÁGINA WEB 2] Activa en http://localhost:${PORT} -> Conectada a ${CENTRAL_API_URL}`);
});

server.on('upgrade', (req, socket, head) => {
  if (!upstream || !req.url.startsWith('/socket.io/')) return socket.destroy();
  const target = new URL(upstream);
  const proxy = http.request({hostname:target.hostname, port:target.port, path:req.url, headers:salesHeaders(req)});
  proxy.on('upgrade', (response, remote, remoteHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers).map(([k,v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.pipe(socket); socket.pipe(remote);
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
    socket.on('close', () => remote.destroy());
  });
  proxy.on('error', () => socket.destroy()); proxy.end();
});
