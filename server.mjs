// Bismillahirrahmanirrahim.
// server.mjs — Transfer Guard, local/dev entrypoint.
//   PORT=3000 node server.mjs
// No dependencies; Node >= 20.

import http from 'node:http';
import { handle } from './lib/handler.mjs';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const out = await handle({ method: req.method || 'GET', path: url.pathname, bodyText });
      const payload = JSON.stringify(out.body);
      res.writeHead(out.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    } catch (err) {
      const payload = JSON.stringify({ error: `Internal error: ${err.message}` });
      res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Transfer Guard listening on http://${HOST}:${PORT} (GET /health, POST /guard/check, POST /verify-proof)`);
});
