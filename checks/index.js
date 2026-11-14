// checks/index.js — READ-ONLY eligibility checks for the Verify-First Agent.
//
// Every check performs eth_call reads only. No check signs, sends a
// transaction, or holds a private key. Each check returns
//   { pass, reason, evidence }
// where evidence is { check, call, result, blockNumber } — the raw on-chain
// value that produced the verdict, so a human (or a future ZK proof) can
// re-derive the same verdict from the same chain state.
//
// A failed read is NOT treated as a pass: when a check cannot read the
// chain state it needs, it returns pass:false with an "unknown" reason,
// because an unverified claim must BLOCK, never ALLOW.

'use strict';

const { SELECTORS, padAddress, parseUint256, parseBool, ethCall, ethBlockNumber } = require('../lib/rpc');

async function withBlock(evidence) {
  evidence.blockNumber = await ethBlockNumber();
  return evidence;
}

// totalSupply() must be < maxSupply (supply not exhausted).
async function checkSupply(contract, maxSupply) {
  const evidence = { check: 'supply', call: 'totalSupply()', result: null, blockNumber: 'unknown' };
  try {
    const { result } = await ethCall(contract, SELECTORS.totalSupply);
    const supply = parseUint256(result);
    evidence.result = supply.toString(10);
    const pass = supply < BigInt(maxSupply);
    await withBlock(evidence);
    return {
      pass,
      reason: pass
        ? `totalSupply ${supply} < maxSupply ${maxSupply}`
        : `totalSupply ${supply} >= maxSupply ${maxSupply} — supply exhausted`,
      evidence,
    };
  } catch (e) {
    await withBlock(evidence);
    return { pass: false, reason: `totalSupply() read failed — unknown, BLOCK: ${e.message}`, evidence };
  }
}

// freeMinted() must be < freeCap (free quota not exhausted).
async function checkFreeQuota(contract, freeCap) {
  const evidence = { check: 'freeQuota', call: 'freeMinted()', result: null, blockNumber: 'unknown' };
  try {
    const { result } = await ethCall(contract, SELECTORS.freeMinted);
    const minted = parseUint256(result);
    evidence.result = minted.toString(10);
    const pass = minted < BigInt(freeCap);
    await withBlock(evidence);
    return {
      pass,
      reason: pass
        ? `freeMinted ${minted} < freeCap ${freeCap}`
        : `freeMinted ${minted} >= freeCap ${freeCap} — free quota exhausted`,
      evidence,
    };
  } catch (e) {
    await withBlock(evidence);
    return { pass: false, reason: `freeMinted() read failed — unknown, BLOCK: ${e.message}`, evidence };
  }
}

// balanceOf(wallet) vs min (default 0). Used to detect "already owns /
// already claimed": e.g. for a 1-per-wallet free mint, balance >= 1 means
// this wallet already holds one. `expect` selects the direction:
//   expect: 'zero' (default) — pass when balance == min (wallet owns none yet)
//   expect: 'atLeast'        — pass when balance >= min
async function checkBalance(contract, wallet, opts = {}) {
  const min = opts.min !== undefined ? opts.min : 0;
  const expect = opts.expect || 'zero';
  const evidence = { check: 'balance', call: `balanceOf(${wallet})`, result: null, blockNumber: 'unknown' };
  try {
    const data = SELECTORS.balanceOf + padAddress(wallet);
    const { result } = await ethCall(contract, data);
    const balance = parseUint256(result);
    evidence.result = balance.toString(10);
    let pass;
    let reason;
    if (expect === 'atLeast') {
      pass = balance >= BigInt(min);
      reason = pass
        ? `balanceOf ${balance} >= min ${min}`
        : `balanceOf ${balance} < min ${min}`;
    } else {
      pass = balance === BigInt(min);
      reason = pass
        ? `balanceOf ${balance} == ${min} — wallet holds none yet`
        : `balanceOf ${balance} != ${min} — wallet already owns ${balance}`;
    }
    await withBlock(evidence);
    return { pass, reason, evidence };
  } catch (e) {
    await withBlock(evidence);
    return { pass: false, reason: `balanceOf() read failed — unknown, BLOCK: ${e.message}`, evidence };
  }
}

// freeClaimed(wallet) must be false for a free mint to be allowed.
async function checkFreeClaimed(contract, wallet) {
  const evidence = { check: 'freeClaimed', call: `freeClaimed(${wallet})`, result: null, blockNumber: 'unknown' };
  try {
    const data = SELECTORS.freeClaimed + padAddress(wallet);
    const { result } = await ethCall(contract, data);
    const claimed = parseBool(result);
    evidence.result = String(claimed);
    const pass = claimed === false;
    await withBlock(evidence);
    return {
      pass,
      reason: pass
        ? `freeClaimed(${wallet}) is false — free quota for this wallet unused`
        : `freeClaimed(${wallet}) is true — free quota for this wallet already used`,
      evidence,
    };
  } catch (e) {
    await withBlock(evidence);
    return { pass: false, reason: `freeClaimed() read failed — unknown, BLOCK: ${e.message}`, evidence };
  }
}

// mintOpen() must be true. If the function does not exist on the contract
// (call reverts / no code at that selector), the state is UNKNOWN and the
// check BLOCKS — an unverifiable "open" is never treated as open.
async function checkMintOpen(contract) {
  const evidence = { check: 'mintOpen', call: 'mintOpen()', result: null, blockNumber: 'unknown' };
  try {
    const { result } = await ethCall(contract, SELECTORS.mintOpen);
    const open = parseBool(result);
    evidence.result = String(open);
    const pass = open === true;
    await withBlock(evidence);
    return {
      pass,
      reason: pass ? 'mintOpen() is true' : 'mintOpen() is false — mint is closed',
      evidence,
    };
  } catch (e) {
    await withBlock(evidence);
    return { pass: false, reason: `mintOpen() read failed — unknown, BLOCK: ${e.message}`, evidence };
  }
}

// STUB — simulateBeforeBroadcast() NEVER broadcasts.
//
// This function exists to make the boundary explicit: the agent can build
// and show a preview of what an execution WOULD do, but it cannot and will
// not send it. Execution is always a separate, human-confirmed step
// performed outside this agent (e.g. the human reviews the preview and
// signs in their own wallet). wouldSend is always false.
function simulateBeforeBroadcast() {
  return {
    wouldSend: false,
    preview: 'human must review and confirm before any execution',
    note: 'This agent is read-only. It never signs, never sends a transaction, and never holds a private key. Any execution happens only after a human reviews this preview and confirms it in a separate, human-controlled step.',
  };
}

// Dispatcher for POST /verify: runs each requested check and folds the
// results into one verdict. ALLOW only if EVERY check passes.
async function runChecks(contract, wallet, checks) {
  const results = [];
  for (const c of checks || []) {
    switch (c.type) {
      case 'supply':
        results.push(await checkSupply(contract, c.maxSupply));
        break;
      case 'freeQuota':
        results.push(await checkFreeQuota(contract, c.freeCap));
        break;
      case 'balance':
        results.push(await checkBalance(contract, wallet, { min: c.min, expect: c.expect }));
        break;
      case 'freeClaimed':
        results.push(await checkFreeClaimed(contract, wallet));
        break;
      case 'mintOpen':
        results.push(await checkMintOpen(contract));
        break;
      case 'simulate':
        results.push({
          pass: true,
          reason: 'simulation preview only — nothing was sent',
          evidence: { check: 'simulate', call: 'simulateBeforeBroadcast()', result: JSON.stringify(simulateBeforeBroadcast()), blockNumber: 'n/a' },
        });
        break;
      default:
        results.push({ pass: false, reason: `unknown check type: ${c.type}`, evidence: { check: String(c.type), call: '', result: null, blockNumber: 'unknown' } });
    }
  }
  const reasons = results.map((r) => r.reason);
  const evidence = results.map((r) => r.evidence);
  return {
    verdict: results.length > 0 && results.every((r) => r.pass) ? 'ALLOW' : 'BLOCK',
    reasons,
    evidence,
    contract,
    wallet,
  };
}

module.exports = {
  checkSupply,
  checkFreeQuota,
  checkBalance,
  checkFreeClaimed,
  checkMintOpen,
  simulateBeforeBroadcast,
  runChecks,
};
