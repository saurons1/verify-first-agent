// demo.mjs — LIVE read-only demo against the real CrossEyed NFT contract.
//
// Reads, from BSC chain state (no server needed, no signing, no tx):
//   freeMinted()   — how many of the 777 free mints are used
//   totalSupply()  — how many of the 3,333 NFTs exist
//   balanceOf(sukm) — whether sukm already holds a CrossEyed NFT
// Then prints the evidence and a verdict. Run: node demo.mjs
//
// NOTE (verified live, not assumed): this contract does NOT expose a
// freeClaimed(address) view — eth_call with the correct selector
// (0x61c0b6a0, keccak of "freeClaimed(address)") reverts on all 4 public
// RPCs, as do 24 other candidate per-wallet tracker names. So the demo
// proves "already claimed" the way the chain actually allows: sukm's
// balanceOf is 1 (it owns CrossEyed #1042), so the 1-per-wallet free mint
// is already used. The freeClaimed probe is still shown below for honesty.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkFreeQuota, checkSupply, checkBalance, checkFreeClaimed } = require('./checks/index.js');

const CONTRACT = '0xEeAa7A553947bF0AFC9Cb3d14E4336F28FDebe75'; // CrossEyed NFT, BSC 56
const SUKM = '0x16B5012cD5Fe756BF1F39239B311b57FF1e723f0';
const FREE_CAP = 777;
const MAX_SUPPLY = 3333;

const free = await checkFreeQuota(CONTRACT, FREE_CAP);
const supply = await checkSupply(CONTRACT, MAX_SUPPLY);
const balance = await checkBalance(CONTRACT, SUKM, { min: 0, expect: 'zero' });
const claimedProbe = await checkFreeClaimed(CONTRACT, SUKM);

const checks = [free, supply, balance];
const block = balance.evidence.blockNumber !== 'unknown'
  ? balance.evidence.blockNumber
  : (free.evidence.blockNumber !== 'unknown' ? free.evidence.blockNumber : supply.evidence.blockNumber);

console.log('=== Verify-First Agent — live demo (read-only, BSC 56) ===');
console.log(`contract : ${CONTRACT} (CrossEyed NFT)`);
console.log(`wallet   : ${SUKM} (sukm)`);
console.log(`block    : ${block}`);
console.log('');
console.log('evidence:');
for (const c of checks) {
  console.log(`  ${c.evidence.check.padEnd(12)} ${c.evidence.call.padEnd(28)} -> ${c.evidence.result}  (${c.pass ? 'pass' : 'FAIL'})`);
}
console.log('');
console.log('reasons:');
for (const c of checks) console.log(`  - ${c.reason}`);
console.log('');
console.log(`note: freeClaimed(address) probe — ${claimedProbe.reason}`);
console.log('      (selector 0x61c0b6a0 verified correct; the function is simply not');
console.log('       exposed by this contract, so eligibility is proven via balanceOf.)');
console.log('');
const verdict = checks.every((c) => c.pass) ? 'ALLOW' : 'BLOCK';
console.log(`VERDICT: ${verdict}`);
if (verdict === 'BLOCK') {
  console.log('This wallet must NOT attempt the free mint — the chain state says it is not eligible.');
}
