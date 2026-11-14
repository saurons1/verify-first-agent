// lib/rpc.js — READ-ONLY JSON-RPC helpers for BNB Smart Chain (chain id 56).
//
// This module ONLY performs eth_call / eth_blockNumber reads against public
// RPC endpoints. It NEVER signs, NEVER sends a transaction, NEVER holds a
// private key, and NEVER constructs a signed payload. There is no wallet
// code anywhere in this repo by design.
//
// RPC fallback order: the Binance dataseed endpoints sometimes answer
// 403/429 under load, so a failed endpoint is skipped and the next one is
// tried. First success wins; if every endpoint fails, the caller gets an
// error (never a fabricated result).

'use strict';

const https = require('node:https');
const { URL } = require('node:url');

const RPCS = [
  'https://bsc-dataseed1.binance.org',
  'https://bsc-dataseed.binance.org',
  'https://bsc-dataseed1.defibit.io',
  'https://rpc-bsc.48.club',
];

// Function selectors (keccak of the canonical signature — verified, not guessed).
const SELECTORS = {
  freeMinted: '0xd10a1a2b', // freeMinted() -> uint256
  totalSupply: '0x18160ddd', // totalSupply() -> uint256
  balanceOf: '0x70a08231', // balanceOf(address) -> uint256
  freeClaimed: '0x61c0b6a0', // freeClaimed(address) -> bool
  mintOpen: '0x24bbd049', // mintOpen() -> bool
};

function padAddress(address) {
  const a = String(address).toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(a)) throw new Error(`invalid address: ${address}`);
  return '0'.repeat(24) + a; // 32-byte left-padded (64 hex chars)
}

function parseUint256(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`expected 32-byte hex uint, got: ${String(hex)}`);
  }
  return BigInt(hex);
}

function parseBool(hex) {
  return parseUint256(hex) !== 0n;
}

function rpcPost(endpoint, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint);
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname || '/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} from ${endpoint}`));
          }
          let json;
          try { json = JSON.parse(data); } catch (e) {
            return reject(new Error(`bad JSON from ${endpoint}: ${e.message}`));
          }
          if (json.error) return reject(new Error(`RPC error from ${endpoint}: ${JSON.stringify(json.error)}`));
          resolve(json.result);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${endpoint}`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Try each RPC in order; first success wins. Throws only if ALL fail.
async function callRpc(method, params) {
  const errors = [];
  for (let i = 0; i < RPCS.length; i++) {
    try {
      const result = await rpcPost(RPCS[i], { jsonrpc: '2.0', id: i + 1, method, params });
      return { result, rpc: RPCS[i] };
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(`all ${RPCS.length} RPCs failed: ${errors.join(' | ')}`);
}

// eth_call against a contract. Returns the raw 32-byte hex result.
async function ethCall(contract, data) {
  const { result, rpc } = await callRpc('eth_call', [{ to: contract, data }, 'latest']);
  return { result, rpc };
}

// Current block number as a decimal string, or "unknown" if it cannot be read.
// A block number is NEVER faked: "unknown" is the honest fallback.
async function ethBlockNumber() {
  try {
    const { result } = await callRpc('eth_blockNumber', []);
    return parseUint256(result).toString(10);
  } catch (_) {
    return 'unknown';
  }
}

module.exports = { RPCS, SELECTORS, padAddress, parseUint256, parseBool, ethCall, ethBlockNumber };
