// agent.js — Proof Gatekeeper endpoint for the zkVerify Agent Games.
//
// POST /agent implements the Agent Games protocol (see https://agentgames.zkverify.io/build
// and the working reference implementation https://github.com/andruu21/proof-gatekeeper-agent):
//
//   1. Every inbound request carries header `x-agent-games-signature`:
//      HMAC-SHA256 over the RAW request body, hex (or base64) encoded.
//      Verified BEFORE JSON parsing; mismatch (or missing secret) -> HTTP 401.
//   2. type "agent-games.preflight.v1" -> signed { ok: true, protocolVersion: "v1" }.
//      (This is the platform's health check. GET /agent also answers 200 as a health probe.)
//   3. type "agent-games.proof-gatekeeper.v1" -> deterministic APPROVE/REJECT
//      from the envelope fields (the six checks, boundaries included), signed.
//
// HMAC SECRET: read ONLY from env AGENT_GAMES_HMAC_SECRET. It is the
// platform-generated value from the dashboard (Rotate Secret). NEVER a local
// placeholder, NEVER hardcoded, NEVER logged. If it is unset, every signed
// request fails closed with 401 — the agent stays UNHEALTHY until the real
// secret is configured. That is the honest state, not a bug.
//
// PROOF GAP (known, documented): a full Gatekeeper answer also carries a
// Groth16 proof (snarkjs, official gatekeeper circuit) + public_signals +
// proof_tx submitted to zkVerify via Kurier. This module does NOT generate
// proofs yet — that is a separate build. Task responses therefore carry the
// decision + reason_code only (no proof fields). Per the event scoring,
// a missing proof costs -2 but the decision itself is still scored.
// NEVER claim a response is proof-backed when it is not.
//
// READ-ONLY BY DESIGN (same as the rest of this agent): this module never
// signs a transaction, never sends one, never holds a private key. The only
// signing here is the HMAC of HTTP response bodies, which is the platform's
// transport authentication, not a blockchain signature.

'use strict';

const crypto = require('node:crypto');

const PROTOCOL_VERSION = 'v1';

// In-memory idempotency cache: task_id -> cached signed response body.
// A redelivered task gets its original response back (not re-decided, and
// not misread as a reused proof). Volatile across restarts — documented.
const responseCache = new Map();
// In-memory seen-set of proof_tx values an APPROVE has consumed.
const seenProofTx = new Set();

function getSecret() {
  const s = process.env.AGENT_GAMES_HMAC_SECRET;
  return typeof s === 'string' && s.trim().length > 0 ? s.trim() : null;
}

function hmacHex(secret, rawBody) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

// Accept hex or base64 of the same MAC bytes, with an optional "sha256="
// prefix. Constant-time comparison. Returns false on any mismatch.
function verifySignature(secret, rawBody, headerValue) {
  if (!secret || typeof headerValue !== 'string') return false;
  let v = headerValue.trim();
  if (v.toLowerCase().startsWith('sha256=')) v = v.slice(7);
  let given;
  if (/^[0-9a-fA-F]{64}$/.test(v)) {
    given = Buffer.from(v, 'hex');
  } else {
    try {
      given = Buffer.from(v, 'base64');
    } catch (_) {
      return false;
    }
  }
  const expected = Buffer.from(hmacHex(secret, rawBody), 'hex');
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

function signBody(secret, rawBody) {
  return hmacHex(secret, rawBody);
}

// Deterministic Gatekeeper decision over the envelope input fields.
// APPROVE only if EVERY check passes; otherwise REJECT with the first
// failing check's reason_code (order mirrors the circuit: VK, reuse,
// threshold, expiry, recipient, amount).
function decide(input) {
  const {
    registered_vk, proof_vk, minimum, public_balance,
    expiry_block, current_block, recipient, condition_recipient,
    amount, max_transfer, proof_tx,
  } = input || {};

  const missing = [
    'registered_vk', 'proof_vk', 'minimum', 'public_balance',
    'expiry_block', 'current_block', 'recipient', 'condition_recipient',
    'amount', 'max_transfer', 'proof_tx',
  ].filter((k) => input == null || input[k] === undefined || input[k] === null || input[k] === '');
  if (missing.length > 0) {
    return { decision: 'REJECT', reason_code: 'INVALID_TASK', detail: `missing input fields: ${missing.join(', ')}` };
  }

  const vkOk = String(proof_vk).toLowerCase() === String(registered_vk).toLowerCase();
  if (!vkOk) return { decision: 'REJECT', reason_code: 'VK_SUBSTITUTION' };

  const reused = seenProofTx.has(String(proof_tx));
  if (reused) return { decision: 'REJECT', reason_code: 'PROOF_REUSED' };

  let thresholdOk, notExpired, recipientOk, amountOk;
  try {
    thresholdOk = BigInt(public_balance) >= BigInt(minimum);
    notExpired = Number(current_block) < Number(expiry_block);
    amountOk = BigInt(amount) <= BigInt(max_transfer);
  } catch (e) {
    return { decision: 'REJECT', reason_code: 'INVALID_TASK', detail: `numeric field parse failed: ${e.message}` };
  }
  recipientOk = String(recipient).toLowerCase() === String(condition_recipient).toLowerCase();

  if (!thresholdOk) return { decision: 'REJECT', reason_code: 'THRESHOLD_MISMATCH' };
  if (!notExpired) return { decision: 'REJECT', reason_code: 'EXPIRED_CONDITION' };
  if (!recipientOk) return { decision: 'REJECT', reason_code: 'RECIPIENT_MISMATCH' };
  if (!amountOk) return { decision: 'REJECT', reason_code: 'AMOUNT_OVERFLOW' };

  return { decision: 'APPROVE', reason_code: 'VALID_CONDITION' };
}

// Handle POST /agent. `rawBody` is the exact request bytes (Buffer).
// Returns { status, body (object), sign: bool } — the caller serializes and,
// when sign is true, attaches x-agent-games-signature over the raw bytes.
function handleAgentPost(rawBody, signatureHeader) {
  const secret = getSecret();
  if (!secret) {
    // No secret configured: cannot verify inbound HMAC or sign outbound.
    // Fail closed. This is the expected state until the platform-generated
    // secret from Rotate Secret is installed as AGENT_GAMES_HMAC_SECRET.
    return { status: 401, body: { error: 'agent has no HMAC secret configured' }, sign: false };
  }
  if (!verifySignature(secret, rawBody, signatureHeader)) {
    return { status: 401, body: { error: 'invalid HMAC signature' }, sign: false };
  }

  let env;
  try {
    env = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return { status: 200, body: { decision: 'REJECT', reason_code: 'INVALID_TASK', detail: `unparsable JSON: ${e.message}` }, sign: true };
  }

  if (env && env.type === 'agent-games.preflight.v1') {
    return { status: 200, body: { ok: true, protocolVersion: PROTOCOL_VERSION }, sign: true };
  }

  if (env && env.type === 'agent-games.proof-gatekeeper.v1') {
    const taskId = typeof env.task_id === 'string' ? env.task_id : '';
    if (taskId && responseCache.has(taskId)) {
      return { status: 200, body: responseCache.get(taskId), sign: true, cached: true };
    }
    // Deadline sanity: a task past its deadline fails closed.
    if (env.deadline_at) {
      const dl = Date.parse(env.deadline_at);
      if (!Number.isNaN(dl) && Date.now() > dl) {
        const out = { decision: 'REJECT', reason_code: 'INVALID_TASK' };
        if (taskId) responseCache.set(taskId, out);
        return { status: 200, body: out, sign: true };
      }
    }
    const out = decide(env.input);
    delete out.detail; // keep the wire shape to decision + reason_code (+ detail only for INVALID_TASK)
    const wire = { decision: out.decision, reason_code: out.reason_code };
    if (out.decision === 'APPROVE' && env.input && env.input.proof_tx) {
      seenProofTx.add(String(env.input.proof_tx));
    }
    if (taskId) responseCache.set(taskId, wire);
    return { status: 200, body: wire, sign: true };
  }

  return { status: 400, body: { error: `unknown envelope type: ${env && env.type ? env.type : 'none'}` }, sign: true };
}

module.exports = { handleAgentPost, verifySignature, decide, getSecret, PROTOCOL_VERSION };
