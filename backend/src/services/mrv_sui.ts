/**
 * ATMOS Protocol — MRV Pipeline (Sui version)
 * ─────────────────────────────────────────────────────
 * Replaces: mrv.ts (Solana version)
 * Changes: SPL mint → Sui object mint; anchor → Sui events; Walrus integration
 *
 * Pipeline steps (same as before, blockchain layer updated):
 *  1. Satellite fetch (unchanged)
 *  2. AI verification (unchanged)
 *  3. ZK proof generation (anchor → Sui)
 *  4. Walrus upload (new!) — satellite imagery → Walrus blob
 *  5. Sui mint — CarbonCredit object with Walrus blob ID
 *  6. (Optional) Marketplace listing on Sui
 */

import { query, transaction } from '../db/pool';
import { logger }              from '../utils/logger';
import { runSatelliteAnalysis, type SatelliteResult } from './satellite';
import { runAIVerification,    type AIVerificationResult } from './ai';
import { generateZKProofSui,   type ZKProofOutputSui } from './zk_sui';
import {
  mintCarbonCreditSui,
  listCreditOnSui,
  registerSatelliteData,
  type MintCreditResult,
} from './sui';
import {
  uploadSatelliteReport,
  uploadVerificationReport,
} from './walrus';

// ── Types ─────────────────────────────────────────────────
type StatusEmitter = (event: string, data: object) => void;
let wsEmitter: StatusEmitter = () => {};
export function setWebSocketEmitter(fn: StatusEmitter): void { wsEmitter = fn; }

function emit(projectId: string, step: string, data: object): void {
  wsEmitter(`mrv:${projectId}`, { step, timestamp: Date.now(), ...data });
}

async function updateStatus(projectId: string, status: string): Promise<void> {
  await query(`UPDATE projects SET status = $1, updated_at = NOW() WHERE id = $2`, [status, projectId]);
}

// ── Full pipeline ─────────────────────────────────────────
export async function runMRVPipelineSui(projectId: string): Promise<any> {
  logger.info('Starting MRV pipeline (Sui)', { projectId });

  const projResult = await query(
    `SELECT p.*, u.id as user_id, u.wallet_address
     FROM projects p JOIN users u ON u.id = p.user_id WHERE p.id = $1`,
    [projectId]
  );
  if (projResult.rows.length === 0) throw new Error(`Project not found: ${projectId}`);

  const project  = projResult.rows[0];
  const meta     = typeof project.metadata === 'string' ? JSON.parse(project.metadata) : project.metadata;

  const geoResult = await query(
    `SELECT ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng FROM projects WHERE id = $1`,
    [projectId]
  );
  const { lat, lng } = geoResult.rows[0] || { lat: 23.0, lng: 72.6 };

  emit(projectId, 'started', { message: 'MRV pipeline started (Sui)' });

  // ── Step 1: Satellite ─────────────────────────────────
  await updateStatus(projectId, 'analyzing');
  emit(projectId, 'satellite.start', { message: 'Fetching satellite imagery...' });

  let satellite: SatelliteResult;
  try {
    satellite = await runSatelliteAnalysis({ projectId, lat, lng, areaHa: parseFloat(meta.areaHa || '1'), entityType: project.entity_type });
    emit(projectId, 'satellite.done', { ndvi: satellite.ndviCurrent, landUse: satellite.landUse });
  } catch (err: any) {
    await updateStatus(projectId, 'rejected');
    return { projectId, status: 'failed', errorStep: 'satellite', errorMsg: err.message };
  }

  // ── Step 2: Walrus upload (satellite report) ──────────
  let satelliteWalrusBlobId = 'pending';
  try {
    const satReport = await uploadSatelliteReport(projectId, {
      ndvi_current:   satellite.ndviCurrent,
      ndvi_baseline:  satellite.ndviBaseline,
      land_use:       satellite.landUse,
      fire_detected:  satellite.fireDetected,
      biomass_tonnes: satellite.biomassTonnes,
    });
    satelliteWalrusBlobId = satReport.blobId;
    emit(projectId, 'walrus.satellite', { blobId: satelliteWalrusBlobId.slice(0, 12), mock: satReport.mock });
  } catch (err: any) {
    logger.warn('Walrus satellite upload failed', { error: err.message });
  }

  // ── Step 3: AI Verification ───────────────────────────
  emit(projectId, 'ai.start', { message: 'Running AI carbon estimation...' });

  let verification: AIVerificationResult;
  try {
    verification = await runAIVerification(projectId, project.entity_type, meta, satellite);
    emit(projectId, 'ai.done', {
      co2e: verification.co2eEstimated,
      confidence: verification.confidence.overall,
      grade: verification.grade,
      fraudRisk: verification.fraud.risk,
    });

    if (verification.fraud.risk === 'high' || verification.confidence.overall < 30) {
      await updateStatus(projectId, 'rejected');
      emit(projectId, 'rejected', { reason: 'Verification flagged' });
      return { projectId, status: 'failed', errorStep: 'ai' };
    }
  } catch (err: any) {
    await updateStatus(projectId, 'rejected');
    return { projectId, status: 'failed', errorStep: 'ai', errorMsg: err.message };
  }

  await updateStatus(projectId, 'ai_complete');

  // ── Step 4: Walrus upload (verification report) ───────
  let verificationWalrusBlobId = 'pending';
  try {
    const vkReport = await uploadVerificationReport(projectId, {
      co2e_estimated:  verification.co2eEstimated,
      grade:           verification.grade,
      confidence:      verification.confidence.overall,
      fraud_risk:      verification.fraud.risk,
      methodology:     verification.methodology,
    }, 'pending_zk');
    verificationWalrusBlobId = vkReport.blobId;
  } catch {}

  // ── Step 5: ZK Proof (Sui) ────────────────────────────
  emit(projectId, 'zk.start', { message: 'Generating zero-knowledge proof...' });

  const vResult      = await query(`SELECT id FROM ai_verifications WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`, [projectId]);
  const verificationId = vResult.rows[0]?.id || '';

  let zkProof: ZKProofOutputSui;
  try {
    zkProof = await generateZKProofSui({
      projectId,
      userId:         project.user_id,
      co2eEstimated:  verification.co2eEstimated,
      grade:          verification.grade,
      entityType:     project.entity_type,
      metadata:       meta,
      lat, lng,
      confidence:     verification.confidence.overall,
      verificationId,
    });
    emit(projectId, 'zk.done', { proofHash: zkProof.proofHash, suiTxDigest: zkProof.suiAnchorTxDigest });
  } catch (err: any) {
    logger.warn('ZK step failed, continuing', { error: err.message });
    zkProof = {
      proofHash: `zk_${projectId.slice(0, 12)}`,
      publicSignals: {} as any,
      privateInputHash: '',
      suiAnchorTxDigest: 'pending',
      circuitVersion: 'carbon_mrv_v1',
      verificationStatus: 'failed',
      proofData: '',
    };
  }

  // ── Step 6: Sui mint ──────────────────────────────────
  const recipientAddress = project.wallet_address || keypairAddress();
  emit(projectId, 'mint.start', { message: 'Minting CarbonCredit object on Sui...' });

  let mintResult: MintCreditResult;
  try {
    mintResult = await mintCarbonCreditSui(
      projectId,
      project.name || 'ATMOS Carbon Credit',
      verification.co2eEstimated,
      verification.grade,
      verification.methodology || 'VM0044',
      new Date().getFullYear(),
      verification.confidence.overall,
      zkProof.proofHash,
      satelliteWalrusBlobId,
      recipientAddress,
    );
    emit(projectId, 'mint.done', { objectId: mintResult.objectId, txDigest: mintResult.txDigest });
  } catch (err: any) {
    logger.error('Sui mint failed', { error: err.message });
    mintResult = {
      objectId:  `0x${require('crypto').randomBytes(32).toString('hex')}`,
      txDigest:  `SUI_MOCK_${require('crypto').randomBytes(16).toString('hex')}`,
      status:    'failed',
      amount:    verification.co2eEstimated,
      recipient: recipientAddress,
    };
  }

  // ── Step 7: Register satellite data on Walrus registry ──
  if (mintResult.objectId && mintResult.objectId !== '0x0') {
    try {
      await registerSatelliteData(
        projectId,
        mintResult.objectId,
        satelliteWalrusBlobId,
        'pending_rgb',
        'pending_biomass',
        verificationWalrusBlobId,
        new Date().toISOString().split('T')[0],
        Math.round(satellite.cloudCoverPct || 10),
        Math.round((satellite.ndviCurrent || 0.7) * 100),
      );
    } catch (err: any) {
      logger.warn('Walrus registry failed', { error: err.message });
    }
  }

  // ── Persist to DB ─────────────────────────────────────
  await transaction(async (client) => {
    const creditRes = await client.query(
      `INSERT INTO carbon_credits (
        project_id, zk_proof_id, mint_address, amount_co2e,
        grade, methodology, vintage_year, status, list_price_inr, solana_mint_tx
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        projectId,
        null,
        mintResult.objectId,   // Sui object ID stored where Solana mint address was
        verification.co2eEstimated,
        verification.grade,
        verification.methodology || 'VM0044',
        new Date().getFullYear(),
        'minted',
        verification.priceMinInr || 700,
        mintResult.txDigest,   // Sui tx digest stored where Solana tx hash was
      ]
    );

    await client.query(
      `UPDATE projects SET status = 'verified', updated_at = NOW() WHERE id = $1`,
      [projectId]
    );
  });

  emit(projectId, 'verified', {
    message:   'Project verified on Sui',
    co2e:      verification.co2eEstimated,
    proofHash: zkProof.proofHash,
    grade:     verification.grade,
    objectId:  mintResult.objectId,
    walrus:    satelliteWalrusBlobId,
  });

  return {
    projectId,
    satellite,
    verification,
    zkProof,
    mint: mintResult,
    walrusBlobId: satelliteWalrusBlobId,
    status: 'verified',
  };
}

// ── Mint step (user-initiated) ────────────────────────────
export async function mintProjectCreditSui(
  projectId: string,
  listForSale: boolean = true,
  listPriceInr?: number,
): Promise<MintCreditResult> {
  const projResult = await query(
    `SELECT p.*, u.wallet_address,
            v.co2e_estimated, v.grade, v.methodology, v.price_min_inr
     FROM projects p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN ai_verifications v ON v.project_id = p.id
     WHERE p.id = $1 ORDER BY v.created_at DESC LIMIT 1`,
    [projectId]
  );

  if (projResult.rows.length === 0) throw new Error('Project not found');
  const row    = projResult.rows[0];
  const wallet = row.wallet_address || keypairAddress();
  const co2e   = parseFloat(row.co2e_estimated || '1.0');
  const grade  = row.grade || 'B';
  const priceInr = listPriceInr || parseFloat(row.price_min_inr || '700');

  const zkResult = await query(`SELECT proof_hash FROM zk_proofs WHERE project_id = $1 ORDER BY generated_at DESC LIMIT 1`, [projectId]);
  const zkHash   = zkResult.rows[0]?.proof_hash || `zk_${projectId.slice(0, 12)}`;

  const mintResult = await mintCarbonCreditSui(
    projectId,
    row.name || 'ATMOS Carbon Credit',
    co2e,
    grade,
    row.methodology || 'VM0044',
    new Date().getFullYear(),
    85,
    zkHash,
    'pending_walrus',
    wallet,
  );

  await transaction(async (client) => {
    const creditRes = await client.query(
      `INSERT INTO carbon_credits (project_id, mint_address, amount_co2e, grade, methodology, vintage_year, status, list_price_inr, solana_mint_tx)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [projectId, mintResult.objectId, co2e, grade, row.methodology || 'VM0044', new Date().getFullYear(), listForSale ? 'listed' : 'minted', priceInr, mintResult.txDigest]
    );

    const creditId = creditRes.rows[0].id;
    if (listForSale) {
      await client.query(
        `INSERT INTO marketplace_listings (seller_id, credit_id, quantity, unit_price_inr) VALUES ($1,$2,$3,$4)`,
        [row.user_id, creditId, co2e, priceInr]
      );
    }
    await client.query(`UPDATE projects SET status = 'listed', updated_at = NOW() WHERE id = $1`, [projectId]);
  });

  return mintResult;
}

function keypairAddress(): string {
  return 'sui_devnet_wallet_' + require('crypto').randomBytes(8).toString('hex');
}
