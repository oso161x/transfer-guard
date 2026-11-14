// Bismillahirrahmanirrahim.
// run-tests.mjs — Transfer Guard test suite.
// Live cases hit DEX Screener + GoPlus + Paraswap + Base RPC for real
// (free, keyless). Fixture cases test branches no live token covers right
// now (honeypot, 35% sell tax) with recorded GoPlus-shaped data.
// Exits non-zero if any case fails. Writes test/RESULTS.md.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkToken, verdictFromEvidence } from '../lib/guard.mjs';
import { handle } from '../lib/handler.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let failures = 0;

function checkOf(result, id) {
  return result.checks.find((c) => c.id === id);
}

function record(name, token, expected, result, extra = '') {
  const pass = expected(result);
  if (!pass) failures++;
  results.push({ name, token, verdict: result.verdict, pass, extra, result });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name} -> ${result.verdict}${extra ? ' | ' + extra : ''}`);
  if (!pass) {
    console.log('      checks:', result.checks.map((c) => `${c.id}:${c.status}`).join(' '));
  }
  return pass;
}

async function live(name, token, expected, amountUsd = null) {
  const result = await checkToken({ chain: 'base', token, amountUsd });
  const key = result.checks.map((c) => `${c.id}=${c.status}`).join(', ');
  record(name, token, expected, result, key);
  await sleep(1200); // stay polite with free APIs
}

console.log('Transfer Guard tests —', new Date().toISOString());
console.log('');

// ---- Live cases (real tokens, real data) ----
await live(
  'USDC (healthy stablecoin, upgradeable proxy)',
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  (r) => r.verdict === 'CAUTION' && checkOf(r, 'honeypot')?.status === 'pass' && checkOf(r, 'tax')?.status === 'pass',
);
await live(
  'WETH (immutable wrapped ETH)',
  '0x4200000000000000000000000000000000000006',
  (r) => r.verdict === 'SAFE',
);
await live(
  'OWB (renounced, LP locked via UNCX)',
  '0xef5997c2cf2f6c138196f8a6203afc335206b3c1',
  (r) => r.verdict === 'SAFE' && checkOf(r, 'lp_lock')?.status === 'pass',
);
await live(
  'RSGP (owner holds 72.7% of supply)',
  '0x44B63aF715D5ef02CC3646a6CE96875e11d69E85',
  (r) => r.verdict === 'BLOCKED' && checkOf(r, 'concentration')?.status === 'fail',
);
await live(
  'PROS (LP 97% unlocked)',
  '0x8B7DdE054BE9D180c1Be7FaE0874697374A49832',
  (r) => (r.verdict === 'BLOCKED' || r.verdict === 'CAUTION') && checkOf(r, 'lp_lock')?.status === 'warn',
);
await live(
  'KNTQ (mintable, live owner)',
  '0xb80194e3868511b8f43e1d5d6e255cd9e7c3e7dd',
  (r) => r.verdict === 'CAUTION' && checkOf(r, 'owner_powers')?.status === 'warn',
);
await live(
  'MEOR (brand-new, unindexed token)',
  '0x06ad8110be9aadd1d4fa661ea764e16311d978c1',
  (r) => r.verdict !== 'SAFE', // a token with no security data must never be SAFE
);

// ---- Fixture cases (branches no live token covers now) ----
function fixture(name, file, token, expected) {
  const data = JSON.parse(readFileSync(join(ROOT, 'test/fixtures', file), 'utf8'));
  const result = verdictFromEvidence({
    chain: 'base',
    token,
    amountUsd: null,
    market: data.market,
    gp: data.goplus,
    decimals: 18,
    sim: { status: 'pass', detail: 'Fixture: sell quote assumed working.' },
    started: Date.now(),
  });
  record(name, token, expected, result, data.note.split('.')[0]);
}
fixture(
  'FIXTURE honeypot (is_honeypot=1, cannot_sell_all=1)',
  'goplus-honeypot.json',
  '0x1111111111111111111111111111111111111111',
  (r) => r.verdict === 'BLOCKED' && checkOf(r, 'honeypot')?.status === 'fail',
);
fixture(
  'FIXTURE high tax (sell tax 35%)',
  'goplus-hightax.json',
  '0x2222222222222222222222222222222222222222',
  (r) => r.verdict === 'BLOCKED' && checkOf(r, 'tax')?.status === 'fail',
);

// ---- Handler smoke tests ----
async function handlerCase(name, req, expected) {
  const out = await handle(req);
  const pass = expected(out);
  if (!pass) failures++;
  results.push({ name, token: '-', verdict: `HTTP ${out.status}`, pass, extra: '', result: out.body });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} -> HTTP ${out.status}`);
  if (!pass) console.log('      body:', JSON.stringify(out.body).slice(0, 300));
}
await handlerCase('GET /health', { method: 'GET', path: '/health', bodyText: '' }, (o) => o.status === 200 && o.body.status === 'ok');
await handlerCase(
  'POST /guard/check bad address -> 400',
  { method: 'POST', path: '/guard/check', bodyText: JSON.stringify({ chain: 'base', token: 'not-an-address' }) },
  (o) => o.status === 400,
);
await handlerCase(
  'POST /guard/check bad chain -> 400',
  { method: 'POST', path: '/guard/check', bodyText: JSON.stringify({ chain: 'solana', token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }) },
  (o) => o.status === 400,
);
if (!process.env.KURIER_API_KEY) {
  await handlerCase(
    'POST /verify-proof without key -> 501 + instructions',
    { method: 'POST', path: '/verify-proof', bodyText: JSON.stringify({ proof: {}, publicSignals: ['1'], vk: {} }) },
    (o) => o.status === 501 && Array.isArray(o.body.how_to_enable),
  );
} else {
  console.log('[SKIP] /verify-proof 501 test (KURIER_API_KEY is set)');
}

// ---- Server boot smoke test ----
async function serverBoot() {
  const name = 'server.mjs boots + GET /health';
  const port = 3456;
  const proc = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port) } });
  let pass = false;
  try {
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        const body = await res.json();
        pass = res.status === 200 && body.status === 'ok';
        break;
      } catch { /* not up yet */ }
    }
  } finally {
    proc.kill('SIGTERM');
  }
  if (!pass) failures++;
  results.push({ name, token: '-', verdict: pass ? 'HTTP 200' : 'BOOT FAIL', pass, extra: '', result: null });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}`);
}
await serverBoot();

// ---- Write RESULTS.md ----
const lines = [
  '# Transfer Guard — test results',
  '',
  `Run: ${new Date().toISOString()} (WIB ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Jakarta' })})`,
  `Result: ${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'} (${results.filter((r) => r.pass).length}/${results.length})`,
  '',
  '| Case | Token | Verdict | Result |',
  '| ---- | ----- | ------- | ------ |',
];
for (const r of results) {
  lines.push(`| ${r.name} | \`${String(r.token).slice(0, 14)}…\` | ${r.verdict} | ${r.pass ? 'PASS' : 'FAIL'} |`);
}
lines.push('');
lines.push('## Notes');
lines.push('');
lines.push('- Live cases use real DEX Screener + GoPlus + Paraswap + Base RPC data at run time; verdicts can drift as on-chain data changes.');
lines.push('- USDC is CAUTION (not SAFE) because it is an upgradeable proxy — see README "Why USDC is CAUTION".');
lines.push('- FIXTURE cases use recorded GoPlus-shaped data (see test/fixtures/*.json); no live is_honeypot=1 token was indexed on Base at build time.');
lines.push('- /verify-proof is 501 without KURIER_API_KEY by design (see README "zkVerify integration").');
lines.push('');
writeFileSync(join(ROOT, 'test/RESULTS.md'), lines.join('\n'));
console.log('');
console.log(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
