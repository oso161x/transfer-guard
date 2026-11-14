// Bismillahirrahmanirrahim.
// guard.mjs — Transfer Guard's verdict engine.
// Read-only. Checks a Base token with public data only:
//   - DEX Screener (market: price, liquidity, volume, txns, pool age)
//   - GoPlus token_security (honeypot, taxes, owner powers, holders, LP)
//   - Paraswap prices API (sell simulation: can this token actually be sold?)
//   - Base public RPC eth_call (token decimals, needed for the sell quote)
//
// Verdict rules (same evidence bar as the OSO-161 Base trading agent's
// rug check, adapted from a trade veto into an advisory verdict):
//   BLOCKED  — honeypot / cannot sell / tax > 20% / single EOA holds > 50%
//              / top-10 EOAs hold > 70% / liquidity < $5k (cannot exit)
//   CAUTION  — tax 5–20% / mintable-blacklist-pausable owner powers / proxy /
//              unverified source / LP lock unconfirmed / top-10 EOAs 40–70% /
//              liquidity < $30k / pool younger than 3h / no sells in 24h /
//              price impact of your amount > 1% of liquidity
//   SAFE     — no fail, no warn
//   UNKNOWN  — neither GoPlus nor DEX Screener returned usable data
// An `unknown` check alone never forces CAUTION; a missing data source is
// reported as unknown so the caller can see the evidence gap.
//
// Holder math (GoPlus `holders[].percent` is a FRACTION of supply):
//   top10_raw       = top-10 holders, as returned
//   top10_ex_pool   = excluding DEX pair addresses + the burn address
//   top10_eoa       = also excluding contracts (is_contract = 1)
// The verdict uses top10_eoa: protocol contracts (staking/vesting/voter)
// hold large chunks of honest tokens, and counting them as "whales" would
// flag every real project. The raw numbers are still reported, and the top
// contract holders are listed so a human can verify they are really
// protocol contracts (see README "Known limitation").

import { fetchJson, baseRpcCall } from './sources.mjs';

export const SUPPORTED_CHAINS = { base: 8453 };
export const WETH_BASE = '0x4200000000000000000000000000000000000006';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

const GO_PLUS = 'https://api.gopluslabs.io/api/v1/token_security';
const DEX = 'https://api.dexscreener.com/tokens/v1';

const DECIMALS_SELECTOR = '0x313ce567';

function isAddress(v) {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v);
}

function toNum(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** GoPlus buy_tax/sell_tax come back as a fraction ("0.05") or a percent
 *  ("5") depending on the token. Normalise to percent. */
function taxToPercent(v) {
  const n = toNum(v);
  if (n === null) return null;
  if (n < 0) return null;
  return n <= 1 ? n * 100 : n;
}

function check(id, label, status, detail) {
  return { id, label, status, detail };
}

async function getDecimals(token) {
  try {
    const result = await baseRpcCall(token, DECIMALS_SELECTOR);
    if (typeof result === 'string' && result.length >= 2) {
      const d = parseInt(result, 16);
      if (Number.isInteger(d) && d >= 0 && d <= 36) return d;
    }
  } catch {
    // RPC is a convenience for the sell quote only; never fatal.
  }
  return null;
}

/** Sell simulation: ask Paraswap for a token -> WETH quote.
 *  A working quote means a sell route exists right now. A failed quote is
 *  `unknown` (routing hiccups happen), never a fail by itself. */
async function simulateSell(token, decimals, priceUsd) {
  if (token.toLowerCase() === WETH_BASE) {
    return { status: 'pass', detail: 'Token is WETH itself (the quote asset) — selling is just unwrapping, always possible.' };
  }
  if (decimals === null || !priceUsd || priceUsd <= 0) return { status: 'unknown', detail: 'No decimals/price, sell quote skipped.' };
  try {
    const notionalUsd = 10;
    const tokens = notionalUsd / priceUsd;
    const raw = BigInt(Math.floor(tokens * 10 ** decimals)).toString();
    const url =
      'https://apiv5.paraswap.io/prices/?' +
      new URLSearchParams({
        srcToken: token,
        destToken: WETH_BASE,
        amount: raw,
        srcDecimals: String(decimals),
        destDecimals: '18',
        network: '8453',
      }).toString();
    const data = await fetchJson(url, { timeoutMs: 8000, retries: 0 });
    const out = data?.priceRoute?.destAmount ?? data?.destAmount;
    if (out) {
      return { status: 'pass', detail: `Sell quote works: $${notionalUsd} of token -> ${out} raw WETH via Paraswap.` };
    }
    return { status: 'unknown', detail: 'Paraswap returned a quote without an output amount.' };
  } catch (err) {
    return { status: 'unknown', detail: `Sell quote unavailable (${err.message}).` };
  }
}

/**
 * Pure verdict computation from already-fetched evidence.
 * Exported so tests can feed recorded GoPlus/DEX Screener fixtures
 * (e.g. a honeypot response) without touching the network.
 * `sim` is { status, detail } from simulateSell (or an equivalent stub).
 */
export function verdictFromEvidence({ chain, token, amountUsd = null, market, gp, decimals, sim, started = Date.now(), fetchNotes = [] }) {
  const address = token.toLowerCase();
  const checks = [...fetchNotes];

  if (!market && !gp) {
    return {
      agent: 'transfer-guard',
      version: '0.1.0',
      chain,
      token: { address, symbol: null, name: null, decimals: decimals ?? null },
      verdict: 'UNKNOWN',
      summary: 'No market or security data could be fetched for this token.',
      advice: 'Do not send or approve this token until it can be checked — right now there is no evidence either way.',
      amount_usd: amountUsd,
      market: null,
      checks,
      top_holders: [],
      concentration: null,
      lp: null,
      sources: ['dexscreener', 'goplus', 'paraswap', 'base-rpc'],
      checked_at: new Date().toISOString(),
      latency_ms: Date.now() - started,
      disclaimer: 'Read-only advisory check from public data, not financial advice. Data can change between blocks.',
    };
  }

  // ---- Check 1: honeypot / cannot sell / cannot buy ----
  if (gp) {
    const honeypot = gp.is_honeypot === '1' || gp.is_honeypot === 1;
    const cannotSell = gp.cannot_sell_all === '1' || gp.cannot_sell_all === 1;
    const cannotBuy = gp.cannot_buy === '1' || gp.cannot_buy === 1;
    if (honeypot || cannotSell || cannotBuy) {
      const why = [
        honeypot ? 'flagged as a honeypot by GoPlus' : null,
        cannotSell ? 'holders cannot sell all (cannot_sell_all)' : null,
        cannotBuy ? 'token cannot be bought (cannot_buy)' : null,
      ]
        .filter(Boolean)
        .join('; ');
      checks.push(check('honeypot', 'Honeypot / sellability', 'fail', `BLOCKED: ${why}.`));
    } else {
      const missing = gp.cannot_sell_all === undefined && gp.is_honeypot === undefined;
      checks.push(
        check(
          'honeypot',
          'Honeypot / sellability',
          missing ? 'unknown' : 'pass',
          missing
            ? 'GoPlus returned no honeypot fields for this token.'
            : 'Not flagged as a honeypot; holders can sell.',
        ),
      );
    }
  }

  // ---- Check 2: buy/sell tax ----
  if (gp) {
    const buy = taxToPercent(gp.buy_tax);
    const sell = taxToPercent(gp.sell_tax);
    if (buy === null && sell === null) {
      checks.push(check('tax', 'Buy/sell tax', 'unknown', 'GoPlus returned no tax values for this token.'));
    } else {
      const max = Math.max(buy ?? 0, sell ?? 0);
      checks.push(
        check(
          'tax',
          'Buy/sell tax',
          max > 20 ? 'fail' : max > 5 ? 'warn' : 'pass',
          `Buy tax ${buy === null ? 'n/a' : buy + '%'}, sell tax ${sell === null ? 'n/a' : sell + '%'} (limit 5%).`,
        ),
      );
    }
  }

  // ---- Check 3: owner powers (mint / blacklist / pause / hidden owner / selfdestruct) ----
  if (gp) {
    const renounced = (gp.owner_address || '').toLowerCase() === ZERO_ADDRESS;
    const flags = [];
    for (const [key, label] of [
      ['is_mintable', 'mintable supply'],
      ['is_blacklisted', 'blacklist function'],
      ['transfer_pausable', 'pausable transfers'],
      ['hidden_owner', 'hidden owner'],
      ['selfdestruct', 'selfdestruct'],
      ['can_take_back_ownership', 'ownership can be reclaimed'],
    ]) {
      if (gp[key] === '1' || gp[key] === 1) flags.push(label);
    }
    if (flags.length === 0) {
      checks.push(check('owner_powers', 'Owner powers', 'pass', 'No abusable mint/blacklist/pause/hidden-owner flags.'));
    } else if (renounced) {
      checks.push(
        check(
          'owner_powers',
          'Owner powers',
          'pass',
          `Flags present (${flags.join(', ')}) but owner is 0x0 (renounced) — nobody can call them.`,
        ),
      );
    } else {
      checks.push(
        check(
          'owner_powers',
          'Owner powers',
          'warn',
          `Owner can: ${flags.join(', ')}. Owner: ${gp.owner_address || 'unknown'}.`,
        ),
      );
    }
  }

  // ---- Check 4: proxy (upgradeable logic) ----
  if (gp && (gp.is_proxy === '1' || gp.is_proxy === 1)) {
    checks.push(
      check('proxy', 'Upgradeable proxy', 'warn', 'Contract logic can be changed by its admin (proxy). Normal for some stablecoins, still a trust assumption.'),
    );
  } else if (gp) {
    checks.push(check('proxy', 'Upgradeable proxy', 'pass', 'Not a proxy contract.'));
  }

  // ---- Check 5: verified source ----
  if (gp) {
    if (gp.is_open_source === '0' || gp.is_open_source === 0) {
      checks.push(check('source', 'Verified contract source', 'warn', 'Contract source is not verified.'));
    } else if (gp.is_open_source === '1' || gp.is_open_source === 1) {
      checks.push(check('source', 'Verified contract source', 'pass', 'Contract source is verified.'));
    } else {
      checks.push(check('source', 'Verified contract source', 'unknown', 'GoPlus returned no source-verification field.'));
    }
  }

  // ---- Check 6: holder concentration ----
  let concentration = null;
  if (gp && Array.isArray(gp.holders)) {
    const pairAddrs = new Set((market?.pair_addresses || []).map((a) => (a || '').toLowerCase()).filter(Boolean));
    const isPool = (a) => pairAddrs.has((a || '').toLowerCase());
    const isDead = (a) => (a || '').toLowerCase() === DEAD_ADDRESS;
    const pct = (h) => (toNum(h.percent) ?? 0) * 100; // GoPlus percent is a fraction
    const exPool = gp.holders.filter((h) => !isPool(h.address) && !isDead(h.address));
    const eoa = exPool.filter((h) => h.is_contract !== 1);
    const sum = (arr) => arr.reduce((s, h) => s + pct(h), 0);
    const topRaw = sum(gp.holders.slice(0, 10));
    const topExPool = sum(exPool.slice(0, 10));
    const topEoa = sum(eoa.slice(0, 10));
    const largest = eoa.slice(0, 10).reduce((m, h) => (pct(h) > (m?.pct ?? 0) ? { address: h.address, pct: pct(h) } : m), null);
    concentration = {
      top10_raw_pct: Math.round(topRaw * 10) / 10,
      top10_ex_pool_pct: Math.round(topExPool * 10) / 10,
      top10_eoa_pct: Math.round(topEoa * 10) / 10,
      largest_eoa_holder: largest?.address ?? null,
      largest_eoa_holder_pct: largest ? Math.round(largest.pct * 10) / 10 : null,
      holder_count: toNum(gp.holder_count),
    };
    // Single-holder rule uses ALL ex-pool holders (contracts included):
    // a contract holding > 50% is still one entity in control. It fails
    // outright when the holder is an EOA or the token owner (the classic
    // owner-holds-the-supply rug setup, e.g. RSGP); a non-owner contract
    // warns instead — it may be a genuine staking/vesting contract, but
    // that needs a human to verify on Basescan.
    const ownerAddr = (gp.owner_address || '').toLowerCase();
    const largestAny = exPool.slice(0, 10).reduce((m, h) => (pct(h) > (m?.pct ?? 0) ? { address: h.address, pct: pct(h), isContract: h.is_contract === 1 } : m), null);
    if (largestAny && largestAny.pct > 50) {
      const isOwner = (largestAny.address || '').toLowerCase() === ownerAddr;
      if (!largestAny.isContract || isOwner) {
        checks.push(
          check('concentration', 'Holder concentration', 'fail', `One ${isOwner ? 'owner' : 'wallet'} (${largestAny.address}) holds ${largestAny.pct.toFixed(1)}% of supply — it alone can crash the price.`),
        );
      } else {
        checks.push(
          check('concentration', 'Holder concentration', 'warn', `One contract (${largestAny.address}) holds ${largestAny.pct.toFixed(1)}% of supply — verify on Basescan that it is a genuine protocol (staking/vesting) contract, not an owner wallet.`),
        );
      }
    } else if (largest && largest.pct > 50) {
      checks.push(
        check('concentration', 'Holder concentration', 'fail', `One wallet (${largest.address}) holds ${largest.pct.toFixed(1)}% of supply — it alone can crash the price.`),
      );
    } else if (topEoa > 70) {
      checks.push(check('concentration', 'Holder concentration', 'fail', `Top-10 non-contract holders own ${topEoa.toFixed(1)}% of supply (limit 40%).`));
    } else if (topEoa > 40) {
      checks.push(check('concentration', 'Holder concentration', 'warn', `Top-10 non-contract holders own ${topEoa.toFixed(1)}% of supply (limit 40%).`));
    } else {
      checks.push(check('concentration', 'Holder concentration', 'pass', `Top-10 non-contract holders own ${topEoa.toFixed(1)}% of supply (limit 40%).`));
    }
  } else if (gp) {
    checks.push(check('concentration', 'Holder concentration', 'unknown', 'GoPlus returned no holder list for this token.'));
  }

  // ---- Check 7: LP lock ----
  let lp = null;
  if (gp && Array.isArray(gp.lp_holders)) {
    if (gp.lp_holders.length === 0) {
      checks.push(check('lp_lock', 'LP lock', 'unknown', 'GoPlus returned no LP holder data.'));
    } else {
      const lockedPct = gp.lp_holders.reduce((s, h) => {
        const p = (toNum(h.percent) ?? 0) * 100;
        const burned = (h.address || '').toLowerCase() === DEAD_ADDRESS;
        return s + (h.is_locked === 1 || burned ? p : 0);
      }, 0);
      const largestLp = gp.lp_holders.reduce((m, h) => {
        const p = (toNum(h.percent) ?? 0) * 100;
        return p > (m?.pct ?? 0) ? { address: h.address, pct: p, locked: h.is_locked === 1, tag: h.tag || '' } : m;
      }, null);
      lp = {
        locked_pct: Math.round(lockedPct * 10) / 10,
        largest_lp_holder: largestLp?.address ?? null,
        largest_lp_holder_pct: largestLp ? Math.round(largestLp.pct * 10) / 10 : null,
        largest_lp_holder_locked: largestLp?.locked ?? null,
        largest_lp_holder_tag: largestLp?.tag ?? '',
      };
      if (lockedPct >= 50) {
        checks.push(check('lp_lock', 'LP lock', 'pass', `${lockedPct.toFixed(1)}% of LP is locked/burned${largestLp?.tag ? ` (largest: ${largestLp.tag})` : ''}.`));
      } else if (lockedPct > 0) {
        checks.push(check('lp_lock', 'LP lock', 'warn', `Only ${lockedPct.toFixed(1)}% of LP is locked; ${largestLp ? largestLp.pct.toFixed(1) + '% sits with ' + largestLp.address : 'the rest is unlocked'}.`));
      } else {
        checks.push(
          check('lp_lock', 'LP lock', 'warn', `LP lock unconfirmed — largest LP holder (${largestLp?.address ?? 'unknown'}) holds ${largestLp ? largestLp.pct.toFixed(1) : '?'}% unlocked.`),
        );
      }
    }
  } else if (gp) {
    checks.push(check('lp_lock', 'LP lock', 'unknown', 'GoPlus returned no LP data.'));
  }

  // ---- Check 8: liquidity / market depth ----
  if (market) {
    const liq = market.liquidity_usd;
    if (liq === null) {
      checks.push(check('liquidity', 'Liquidity', 'unknown', 'DEX Screener returned no liquidity figure.'));
    } else if (liq < 5000) {
      checks.push(check('liquidity', 'Liquidity', 'fail', `Liquidity is only $${liq.toLocaleString()} — too thin to exit a position.`));
    } else if (liq < 30000) {
      checks.push(check('liquidity', 'Liquidity', 'warn', `Liquidity is $${liq.toLocaleString()} (thin; under the $30k bar).`));
    } else {
      checks.push(check('liquidity', 'Liquidity', 'pass', `Liquidity $${liq.toLocaleString()} on ${market.dex ?? 'DEX'}.`));
    }
    if (market.sells_h24 === 0 && (market.buys_h24 ?? 0) > 0) {
      checks.push(check('sells', 'Recent sells', 'warn', 'Nobody sold in the last 24h while buys happened — selling may be hard.'));
    } else if (market.sells_h24 !== null) {
      checks.push(check('sells', 'Recent sells', 'pass', `${market.sells_h24} sells in the last 24h — people are exiting normally.`));
    }
    if (market.pair_age_hours !== null && market.pair_age_hours < 3) {
      checks.push(check('pool_age', 'Pool age', 'warn', `Pool is only ${market.pair_age_hours}h old — brand-new pools are the riskiest.`));
    } else if (market.pair_age_hours !== null) {
      checks.push(check('pool_age', 'Pool age', 'pass', `Pool is ${market.pair_age_hours}h old.`));
    }
    if (amountUsd && liq) {
      const impact = (amountUsd / liq) * 100;
      if (impact > 1) {
        checks.push(check('price_impact', 'Price impact', 'warn', `Your $${amountUsd} is ${impact.toFixed(2)}% of the pool's liquidity — expect slippage.`));
      } else {
        checks.push(check('price_impact', 'Price impact', 'pass', `Your $${amountUsd} is ${impact.toFixed(2)}% of liquidity — negligible impact.`));
      }
    }
  } else {
    checks.push(check('liquidity', 'Liquidity', 'warn', 'No DEX market found for this token on Base — there may be nowhere to sell.'));
  }

  // ---- Check 9: sell simulation (Paraswap quote) ----
  checks.push(check('sell_simulation', 'Sell simulation', sim.status, sim.detail));

  // ---- Verdict ----
  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');
  const verdict = hasFail ? 'BLOCKED' : hasWarn ? 'CAUTION' : 'SAFE';
  const failReasons = checks.filter((c) => c.status === 'fail').map((c) => c.detail);
  const warnReasons = checks.filter((c) => c.status === 'warn').map((c) => c.detail);
  const symbol = market?.symbol ?? 'token';
  const summary =
    verdict === 'BLOCKED'
      ? `${symbol} is BLOCKED: ${failReasons.join(' ')}`
      : verdict === 'CAUTION'
        ? `${symbol} is CAUTION: ${warnReasons.join(' ')}`
        : `${symbol} looks SAFE to transfer/approve based on current public data.`;
  const advice =
    verdict === 'BLOCKED'
      ? 'Do NOT send or approve this token. A transfer or approval now risks funds you cannot get back.'
      : verdict === 'CAUTION'
        ? 'You can probably sell, but there are yellow flags. If you proceed, send a small test amount first and approve only the exact amount — never an unlimited allowance.'
        : 'Looks transferable right now. Still, approve only the amount you need — never an unlimited allowance.';

  const topHolders = (gp?.holders || []).slice(0, 5).map((h) => ({
    address: h.address,
    pct: Math.round(((toNum(h.percent) ?? 0) * 100) * 10) / 10,
    is_contract: h.is_contract === 1,
    tag: h.tag || '',
  }));

  return {
    agent: 'transfer-guard',
    version: '0.1.0',
    chain,
    token: { address, symbol: market?.symbol ?? null, name: market?.name ?? null, decimals },
    verdict,
    summary,
    advice,
    amount_usd: amountUsd,
    market,
    checks,
    top_holders: topHolders,
    concentration,
    lp,
    verification: {
      method: 'off-chain public data (DEX Screener + GoPlus + Paraswap quote)',
      zk_proof: null,
      note: 'This verdict is computed from public APIs. A Groth16 proof of a verdict can be verified on zkVerify via POST /verify-proof (needs a Kurier API key — see README).',
    },
    sources: ['dexscreener', 'goplus', 'paraswap', 'base-rpc'],
    checked_at: new Date().toISOString(),
    latency_ms: Date.now() - started,
    disclaimer: 'Read-only advisory check from public data, not financial advice. Data can change between blocks.',
  };
}

export async function checkToken({ chain, token, amountUsd = null }) {
  const started = Date.now();
  const address = token.toLowerCase();
  const fetchNotes = [];
  let market = null;
  let gp = null;
  let pairs = [];

  // ---- Market data (DEX Screener) ----
  try {
    const dex = await fetchJson(`${DEX}/base/${address}`, { timeoutMs: 8000 });
    pairs = Array.isArray(dex) ? dex : [];
  } catch (err) {
    fetchNotes.push(check('market_fetch', 'Market data', 'unknown', `DEX Screener unreachable: ${err.message}`));
  }
  if (pairs.length > 0) {
    pairs.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0));
    const p = pairs[0];
    const ageHours = p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3_600_000 : null;
    market = {
      symbol: p.baseToken?.symbol ?? null,
      name: p.baseToken?.name ?? null,
      price_usd: toNum(p.priceUsd),
      liquidity_usd: toNum(p.liquidity?.usd),
      volume_h24_usd: toNum(p.volume?.h24),
      volume_h1_usd: toNum(p.volume?.h1),
      buys_h24: p.txns?.h24?.buys ?? null,
      sells_h24: p.txns?.h24?.sells ?? null,
      price_change_h1_pct: toNum(p.priceChange?.h1),
      price_change_h24_pct: toNum(p.priceChange?.h24),
      dex: p.dexId ?? null,
      pair_address: p.pairAddress ?? null,
      pair_addresses: pairs.map((x) => x.pairAddress).filter(Boolean),
      pair_age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      pair_url: p.url ?? null,
      fdv_usd: toNum(p.fdv),
      market_cap_usd: toNum(p.marketCap),
    };
  }

  // ---- Security data (GoPlus, one address per call on the free tier) ----
  try {
    const data = await fetchJson(`${GO_PLUS}/8453?contract_addresses=${address}`, { timeoutMs: 8000 });
    gp = data?.result?.[address] ?? null;
  } catch (err) {
    fetchNotes.push(check('security_fetch', 'Security data', 'unknown', `GoPlus unreachable: ${err.message}`));
  }

  if (!market && !gp) {
    return verdictFromEvidence({ chain, token, amountUsd, market: null, gp: null, decimals: null, sim: { status: 'unknown', detail: 'No data, sell simulation skipped.' }, started, fetchNotes });
  }

  const decimals = await getDecimals(address);
  const sim = await simulateSell(address, decimals, market?.price_usd);
  return verdictFromEvidence({ chain, token, amountUsd, market, gp, decimals, sim, started, fetchNotes });
}

export function isSupportedChain(chain) {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_CHAINS, chain);
}

export { isAddress };
