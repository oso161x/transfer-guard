// Bismillahirrahmanirrahim.
// handler.mjs — transport-agnostic router for Transfer Guard.
// handle({ method, path, query, bodyText }) -> { status, body }.
// Used by server.mjs (node:http) and api/index.mjs (Vercel serverless).

import { checkToken, isSupportedChain, isAddress } from './guard.mjs';
import { verifyGroth16, kurierReady, kurierConfig } from './zkverify.mjs';

const VERSION = '0.1.0';
const STARTED_AT = new Date().toISOString();

function json(status, body) {
  return { status, body };
}

function badRequest(message) {
  return json(400, { error: message });
}

async function readBody(bodyText) {
  if (!bodyText) return {};
  try {
    return JSON.parse(bodyText);
  } catch {
    return { __parseError: true };
  }
}

export async function handle({ method, path, bodyText }) {
  const clean = (path || '/').split('?')[0].replace(/\/+$/, '') || '/';

  if (method === 'GET' && (clean === '/' || clean === '/health')) {
    return json(200, {
      status: 'ok',
      service: 'transfer-guard',
      version: VERSION,
      started_at: STARTED_AT,
      uptime_s: Math.floor(process.uptime()),
      chains: ['base'],
      endpoints: ['GET /health', 'POST /guard/check', 'POST /verify-proof'],
      zkverify: kurierReady()
        ? { configured: true, env: kurierConfig().env }
        : { configured: false, note: 'Set KURIER_API_KEY to enable POST /verify-proof (see README).' },
    });
  }

  if (method === 'POST' && clean === '/guard/check') {
    const body = await readBody(bodyText);
    if (body.__parseError) return badRequest('Body must be valid JSON.');
    const chain = String(body.chain || 'base').toLowerCase();
    const token = body.token;
    const amountUsd = body.amount_usd === undefined || body.amount_usd === null ? null : Number(body.amount_usd);
    if (!isSupportedChain(chain)) {
      return badRequest(`Unsupported chain "${chain}". Supported: base (chain 8453).`);
    }
    if (!isAddress(token)) {
      return badRequest('token must be an ERC-20 contract address (0x + 40 hex chars).');
    }
    if (amountUsd !== null && (!Number.isFinite(amountUsd) || amountUsd <= 0)) {
      return badRequest('amount_usd must be a positive number when provided.');
    }
    try {
      const result = await checkToken({ chain, token, amountUsd });
      return json(200, result);
    } catch (err) {
      return json(502, { error: `Guard check failed: ${err.message}`, token, chain });
    }
  }

  if (method === 'POST' && clean === '/verify-proof') {
    if (!kurierReady()) {
      return json(501, {
        error: 'zkVerify demo is not configured: KURIER_API_KEY is not set.',
        how_to_enable: [
          '1. Request a Kurier API key from the Horizen Labs team (see https://docs.zkverify.io/overview/getting-started/kurier — "Kurier requires an API key. Request one first").',
          '2. Set KURIER_API_KEY=<your key> (and optionally KURIER_ENV=testnet) in the environment and restart.',
          '3. Generate a Groth16 proof + verification key + public signals with snarkjs/circom (see https://docs.zkverify.io/overview/getting-started/generating-proof) and POST them here.',
        ],
        docs: 'https://docs.zkverify.io/overview/getting-started/kurier',
        swagger_testnet: 'https://api-testnet.kurier.xyz/docs',
      });
    }
    const body = await readBody(bodyText);
    if (body.__parseError) return badRequest('Body must be valid JSON.');
    const { proof, publicSignals, vk } = body;
    if (!proof || !Array.isArray(publicSignals) || !vk) {
      return badRequest('Body needs { proof, publicSignals: [...], vk } — a snarkjs Groth16 proof, its public inputs, and its verification key object (or a registered vkHash string).');
    }
    try {
      const result = await verifyGroth16({ proof, publicSignals, vk });
      return json(200, {
        verified: result.verified,
        status: result.status,
        jobId: result.jobId,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        statement: result.statement,
        note: 'Proof verified on zkVerify (Volta testnet) via Kurier. Check the txHash on the zkVerify explorer.',
      });
    } catch (err) {
      const status = err.code === 'BAD_INPUT' ? 400 : err.code === 'POLL_TIMEOUT' ? 504 : 502;
      return json(status, { error: err.message, code: err.code || 'VERIFY_FAILED', jobId: err.jobId || null });
    }
  }

  return json(404, {
    error: `Unknown route ${method} ${clean}.`,
    usage: {
      'GET /health': 'service status',
      'POST /guard/check': '{ "chain": "base", "token": "0x...", "amount_usd": 100 }',
      'POST /verify-proof': '{ "proof": {...}, "publicSignals": [...], "vk": {...} } (needs KURIER_API_KEY)',
    },
  });
}
