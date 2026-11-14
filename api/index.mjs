// Bismillahirrahmanirrahim.
// api/index.mjs — Vercel serverless adapter for Transfer Guard.
// Vercel rewrites every path to this function (see vercel.json).

import { handle } from '../lib/handler.mjs';

export default async function handler(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bodyText = Buffer.concat(chunks).toString('utf8');
  const path = req.url || '/';
  try {
    const out = await handle({ method: req.method || 'GET', path, bodyText });
    res.status(out.status).json(out.body);
  } catch (err) {
    res.status(500).json({ error: `Internal error: ${err.message}` });
  }
}
