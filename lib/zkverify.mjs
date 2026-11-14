// Bismillahirrahmanirrahim.
// zkverify.mjs — Kurier REST client (zkVerify, Horizen Labs).
// Docs: https://docs.zkverify.io/overview/getting-started/kurier
// Swagger: https://api-testnet.kurier.xyz/docs (testnet)
//          https://api.kurier.xyz/docs (mainnet)
//
// Flow (verify-only, no aggregation): register-vk -> submit-proof ->
// poll job-status until Finalized. Statuses:
//   Queued -> Valid -> Submitted -> IncludedInBlock -> Finalized (or Failed)
// The API key is required and must come from the environment
// (KURIER_API_KEY); it is NEVER committed and NEVER logged.
// Without a key this module refuses to call anything and the handler
// answers 501 with exact instructions to obtain one.

import { postJson, fetchJson } from './sources.mjs';

const TESTNET = 'https://api-testnet.kurier.xyz/api/v1';
const MAINNET = 'https://api.kurier.xyz/api/v1';

export const EXPLORER_TESTNET = 'https://zkverify-testnet.subscan.io/extrinsic/';

export function kurierConfig() {
  const key = process.env.KURIER_API_KEY || '';
  const env = (process.env.KURIER_ENV || 'testnet').toLowerCase();
  const baseUrl = env === 'mainnet' ? MAINNET : TESTNET;
  return { key, baseUrl, env };
}

export function kurierReady() {
  return Boolean(process.env.KURIER_API_KEY);
}

/**
 * Verify a Groth16 proof (snarkjs, bn128) on zkVerify via Kurier.
 * @param {object} input { proof, publicSignals, vk }
 *   - proof: snarkjs proof object (pi_a, pi_b, pi_c, protocol, curve)
 *   - publicSignals: array of public inputs (strings)
 *   - vk: either a full verification-key object (registered first) or a
 *     previously registered vkHash string (0x...).
 * @param {object} opts { pollMs, maxWaitMs }
 * @returns {object} { jobId, status, txHash, explorerUrl, statement, ... }
 */
export async function verifyGroth16({ proof, publicSignals, vk }, { pollMs = 5000, maxWaitMs = 180000 } = {}) {
  const { key, baseUrl } = kurierConfig();
  if (!key) {
    const err = new Error('KURIER_API_KEY is not set');
    err.code = 'NO_API_KEY';
    throw err;
  }
  if (!proof || !Array.isArray(publicSignals) || !vk) {
    const err = new Error('proof, publicSignals (array) and vk (object or vkHash string) are required');
    err.code = 'BAD_INPUT';
    throw err;
  }

  // 1. Register the vk (once per circuit). If vk is already a hash, skip.
  let vkHash;
  if (typeof vk === 'string') {
    vkHash = vk;
  } else {
    const regParams = {
      proofType: 'groth16',
      proofOptions: { library: 'snarkjs', curve: 'bn128' },
      vk,
    };
    const reg = await postJson(`${baseUrl}/register-vk/${key}`, regParams, { timeoutMs: 30000 });
    vkHash = reg?.vkHash || reg?.hash || reg?.data?.vkHash;
    if (!vkHash) {
      const err = new Error(`register-vk did not return a vkHash: ${JSON.stringify(reg).slice(0, 300)}`);
      err.code = 'REGISTER_FAILED';
      throw err;
    }
  }

  // 2. Submit the proof.
  const params = {
    proofType: 'groth16',
    proofOptions: { library: 'snarkjs', curve: 'bn128' },
    proofData: { proof, publicSignals, vk: vkHash },
  };
  const submitted = await postJson(`${baseUrl}/submit-proof/${key}`, params, { timeoutMs: 30000 });
  const jobId = submitted?.jobId || submitted?.data?.jobId;
  if (!jobId) {
    const err = new Error(`submit-proof did not return a jobId: ${JSON.stringify(submitted).slice(0, 300)}`);
    err.code = 'SUBMIT_FAILED';
    throw err;
  }

  // 3. Poll job-status until Finalized / Failed / timeout.
  const deadline = Date.now() + maxWaitMs;
  let last = null;
  while (Date.now() < deadline) {
    const status = await fetchJson(`${baseUrl}/job-status/${key}/${jobId}`, { timeoutMs: 15000, retries: 0 });
    last = status;
    const s = status?.status;
    if (s === 'Finalized') {
      const txHash = status?.txHash || status?.data?.txHash || null;
      return {
        jobId,
        status: 'Finalized',
        verified: true,
        txHash,
        explorerUrl: txHash ? `${EXPLORER_TESTNET}${txHash}` : null,
        statement: status?.statement || status?.data?.statement || null,
        raw: status,
      };
    }
    if (s === 'Failed') {
      const err = new Error(`Kurier job ${jobId} failed: ${JSON.stringify(status).slice(0, 300)}`);
      err.code = 'JOB_FAILED';
      err.jobId = jobId;
      throw err;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const err = new Error(`Timed out waiting for Finalized (last status: ${last?.status || 'unknown'})`);
  err.code = 'POLL_TIMEOUT';
  err.jobId = jobId;
  err.lastStatus = last;
  throw err;
}
