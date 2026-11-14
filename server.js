// server.js — Verify-First Agent HTTP server (Node.js stdlib only).
//
// READ-ONLY BY DESIGN. This server:
//   - NEVER signs anything
//   - NEVER sends a transaction
//   - NEVER holds a private key, seed phrase, session token, or API key
// It only performs eth_call reads against public BSC RPCs and returns a
// verdict (ALLOW / BLOCK) with the on-chain evidence behind it. Any
// execution is a separate, human-confirmed step outside this agent.
//
//   GET  /health  -> {"ok":true,"agent":"verify-first","mode":"read-only","never_signs":true}
//   POST /verify  -> JSON body {contract, wallet, checks[]}
//                   checks: [{type:"supply",maxSupply}, {type:"freeQuota",freeCap},
//                            {type:"balance",min?,expect?}, {type:"freeClaimed"},
//                            {type:"mintOpen"}, {type:"simulate"}]
//                   -> {verdict:"ALLOW"|"BLOCK", reasons:[], evidence:[], contract, wallet}

'use strict';

const http = require('node:http');
const { runChecks } = require('./checks/index');

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return reject(new Error('body too large'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true, agent: 'verify-first', mode: 'read-only', never_signs: true });
    }

    if (req.method === 'POST' && req.url === '/verify') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return sendJson(res, 400, { error: `invalid JSON body: ${e.message}` });
      }
      const { contract, wallet, checks } = body || {};
      if (typeof contract !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
        return sendJson(res, 400, { error: 'contract must be a 0x address' });
      }
      if (typeof wallet !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        return sendJson(res, 400, { error: 'wallet must be a 0x address' });
      }
      if (!Array.isArray(checks) || checks.length === 0) {
        return sendJson(res, 400, { error: 'checks must be a non-empty array' });
      }
      const out = await runChecks(contract, wallet, checks);
      return sendJson(res, 200, out);
    }

    return sendJson(res, 404, { error: 'not found — see GET /health and POST /verify' });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`verify-first agent listening on :${PORT} (read-only, never signs)`);
});
