# Groth16 demo proof — verified live on zkVerify (Volta testnet)

A real Groth16 proof (snarkjs, bn128) for a small multiplier circuit,
verified end-to-end through this repo's own `POST /verify-proof` endpoint
via Kurier (testnet). Nothing here is mocked.

## The circuit

`multiplier.circom` (circom 2.2.3):

```circom
template Multiplier() {
    signal input a;
    signal input b;
    signal output c;
    c <== a * b;
}
component main = Multiplier();
```

`input.json`: `{"a": "3", "b": "11"}` — both inputs stay private; the only
public signal is the output `c = 33` (`public.json` is `["33"]`).

Trusted setup: Powers of Tau bn128 2^12, one contribution, then
`groth16 setup` + one zkey contribution (snarkjs 0.7.6).
Local check before submitting: `snarkjs groth16 verify verification_key.json
public.json proof.json` → **OK!**

## Live verification (2026-11-14)

Server booted from this repo with `KURIER_API_KEY` from `.env` (testnet key),
then:

```
POST /verify-proof { proof, publicSignals: ["33"], vk }
→ HTTP 200
{
  "verified": true,
  "status": "Finalized",
  "jobId": "d27e9a99-e00f-11f1-bb46-22f5290c9c2d",
  "txHash": "0xfdcea2fd6bfcfa108d02e00dd81ff63ae3d70fe95e20de73111c90c8c9dbda0a",
  "explorerUrl": "https://zkverify-testnet.subscan.io/extrinsic/0xfdcea2fd6bfcfa108d02e00dd81ff63ae3d70fe95e20de73111c90c8c9dbda0a"
}
```

Total round-trip ~128 s (register-vk ~20 s, then poll to Finalized).

An earlier identical submission also finalized:
job `d7cea940-e00e-11f1-bb46-22f5290c9c2d`, tx
`0xf0588514ae7778ee04573b9ab23a2a58a5fbec9c30c36a7284265b744d2d64de`
(https://zkverify-testnet.subscan.io/extrinsic/0xf0588514ae7778ee04573b9ab23a2a58a5fbec9c30c36a7284265b744d2d64de),
block `0x543fd079ea476dcdb5190941044595af5c23022fe25cf4c3e0251a7b76dc7722`.
That first job outlived the handler's old 180 s poll window (it finalized
~6.5 min after submission), which is why the poll window was raised — see below.

## Reproduce

```bash
# 1. Build the proof (needs circom 2.x + snarkjs 0.7.x)
circom multiplier.circom --r1cs --wasm --sym
snarkjs powersoftau new bn128 12 pot12_0000.ptau
snarkjs powersoftau contribute pot12_0000.ptau pot12_0001.ptau --name="demo"
snarkjs powersoftau prepare phase2 pot12_0001.ptau pot12_final.ptau
snarkjs groth16 setup multiplier.r1cs pot12_final.ptau multiplier_0000.zkey
snarkjs zkey contribute multiplier_0000.zkey multiplier_0001.zkey --name="demo"
snarkjs zkey export verificationkey multiplier_0001.zkey verification_key.json
snarkjs groth16 fullProve input.json multiplier_js/multiplier.wasm \
  multiplier_0001.zkey proof.json public.json
snarkjs groth16 verify verification_key.json public.json proof.json  # → OK!

# 2. Verify on zkVerify via this repo (needs KURIER_API_KEY in .env)
PORT=3101 node server.mjs
curl -X POST http://127.0.0.1:3101/verify-proof -H 'Content-Type: application/json' \
  -d "{\"proof\": $(cat proof.json), \"publicSignals\": $(cat public.json), \"vk\": $(cat verification_key.json)}"
```

## Bugs found and fixed in `lib/zkverify.mjs` while doing this demo

1. **Missing `vkRegistered` flag** — Kurier's `/submit-proof` requires a
   top-level boolean `vkRegistered` (per its OpenAPI spec,
   `https://api-testnet.kurier.xyz/docs/json`); without it the API returns
   HTTP 400 `body must have required property 'vkRegistered'`. Fixed by
   sending `vkRegistered: true` after `register-vk` succeeds.
2. **Timeouts too tight for testnet** — `register-vk` took ~20–30 s and
   finalization took ~6.5 min. Raised `register-vk`/`submit-proof` timeouts
   30 s → 120 s and the `Finalized` poll window 180 s → 600 s.

## Files in this folder

- `proof.json` — the snarkjs Groth16 proof (`pi_a`, `pi_b`, `pi_c`, groth16/bn128)
- `verification_key.json` — verification key for the multiplier circuit
- `multiplier.circom` — circuit source
- `input.json` — private inputs (`a=3`, `b=11`)
- `VERIFY_DEMO.md` — this file
