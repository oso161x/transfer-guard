# Transfer Guard — test results

Run: 2026-11-14T09:29:14.905Z (WIB 14/11/2026, 16:29:14)
Result: ALL PASS (14/14)

| Case | Token | Verdict | Result |
| ---- | ----- | ------- | ------ |
| USDC (healthy stablecoin, upgradeable proxy) | `0x833589fCD6eD…` | CAUTION | PASS |
| WETH (immutable wrapped ETH) | `0x420000000000…` | SAFE | PASS |
| OWB (renounced, LP locked via UNCX) | `0xef5997c2cf2f…` | SAFE | PASS |
| RSGP (owner holds 72.7% of supply) | `0x44B63aF715D5…` | BLOCKED | PASS |
| PROS (LP 97% unlocked) | `0x8B7DdE054BE9…` | CAUTION | PASS |
| KNTQ (mintable, live owner) | `0xb80194e38685…` | CAUTION | PASS |
| MEOR (brand-new, unindexed token) | `0x06ad8110be9a…` | CAUTION | PASS |
| FIXTURE honeypot (is_honeypot=1, cannot_sell_all=1) | `0x111111111111…` | BLOCKED | PASS |
| FIXTURE high tax (sell tax 35%) | `0x222222222222…` | BLOCKED | PASS |
| GET /health | `-…` | HTTP 200 | PASS |
| POST /guard/check bad address -> 400 | `-…` | HTTP 400 | PASS |
| POST /guard/check bad chain -> 400 | `-…` | HTTP 400 | PASS |
| POST /verify-proof without key -> 501 + instructions | `-…` | HTTP 501 | PASS |
| server.mjs boots + GET /health | `-…` | HTTP 200 | PASS |

## Notes

- Live cases use real DEX Screener + GoPlus + Paraswap + Base RPC data at run time; verdicts can drift as on-chain data changes.
- USDC is CAUTION (not SAFE) because it is an upgradeable proxy — see README "Why USDC is CAUTION".
- FIXTURE cases use recorded GoPlus-shaped data (see test/fixtures/*.json); no live is_honeypot=1 token was indexed on Base at build time.
- /verify-proof is 501 without KURIER_API_KEY by design (see README "zkVerify integration").
