# Wildcard submission — form-ready texts (draft, NOT submitted)

Prepared 2026-11-15 ~00:13 WIB. Use these verbatim in the Agent Games dashboard form when the user approves the Wildcard submission. Nothing here has been submitted anywhere.

## Agent name
Verify-First Agent

## Agent link (public repository / demo / write-up)
- Repo: (PENDING — push ~/workspace/agent-games/wildcard/ to a public GitHub repo first; paste the URL here)
- Demo: (PENDING — public HTTPS demo/endpoint; see STATUS.md hosting notes)
- Write-up: the repo README.md explains the agent end to end.

## Public endpoint
(PENDING — the form asks for a public HTTPS endpoint for the agent, effectively mandatory per the site guide: "Keep it live for the whole event". Options: free-host deploy of wildcard/server.js, or a public demo page running the same checks client-side. VM is IPv6-only with no tunnel tool, so it cannot host this directly.)

## Use case
AI agents that move money on-chain keep signing things they never verified: fake "free mint" pages, wrong recipients, reused proofs, approvals that drain wallets. This agent sits between the idea and the signature. Before anything is signed, it reads the contract state itself — eligibility, free quota, total supply, wallet balance — over public BSC RPCs and returns a structured ALLOW/BLOCK verdict with the evidence for every check. It helps anyone running an agent with real funds: the agent can propose, but only a human-confirmed, on-chain-verified preview ever gets signed.

## Build context
Node.js, standard library only, no API keys, no private keys anywhere in the code. One HTTP server: GET /health and POST /verify. The verify path runs read-only eth_call checks (supply, free quota, balance, freeClaimed where the contract exposes it, mintOpen) against four public BSC RPCs with fallback, and a simulateBeforeBroadcast() step that only ever produces a preview — the agent never signs, never sends a transaction, never holds a key. Verified live against the CrossEyed NFT contract: freeMinted 743/777, totalSupply 819/3333, balanceOf(sukm) = 1, verdict BLOCK (wallet already owns #1042). One honest finding is documented in the repo: freeClaimed() is not exposed on that contract, so eligibility there is proven via balanceOf instead. Key decisions: read-only by design, deterministic checks over model guesses, human confirmation for every signature.

## zkVerify (optional)
Not yet integrated — stated honestly in the repo. The checkable claim is precise: "this eligibility verdict was computed from chain state at block N using these exact checks." That claim is exactly what a zkVerify proof would cover: the deterministic verifier logic in checks/index.js is the statement a proof would attest to. Integration is future work; the repo ships the verifier logic the proof would cover.
