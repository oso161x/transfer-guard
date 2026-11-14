# Transfer Guard — "Am I safe to send this token?"

> **zkVerify Agent Games — Wildcard track.** Built 2026-11-14 by OSO-161.
> Status: core agent DONE and tested (14/14). zkVerify demo implemented,
> pending a Kurier API key to run live (see below).

## The real-world problem

Every week, people lose money to the same simple mistake: they **send or
approve a token that cannot be sold back**. Honeypots, 99% sell taxes,
owner-controlled minting, unlocked liquidity pulled minutes later — the
contract tells the whole story *before* you click send, but reading a
contract is not something a normal user can do.

**Transfer Guard** answers one question, with evidence:

> *"Is it safe for me to send / approve this token?"*

Paste a contract address, get a verdict — **SAFE / CAUTION / BLOCKED** —
plus the exact reasons and the on-chain facts behind them. Read-only:
it never sends a transaction, never asks for a private key, seed phrase,
or wallet connection.

## How it works

One Node process (stdlib only, zero dependencies). One endpoint does the
work; the others are health + the zkVerify demo.

| Endpoint | What it does |
| -------- | ------------ |
| `GET /health` | Service status, version, chains, zkVerify config state |
| `POST /guard/check` | The verdict. Body: `{ "chain": "base", "token": "0x…", "amount_usd": 100 }` |
| `POST /verify-proof` | Verifies a Groth16 proof on zkVerify via Kurier (needs `KURIER_API_KEY`) |

### Evidence sources (all public, keyless, read-only)

- **DEX Screener** — price, liquidity, volume, buys/sells, pool age, DEX.
- **GoPlus Security** (`token_security`, chain 8453) — honeypot flag,
  buy/sell tax, mint/blacklist/pause/hidden-owner/selfdestruct, proxy,
  verified source, top holders, LP holders.
- **Paraswap prices API** — a live sell quote (token → WETH): the
  "can I actually sell this?" simulation. A failed quote is reported as
  `unknown`, never silently treated as safe.
- **Base public RPC** (`eth_call`) — token `decimals()`, needed to size
  the sell quote correctly.

### The checks

| Check | BLOCKED | CAUTION |
| ----- | ------- | ------- |
| Honeypot / sellability | `is_honeypot`, `cannot_sell_all`, `cannot_buy` | — |
| Buy/sell tax | tax > 20% | tax 5–20% (limit 5%) |
| Owner powers | — | mintable / blacklist / pausable / hidden owner / selfdestruct (unless owner is `0x0` renounced — then the functions are unreachable, e.g. OWB) |
| Upgradeable proxy | — | `is_proxy` (logic can change under you) |
| Verified source | — | source not verified |
| Holder concentration | one holder > 50% (EOA, or the token owner even via contract); top-10 EOAs > 70% | top-10 EOAs 40–70%; one non-owner contract > 50% |
| LP lock | — | LP lock unconfirmed / < 50% locked |
| Liquidity | < $5k (cannot exit) | < $30k |
| Recent sells | — | 0 sells in 24h while buys happened |
| Pool age | — | pool < 3h old |
| Price impact | — | your amount > 1% of pool liquidity |

Verdict: any `fail` → **BLOCKED**; any `warn` → **CAUTION**; otherwise
**SAFE**. If neither GoPlus nor DEX Screener returns usable data →
**UNKNOWN** (fail-closed: a token with no evidence is never SAFE).

Holder math (GoPlus `holders[].percent` is a *fraction* of supply):
`top10_raw` → minus DEX pair addresses + burn address → `top10_ex_pool`
→ minus contracts → `top10_eoa`. The verdict uses `top10_eoa`, because
protocol contracts (staking / vesting / voter) legitimately hold large
chunks of honest tokens. All three numbers are reported, and the top
holders are listed with `is_contract` flags — see "Known limitations".

## Example

```bash
curl -s -X POST http://localhost:3000/guard/check \
  -H 'Content-Type: application/json' \
  -d '{"chain":"base","token":"0xef5997c2cf2f6c138196f8a6203afc335206b3c1","amount_usd":100}'
```

```json
{
  "agent": "transfer-guard",
  "version": "0.1.0",
  "chain": "base",
  "token": { "address": "0xef59…", "symbol": "OWB", "name": "OWB", "decimals": 18 },
  "verdict": "SAFE",
  "summary": "OWB looks SAFE to transfer/approve based on current public data.",
  "advice": "Looks transferable right now. Still, approve only the amount you need — never an unlimited allowance.",
  "market": { "price_usd": 0.008164, "liquidity_usd": 57586.61, "volume_h24_usd": 14759.38,
              "buys_h24": 62, "sells_h24": 184, "dex": "aerodrome", "pair_age_hours": 9694 },
  "concentration": { "top10_raw_pct": 71.2, "top10_ex_pool_pct": 71.2, "top10_eoa_pct": 8.5, "holder_count": 79714 },
  "lp": { "locked_pct": 100, "largest_lp_holder_tag": "UNCX Locker" },
  "checks": [ { "id": "honeypot", "status": "pass", "detail": "Not flagged as a honeypot; holders can sell." },
              { "id": "tax", "status": "pass", "detail": "Buy tax 0%, sell tax 0% (limit 5%)." },
              { "id": "lp_lock", "status": "pass", "detail": "100.0% of LP is locked/burned (largest: UNCX Locker)." } ],
  "checked_at": "2026-11-14T08:47:00Z",
  "latency_ms": 2448
}
```

(Trimmed — full response includes every check, top holders, LP detail,
and a disclaimer. Note `top10_raw_pct` 71.2 vs `top10_eoa_pct` 8.5: OWB's
top-3 holders are its staking/vesting contracts. The verdict uses the
EOA number and reports both.)

## Test results (2026-11-14 ~15:47 WIB, `npm test` — 14/14 PASS)

| Case | Verdict | Why |
| ---- | ------- | --- |
| USDC (Base) | CAUTION | Upgradeable proxy (Circle admin). No honeypot, tax 0%. |
| WETH (Base) | SAFE | Immutable, no tax, no owner powers. |
| OWB | SAFE | Owner renounced, LP 100% locked (UNCX), top-10 EOAs 8.5%. |
| RSGP | BLOCKED | Token owner holds 72.7% of supply. |
| PROS | CAUTION | LP 97.4% unlocked; mintable with live owner. |
| KNTQ | CAUTION | Mintable with live owner; LP lock unconfirmed. |
| MEOR (brand-new token) | CAUTION | No sells yet, pool hours old, security data gaps. |
| FIXTURE honeypot | BLOCKED | `is_honeypot=1`, `cannot_sell_all=1` (recorded GoPlus shape). |
| FIXTURE high tax | BLOCKED | Sell tax 35% (recorded GoPlus shape). |
| `GET /health`, bad address → 400, bad chain → 400, `/verify-proof` without key → 501, server boot | PASS | Handler + server smoke tests. |

Full run: `test/RESULTS.md`. Live verdicts can drift as on-chain data
changes — the test re-checks live data on every run.

### Why USDC is CAUTION (and why that is correct)

USDC's contract is an upgradeable proxy controlled by Circle. That is
normal for a regulated stablecoin — and it is still a real trust
assumption: the logic *can* change. A guard that calls USDC "SAFE"
without mentioning it would be hiding the one thing that matters about
USDC's contract. The response says so in plain language.

## zkVerify integration

The verdict above is computed from public APIs. The zkVerify layer makes
a verdict **checkable without re-running the checks**: a Groth16 proof
(e.g. "this token passed all guard checks") is verified on zkVerify,
and anyone can confirm the verification on-chain from the `txHash`.

`POST /verify-proof` is implemented end-to-end (Kurier REST:
`register-vk` → `submit-proof` → poll `job-status` → `Finalized`,
testnet `https://api-testnet.kurier.xyz/api/v1`):

```bash
curl -s -X POST http://localhost:3000/verify-proof \
  -H 'Content-Type: application/json' \
  -d '{"proof": {...snarkjs Groth16 proof...},
       "publicSignals": ["..."],
       "vk": {...verification key object, or a registered vkHash string...}}'
```

Response on success: `{ "verified": true, "status": "Finalized",
"jobId": "…", "txHash": "0x…", "explorerUrl": "https://zkverify-testnet.subscan.io/extrinsic/0x…" }`.

### Open item 1 — Kurier API key (needed to run the demo live)

Kurier requires an API key. Request one from the Horizen Labs team
(docs: https://docs.zkverify.io/overview/getting-started/kurier —
"Kurier requires an API key. Request one first"; Swagger:
https://api-testnet.kurier.xyz/docs). Then:

```bash
KURIER_API_KEY=<your key> KURIER_ENV=testnet node server.mjs
```

Without the key the endpoint answers **501** with these exact
instructions — it never pretends to verify.

### Open item 2 — a real demo proof

Generate a Groth16 proof + verification key + public signals with
snarkjs/circom. Fastest path: zkRepl
(https://docs.zkverify.io/overview/getting-started/generating-proof) —
compile the example circuit, download `proof.json`, `public.json` and
`main.groth16.vkey.json`, then POST them to `/verify-proof`.
Until then the endpoint accepts caller-supplied artifacts and has no
bundled fixture (no fake proof is shipped — a made-up proof would fail
verification and prove nothing).

## Run locally

```bash
node server.mjs            # PORT=3000 by default (PORT=8080 to change)
curl http://localhost:3000/health
npm test                   # live tests (needs internet, no keys)
```

Requires Node ≥ 20. No dependencies, no build step, no database.
In-memory cache: 120s per upstream URL (keeps free rate limits happy).

## Deploy (Vercel, free — open item for the owner)

The repo ships Vercel-ready (`vercel.json` + `api/index.mjs`, same
handler as the local server). No account was created by the agent.

1. Push this repo to a **public** GitHub repository.
2. https://vercel.com → *Add New → Project* → import the repo.
3. Framework preset: **Other**. No build command, no output directory.
4. Environment variables (optional): `KURIER_API_KEY`, `KURIER_ENV=testnet`
   — only needed for `/verify-proof`; `/guard/check` works without them.
5. Deploy. You get `https://<project>.vercel.app` (public HTTPS, no
   custom port) — that URL goes in the Agent Games submit form.
6. Smoke-test it:
   ```bash
   curl https://<project>.vercel.app/health
   curl -s -X POST https://<project>.vercel.app/guard/check \
     -H 'Content-Type: application/json' \
     -d '{"chain":"base","token":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}'
   ```

## Known limitations (honest list)

- **A whale using a multisig/Safe looks like a contract.** The
  concentration verdict excludes contracts; a whale's Safe would be
  excluded too. Mitigation: the response lists top holders with
  `is_contract` flags, and a single non-owner contract holding > 50%
  still warns. Verify big contract holders on Basescan.
- **GoPlus omits fields for some tokens** (e.g. USDC has no
  mintable/blacklist fields). Omitted fields are `unknown`, never
  assumed safe.
- **New tokens may not be indexed yet** by GoPlus/DEX Screener. Such
  tokens come back CAUTION/UNKNOWN, never SAFE.
- **A clean verdict is a snapshot, not a guarantee.** Owners can add
  taxes, unlock LP, or mint after the check. Re-check right before
  you send.
- **Base only for now.** `chain` must be `"base"`; other chains return
  400. Adding a chain is one line (`SUPPORTED_CHAINS`) + a GoPlus
  chain id.
- **The verdict itself is not yet a ZK proof.** The Kurier client is
  implemented; running the live demo needs the API key + a generated
  proof (open items 1–2 above).

## Submit checklist (Agent Games Wildcard)

- [x] Agent built + tested locally (14/14, 2026-11-14)
- [ ] Competition account registered (in progress — X @oso161x sign-in)
- [ ] Public GitHub repo created + code pushed (owner/parent step)
- [ ] Deployed to Vercel, public HTTPS URL verified (steps above)
- [ ] Kurier API key requested + demo proof generated + `/verify-proof`
      verified live (open items 1–2)
- [ ] Submit from the Agent Games dashboard before the 21 Nov close
      (prize eligibility needs GitHub + wallet linked on the profile)

## Security notes

- Read-only by design: no transactions, no wallet, no private keys,
  no seed phrases — anywhere in the code or the repo.
- No secrets are committed. The only credential the service ever uses
  is `KURIER_API_KEY` from the environment.
- Upstream failures fail closed: a check that cannot be computed is
  `unknown`, and a token with no data at all is `UNKNOWN`, never SAFE.
