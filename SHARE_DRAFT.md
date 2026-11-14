# SHARE DRAFT — Transfer Guard (zkVerify Agent Games, Wildcard)

> DRAFT ONLY. Do NOT post until the agent is deployed on a public HTTPS
> URL and the demo link is verified live. Replace `<PUBLIC_URL>` with
> the real Vercel URL before posting.

---

## Thread (Bahasa Indonesia) — 6 cuitan

**1/**
Pernah takut kirim token ke alamat yang salah? Lebih parah: tokennya
sendiri yang salah. Honeypot, pajak jual 99%, owner pegang 72% supply —
kontraknya cerita semua SEBELUM kamu klik kirim.

Kenalan: Transfer Guard — agent penjaga transfer token. 🧵

**2/**
Cara pakainya gampang: kirim alamat kontrak token ke agent, dia jawab
dalam hitungan detik:

✅ SAFE — layak dikirim
⚠️ CAUTION — ada risiko, baca alasannya
🚫 BLOCKED — jangan sentuh

Semua verdict disertai bukti, bukan cuma "percaya saya".

**3/**
Yang dicek (semua dari data on-chain publik, real-time):

🔍 Honeypot — apakah token bisa dijual balik?
💸 Pajak beli/jual — sampai simulasi jual via Paraswap
🔒 LP lock — likuiditas dikunci atau bisa ditarik owner?
🐋 Top-10 holder — berapa % supply di tangan segelintir dompet?
📜 Kontrak terverifikasi, proxy, mintable, blacklist, pausable

**4/**
Contoh nyata, chain Base:

• USDC → CAUTION (proxy upgradeable, wajar tapi perlu tahu)
• WETH → SAFE
• OWB → SAFE (owner renounced, LP 100% terkunci)
• RSGP → BLOCKED (owner pegang 72,7% supply!)

Coba sendiri: <PUBLIC_URL>

**5/**
Bonus: verdict-nya bisa dibuktikan secara kriptografis. Transfer Guard
terintegrasi dengan @zkVerify via Kurier — proof Groth16 diverifikasi
on-chain, jadi siapa pun bisa cek "verdict ini benar" tanpa
mengulang semua ceknya.

**6/**
Dibangun untuk zkVerify Agent Games — Wildcard track.
Read-only: tidak pernah kirim transaksi, tidak minta private key,
tidak connect wallet.

Demo: <PUBLIC_URL>
Kode: <GITHUB_URL>

#zkVerify #AgentGames #Base #Web3 #CryptoSafety

---

## Thread (English, short) — 4 tweets

**1/**
Before you send a token, ask: can it be sold back?
Honeypots, 99% sell tax, owners holding 72% of supply — the contract
tells you BEFORE you click send.

Meet Transfer Guard — an agent that answers "is this token safe to send?" with on-chain evidence. 🧵

**2/**
Send it a contract address, get a verdict in seconds:
✅ SAFE / ⚠️ CAUTION / 🚫 BLOCKED — each with the exact reasons and
the data behind them. Honeypot check, live sell simulation, buy/sell
tax, LP lock, top-10 holders, verified source, proxy & owner powers.

**3/**
Real examples on Base:
USDC → CAUTION (upgradeable proxy — normal, but you should know)
WETH → SAFE · OWB → SAFE (renounced, LP 100% locked)
RSGP → BLOCKED (owner holds 72.7% of supply)

Try it: <PUBLIC_URL>

**4/**
Bonus: verdicts are provable. Transfer Guard integrates @zkVerify
via Kurier — a Groth16 proof is verified on-chain, so anyone can
check "this verdict is correct" without re-running the checks.

Built for zkVerify Agent Games — Wildcard track.
Read-only. No transactions, no keys, no wallet connect.
Demo: <PUBLIC_URL> · Code: <GITHUB_URL>

#zkVerify #AgentGames #Base #CryptoSafety
