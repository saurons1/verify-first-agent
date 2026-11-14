# Verify-First Agent

A tiny, read-only verification agent for free-mint hunting on BNB Smart Chain,
built for the **Agent Games by zkVerify — Wildcard track**.

**It never signs. It never sends a transaction. It never holds a private key.**
It only reads chain state and tells a human, with evidence, whether a free
mint is actually eligible — before anything is executed.

## The problem

Agents that hunt free mints usually sign first and check later. That is how
people lose money:

- **Trap approvals** — a site asks for an approval that drains more than the mint costs.
- **Fake "free" mints** — the free pool is already exhausted, but the UI still says "free"; the transaction goes through as a paid mint, or burns gas on a revert.
- **Direct-to-pool token losses** — tokens sent straight to a pool/pair/router address instead of through an atomic router swap are absorbed by the pool and unrecoverable. (This happened to us: a split transfer-then-swap lost 2.1825 U.)

The fix is ordering: **verify → preview → human confirms → execute**.
This agent does the first two steps, and refuses to do the last two.

## Who it helps

- Free-mint hunters on BSC who want an on-chain eligibility check before any wallet interaction.
- Anyone building agents that touch user funds: the verifier is a gate that can say BLOCK with evidence, so the executing agent never has to trust site UI text.
- Future ZK-proof consumers: the verdict is a deterministic function of chain state at a block, which is exactly the kind of statement a proof system can make checkable (see the zkVerify section).

## How it works

1. **Verify** — `POST /verify` runs read-only `eth_call`s against public BSC RPCs (with fallback across endpoints, since dataseed sometimes 403/429s) and checks:
   - `supply` — `totalSupply()` < max supply
   - `freeQuota` — `freeMinted()` < free cap
   - `balance` — `balanceOf(wallet)` (e.g. already owns one?)
   - `freeClaimed` — `freeClaimed(wallet)` must be false
   - `mintOpen` — `mintOpen()` must be true; if the call fails, the state is **unknown → BLOCK** (an unverifiable "open" is never treated as open)
   - `simulate` — preview stub: always returns `wouldSend: false`
2. **Preview** — the response carries `reasons[]` and `evidence[]` (`{check, call, result, blockNumber}`) so a human can re-derive the verdict from the same chain state.
3. **Human confirms** — execution is a separate, human-controlled step, outside this agent.
4. **Execute (elsewhere)** — if the human proceeds, swaps must be **atomic through the DEX router only** — never send tokens directly to a pool address.

Verdict is `ALLOW` only if **every** check passes; any failure or any unreadable state is `BLOCK`.

## What it can / cannot do

Can:
- Read `totalSupply`, `freeMinted`, `balanceOf`, `freeClaimed`, `mintOpen` from any BSC contract, with RPC fallback.
- Return a deterministic ALLOW/BLOCK verdict with evidence and block number.
- Run a live demo against a real contract (`node demo.mjs`).

Cannot (by design, not by omission):
- Sign anything, send any transaction, or hold any private key, seed phrase, session token, or API key. There is no wallet code in this repo.
- Execute a mint, swap, approval, or listing. `simulateBeforeBroadcast()` always returns `wouldSend: false`.
- Override a human: a BLOCK verdict is final for this agent; only a human, after reviewing the evidence, may decide otherwise in a separate step.

## How to run

Requires Node.js 18+. No dependencies, no install step, no API keys.

```bash
node server.js          # listens on :3000 (or $PORT)
```

Health check:

```bash
curl http://localhost:3000/health
# {"ok":true,"agent":"verify-first","mode":"read-only","never_signs":true}
```

Verify a free mint (example: CrossEyed NFT, wallet sukm):

```bash
curl -X POST http://localhost:3000/verify \
  -H 'Content-Type: application/json' \
  -d '{
    "contract": "0xEeAa7A553947bF0AFC9Cb3d14E4336F28FDebe75",
    "wallet": "0x16B5012cD5Fe756BF1F39239B311b57FF1e723f0",
    "checks": [
      {"type": "supply", "maxSupply": 3333},
      {"type": "freeQuota", "freeCap": 777},
      {"type": "balance", "min": 0, "expect": "zero"},
      {"type": "mintOpen"},
      {"type": "simulate"}
    ]
  }'
```

Live demo (no server needed — reads the real CrossEyed contract on BSC):

```bash
node demo.mjs
```

Expected outcome (verified live, 2026-11-15): `freeMinted` 743 of 777, `totalSupply` 819 of 3,333, and `balanceOf(sukm)` is 1 — sukm already owns CrossEyed #1042, so the 1-per-wallet free mint is already used and the verdict is **BLOCK**. Note: this contract does **not** expose a `freeClaimed(address)` view — `eth_call` with the correct selector (`0x61c0b6a0`) reverts on all 4 public RPCs, as do 24 other candidate tracker names, so the demo proves "already claimed" via `balanceOf` instead of fabricating a `freeClaimed` result. The `freeClaimed` check itself stays in the module for contracts that do expose it; on this contract it correctly reports unknown → BLOCK.

## zkVerify — honest status

**zkVerify is OPTIONAL for this track and is NOT yet integrated into this repo.**
No proof is generated here, no zkVerify endpoint is called, and nothing in this repo claims otherwise.

What is true, and checkable: the eligibility verdict is a deterministic function of on-chain state at a specific block ("`freeClaimed(sukm)` was `true` at block N, `freeMinted` was X of 777 at block N"). That is the kind of statement a ZK proof via zkVerify could make checkable by a third party without trusting this agent's word — a proof that this verdict was computed from that chain state.

This repo ships the deterministic verifier logic such a proof would cover: the same checks, the same selectors, the same evidence (`{check, call, result, blockNumber}`) that a prover would commit to. Wiring a Groth16 proof of that computation through zkVerify is **future work**, not a shipped feature.

## Repo layout

```
server.js          HTTP server: GET /health, POST /verify
checks/index.js    the checks: supply, freeQuota, balance, freeClaimed, mintOpen, simulate stub
lib/rpc.js         read-only eth_call / eth_blockNumber helpers + RPC fallback
demo.mjs           live read-only demo against the CrossEyed NFT contract
```

## Security notes

- No private key, seed phrase, session token, signature, API key, or bearer token appears anywhere in this repo. Only public wallet addresses are used.
- Selectors are the keccak selectors of the canonical function signatures (`freeMinted()` `0xd10a1a2b`, `totalSupply()` `0x18160ddd`, `balanceOf(address)` `0x70a08231`, `freeClaimed(address)` `0x61c0b6a0`, `mintOpen()` `0x24bbd049`). Address arguments are 32-byte left-padded in calldata; `eth_call` results are parsed as 32-byte uints with `BigInt`.
- A block number is reported as `"unknown"` when `eth_blockNumber` cannot be read — it is never faked.
