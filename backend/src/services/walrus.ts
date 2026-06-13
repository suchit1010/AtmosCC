/**
 * ATMOS Protocol — Walrus Storage Service
 * ─────────────────────────────────────────────────────
 * Walrus track: verifiable off-chain storage for satellite imagery.
 *
 * Why Walrus for ATMOS:
 *  - Sentinel-2 tiles are 100MB+ each — too large for on-chain
 *  - Walrus provides content-addressed storage with Sui anchoring
 *  - Blob IDs stored in CarbonCredit objects = cryptographic link
 *  - Anyone can retrieve and re-verify the satellite data
 *  - Enables "show your work" for every carbon credit
 *
 * Walrus integration:
 *  1. Satellite data (GeoTIFF) → upload to Walrus publisher
 *  2. Get back blob_id (32-byte content hash)
 *  3. Store blob_id in carbon credit object on Sui
 *  4. Auditors: blob_id → fetch from any Walrus aggregator → verify NDVI
 *
 * Docs: https://docs.walrus.site
 * Testnet publisher: https://publisher.walrus-testnet.walrus.space
 * Testnet aggregator: https://aggregator.walrus-testnet.walrus.space
 */

import axios from 'axios';
import crypto from 'crypto';
import { logger } from '../utils/logger';

const WALRUS_PUBLISHER  = process.env.WALRUS_PUBLISHER_URL
  || 'https://publisher.walrus-testnet.walrus.space';
const WALRUS_AGGREGATOR = process.env.WALRUS_AGGREGATOR_URL
  || 'https://aggregator.walrus-testnet.walrus.space';

export interface WalrusUploadResult {
  blobId:       string;
  url:          string;
  size:         number;
  contentType:  string;
  expiryEpoch?: number;  // Walrus epoch after which blob expires
  mock:         boolean;
}

// ── Generate deterministic mock blob ID ─────────────────
function mockBlobId(data: Buffer | string): string {
  return crypto
    .createHash('sha256')
    .update(typeof data === 'string' ? data : data)
    .digest('hex');
}

// ── Upload raw data to Walrus ─────────────────────────────
export async function uploadToWalrus(
  data:        Buffer | string,
  contentType: string = 'application/octet-stream',
  epochs:      number = 5,     // How many epochs to store
): Promise<WalrusUploadResult> {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;

  // Mock mode if Walrus not configured or in dev
  if (!process.env.WALRUS_PUBLISHER_URL) {
    const blobId = mockBlobId(buffer);
    logger.debug('Walrus mock upload', { blobId: blobId.slice(0, 12), size: buffer.length });
    return {
      blobId:      blobId,
      url:         `${WALRUS_AGGREGATOR}/v1/${blobId}`,
      size:        buffer.length,
      contentType,
      mock:        true,
    };
  }

  try {
    const res = await axios.put(
      `${WALRUS_PUBLISHER}/v1/store?epochs=${epochs}`,
      buffer,
      {
        headers: { 'Content-Type': contentType },
        maxBodyLength: Infinity,
        timeout: 30_000,
      }
    );

    // Walrus returns either newlyCreated or alreadyCertified
    const info = res.data?.newlyCreated?.blobObject
               || res.data?.alreadyCertified?.blobId;

    const blobId = typeof info === 'string'
      ? info
      : info?.blobId || info?.id || mockBlobId(buffer);

    logger.info('Walrus upload successful', {
      blobId: blobId.slice(0, 12),
      size:   buffer.length,
    });

    return {
      blobId,
      url:         `${WALRUS_AGGREGATOR}/v1/${blobId}`,
      size:        buffer.length,
      contentType,
      expiryEpoch: res.data?.newlyCreated?.blobObject?.storage?.endEpoch,
      mock:        false,
    };
  } catch (err: any) {
    // Fallback to mock on upload failure
    logger.warn('Walrus upload failed, using mock blob ID', { error: err.message });
    const blobId = mockBlobId(buffer);
    return {
      blobId,
      url:  `${WALRUS_AGGREGATOR}/v1/${blobId}`,
      size: buffer.length,
      contentType,
      mock: true,
    };
  }
}

// ── Upload satellite report (JSON) ───────────────────────
export async function uploadSatelliteReport(
  projectId:      string,
  satelliteResult: Record<string, any>,
): Promise<WalrusUploadResult> {
  const report = {
    project_id: projectId,
    generated_at: new Date().toISOString(),
    source: 'sentinel-2',
    ...satelliteResult,
  };

  const data = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  return uploadToWalrus(data, 'application/json');
}

// ── Upload verification report (AI result) ───────────────
export async function uploadVerificationReport(
  projectId:     string,
  aiResult:      Record<string, any>,
  zkProofHash:   string,
): Promise<WalrusUploadResult> {
  const report = {
    project_id:   projectId,
    generated_at: new Date().toISOString(),
    protocol:     'atmos-v1',
    zk_proof:     zkProofHash,
    ...aiResult,
  };

  const data = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  return uploadToWalrus(data, 'application/json');
}

// ── Upload raw satellite tile (GeoTIFF) ──────────────────
export async function uploadSatelliteTile(
  tileData: Buffer,
  filename: string,
): Promise<WalrusUploadResult> {
  logger.info('Uploading satellite tile to Walrus', {
    filename,
    size: `${(tileData.length / 1_000_000).toFixed(1)}MB`,
  });
  return uploadToWalrus(tileData, 'image/tiff');
}

// ── Fetch from Walrus ─────────────────────────────────────
export async function fetchFromWalrus(blobId: string): Promise<Buffer> {
  try {
    const res = await axios.get(`${WALRUS_AGGREGATOR}/v1/${blobId}`, {
      responseType: 'arraybuffer',
      timeout:      30_000,
    });
    return Buffer.from(res.data);
  } catch (err: any) {
    logger.warn('Walrus fetch failed', { blobId: blobId.slice(0, 12), error: err.message });
    throw new Error(`Walrus fetch failed for blob ${blobId}: ${err.message}`);
  }
}

// ── Build Walrus URL for a blob ───────────────────────────
export function getWalrusUrl(blobId: string): string {
  return `${WALRUS_AGGREGATOR}/v1/${blobId}`;
}

// ── Health check ─────────────────────────────────────────
export async function walrusHealthCheck(): Promise<{ ok: boolean; mode: 'live' | 'mock' }> {
  if (!process.env.WALRUS_PUBLISHER_URL) {
    return { ok: true, mode: 'mock' };
  }
  try {
    await axios.get(`${WALRUS_AGGREGATOR}/v1/health`, { timeout: 5000 });
    return { ok: true, mode: 'live' };
  } catch {
    return { ok: false, mode: 'live' };
  }
}
