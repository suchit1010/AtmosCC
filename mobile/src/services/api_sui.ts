/**
 * ATMOS Mobile — Sui-specific API additions
 * ─────────────────────────────────────────────────────
 * Drop-in additions to the existing api.ts.
 * The core API (auth, projects, marketplace, payments) is unchanged.
 *
 * New Sui fields returned by backend:
 *   - mint_address   → now a Sui Object ID  (0x + 64 hex)
 *   - solana_mint_tx → now a Sui tx digest  (base58)
 *   - proof_hash     → same format, but anchored via Sui event
 *   - walrus_blob_id → Walrus blob ID for satellite imagery
 *
 * New response fields:
 *   - explorer       → suiexplorer.com link
 *   - sui_object_id  → Sui CarbonCredit object ID
 *   - certificateId  → RetirementCertificate Sui object ID
 *   - walrusBlobId   → Walrus blob ID for satellite data
 */

import axios from 'axios';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://127.0.0.1:3000';
const api = axios.create({ baseURL: BASE_URL, timeout: 30000, headers: { 'Content-Type': 'application/json' } });

// ── Sui-specific helpers ─────────────────────────────────

/**
 * Build Sui Explorer URL for an object or transaction
 */
export function suiExplorerUrl(
  idOrDigest: string,
  type: 'object' | 'txblock' = 'object',
  network: string = 'testnet'
): string {
  return `https://suiexplorer.com/${type}/${idOrDigest}?network=${network}`;
}

/**
 * Build Walrus aggregator URL to retrieve satellite imagery
 */
export function walrusUrl(blobId: string): string {
  const aggregator = 'https://aggregator.walrus-testnet.walrus.space';
  return `${aggregator}/v1/${blobId}`;
}

/**
 * Parse grade number (u8) from on-chain to letter
 */
export function gradeFromU8(grade: number): string {
  return ['D', 'C', 'B', 'A', 'S'][grade] ?? 'B';
}

/**
 * Parse grade letter to u8 for Move calls
 */
export function gradeToU8(grade: string): number {
  return { S: 4, A: 3, B: 2, C: 1, D: 0 }[grade.toUpperCase()] ?? 2;
}

/**
 * Format Sui Object ID for display (truncated)
 */
export function formatSuiId(id: string, chars = 8): string {
  if (!id || id.length < 10) return id;
  return `${id.slice(0, chars)}...${id.slice(-4)}`;
}

/**
 * Format Sui tx digest for display
 */
export function formatTxDigest(digest: string, chars = 8): string {
  if (!digest || digest.length < 10) return digest;
  return `${digest.slice(0, chars)}...${digest.slice(-4)}`;
}

// ── Carbon Credit Sui fields type ───────────────────────
export interface SuiCarbonCredit {
  // Standard fields (same as before)
  id:              string;
  project_id:      string;
  entity_type:     string;
  name:            string;
  status:          string;
  co2e_estimated:  number;
  confidence_score:number;
  grade:           string;
  methodology_match:string;
  price_min_inr:   number;
  price_max_inr:   number;

  // Sui-specific fields
  sui_object_id:    string;   // CarbonCredit Sui Object ID
  sui_mint_tx:      string;   // Sui mint tx digest
  walrus_blob_id:   string;   // Walrus satellite blob ID
  sui_anchor_tx:    string;   // Sui anchor tx digest
  proof_hash:       string;
  explorer:         string;   // suiexplorer.com link
}

// ── Retirement result ────────────────────────────────────
export interface SuiRetirementResult {
  message:        string;
  suiTxDigest:    string;
  certificateId:  string;   // RetirementCertificate Sui object ID
  quantity:       number;
  certUrl:        string;
  explorer:       string;
}

// ── Walrus satellite imagery viewer ─────────────────────
export const WalrusAPI = {
  /**
   * Get the satellite imagery URL for a credit's blob ID
   * Use in <Image source={{ uri: WalrusAPI.getSatelliteUrl(blobId) }} />
   */
  getSatelliteUrl: (blobId: string) => walrusUrl(blobId),

  /**
   * Check if a blob ID is real (not a mock/pending value)
   */
  isRealBlob: (blobId: string) => {
    return blobId && blobId.length === 64 && !blobId.startsWith('pending') && !blobId.startsWith('mock');
  },
};

// ── Health check (includes Sui + Walrus status) ──────────
export const SuiHealthAPI = {
  check: () => api.get<{
    status:     string;
    chain:      string;
    services: {
      sui:        string;
      suiEpoch:   number;
      suiNetwork: string;
      walrus:     string;
      walrusMode: 'live' | 'mock';
    };
  }>('/health'),
};

export default api;
