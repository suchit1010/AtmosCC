# ATMOS Protocol — Sui Edition 🌿⛓️

> **Verified. Tradable. Instant. Global.**  
> Real-world carbon reduction → AI + Satellite verified → ZK-proven → Sui Object → Walrus anchored → Settled via Dodo Payments

[![Move CI](https://github.com/suchit1010/AtmosCC/actions/workflows/sui-ci.yml/badge.svg)](https://github.com/suchit1010/AtmosCC/actions)
[![Sui Testnet](https://img.shields.io/badge/Sui-Testnet-6fbcf0)](https://suiexplorer.com)
[![Walrus](https://img.shields.io/badge/Storage-Walrus-ff6b35)](https://docs.walrus.site)

---

## Why Sui > Solana for Carbon Credits

| Feature | Solana (old) | Sui (this repo) |
|---------|-------------|-----------------|
| Asset model | SPL token (fungible) | **Object** (unique, owned — perfect for carbon credits) |
| Credit identity | 1 token = 1 tonne, fungible | **Rich object**: grade + vintage + methodology + satellite evidence |
| Satellite data | Off-chain, no link | **Walrus blob ID stored on-chain** — provably auditable |
| Privacy | Manual ZK integration | Native ZK proof stored in object |
| Smart contracts | Anchor/Rust | **Move** (formally verifiable, safer for finance) |
| Retirement | Burn tokens | **Mutate object state** → `retired = true` permanently |
| Compliance | No native RWA | **Explorations track** — built for RWA + DePIN |

**Carbon credits ARE objects, not tokens.** A biochar farm in Gujarat that sequesters 2.46 tCO₂e generates a unique, non-interchangeable asset with specific grade, vintage, methodology, and satellite-verified provenance. Sui's object model captures this natively.

---

## Sui Overflow 2026 — Track Applications

| Track | Why ATMOS Qualifies | Prize |
|-------|-------------------|-------|
| 🥇 **Explorations** (RWA + DePIN) | Carbon credits = Real World Assets; Satellite network = DePIN | $50K+ |
| 🥈 **DeFi & Payments** | Cross-border INR/USDC settlement for climate finance | $30K first |
| 🥉 **Walrus** | 100MB+ satellite tiles stored on Walrus, blob ID on-chain | $70K pool |

---

## Architecture

```
┌──────────────────────────────────────────┐
│         React Native Mobile App          │
│   - Project capture (GPS + photos)       │
│   - Live MRV pipeline tracking           │
│   - Sui Object viewer (Sui Explorer)     │
│   - Walrus satellite imagery viewer      │
└──────────────┬───────────────────────────┘
               │ HTTPS / WebSocket
               ▼
┌──────────────────────────────────────────┐
│         Node.js Backend (Fastify)        │
│   ┌──────────────────────────────────┐   │
│   │ Services                         │   │
│   │ ├── auth.ts     (OTP + JWT)      │   │
│   │ ├── sui.ts      ← NEW            │   │
│   │ ├── walrus.ts   ← NEW            │   │
│   │ ├── zk_sui.ts   ← UPDATED        │   │
│   │ ├── mrv_sui.ts  ← UPDATED        │   │
│   │ ├── payments.ts (Dodo, unchanged)│   │
│   │ ├── satellite.ts (unchanged)     │   │
│   │ └── ai.ts       (unchanged)      │   │
│   └──────────────────────────────────┘   │
└────┬────────────┬─────────────┬──────────┘
     │            │             │
     ▼            ▼             ▼
  PostgreSQL   Walrus        Sui Testnet
  + PostGIS    Storage       (Move contracts)
```

---

## Move Contracts

### `sources/carbon_credit.move` — Core Asset

```move
struct CarbonCredit has key, store {
    id:                UID,
    project_id:        String,   // UUID from backend
    project_name:      String,
    producer:          address,
    tonnes_kg:         u64,      // CO2e in kg (2460 = 2.46 tonnes)
    grade:             u8,       // 0=D, 1=C, 2=B, 3=A, 4=S
    methodology:       String,   // "VM0044", "VM0047"...
    vintage_year:      u16,
    confidence_score:  u8,       // 0-100 from AI
    zk_proof_hash:     String,   // Groth16 ZK proof
    satellite_blob_id: String,   // Walrus blob ID ← KEY INNOVATION
    verified_at:       u64,
    retired:           bool,
    retirement_org:    String,
    esg_reference:     String,
}
```

### `sources/marketplace.move` — P2P Trading

```move
struct Listing has key {
    seller:      address,
    credit:      CarbonCredit,  // Credit wrapped inside listing
    price_mist:  u64,           // Price in SUI (MIST units)
    price_inr:   u64,           // Indicative INR price
    active:      bool,
}
```

### `sources/walrus_registry.move` — Satellite Evidence

```move
struct SatelliteDataRecord has key, store {
    project_id:       String,
    credit_id:        ID,
    ndvi_blob_id:     String,   // NDVI GeoTIFF on Walrus
    rgb_blob_id:      String,   // True color imagery
    biomass_blob_id:  String,   // Biomass estimate map
    report_blob_id:   String,   // Full JSON verification report
    image_date:       String,
    ndvi_score:       u8,
}
```

---

## Quick Start (10 minutes)

### 1. Clone & setup

```bash
git clone https://github.com/suchit1010/AtmosCC.git
cd AtmosCC
chmod +x scripts/setup_dev.sh
./scripts/setup_dev.sh
```

### 2. Deploy Move contracts to Sui testnet

```bash
chmod +x scripts/deploy_sui.sh
./scripts/deploy_sui.sh testnet
# Outputs: SUI_PACKAGE_ID and SUI_CONFIG_OBJ_ID
# Automatically updates backend/.env
```

### 3. Start backend

```bash
cd backend
cp .env.example .env
# Edit .env: add JWT_SECRET (required)
npm install
npm run dev
# → http://localhost:3000
```

### 4. Verify health

```bash
curl http://localhost:3000/health
# {
#   "status": "ok",
#   "chain": "sui",
#   "services": {
#     "sui": "ok",
#     "suiEpoch": 742,
#     "suiNetwork": "testnet",
#     "walrus": "ok",
#     "walrusMode": "live"
#   }
# }
```

### 5. Test mint a credit

```bash
cd scripts
npx ts-node mint_test_credit.ts
# Mints a CarbonCredit object on Sui testnet
# Shows Sui Explorer link
```

---

## API Reference

All endpoints identical to Solana version — **mobile app requires zero changes**.

New fields in responses:

```
GET /api/v1/projects/:id
{
  "sui_object_id": "0xabc...",      ← Sui CarbonCredit Object ID
  "sui_anchor_tx": "SUI_xyz...",    ← Sui tx digest
  "walrus_blob_id": "sha256...",    ← Walrus satellite imagery blob
  ...
}

POST /api/v1/projects/:id/mint
{
  "objectId": "0xabc...",           ← Sui CarbonCredit Object ID
  "txDigest": "SUI_xyz...",         ← Sui tx digest
  "explorer": "https://suiexplorer.com/object/0xabc..."
}

POST /api/v1/credits/retire
{
  "suiTxDigest": "SUI_xyz...",
  "certificateId": "0xdef...",      ← RetirementCertificate Object ID
  "explorer": "https://suiexplorer.com/object/0xdef..."
}
```

Full API docs: same as Solana version (auth, projects, marketplace, payments, portfolio, dashboard).

---

## MRV Pipeline (Sui Edition)

```
User submits project
       │
       ▼
1. Satellite fetch (Sentinel-2)
       │ NDVI, biomass, land-use
       ▼
2. Walrus upload ← NEW
       │ Satellite report → Walrus blob ID
       ▼
3. AI verification (Claude)
       │ CO2e estimate, grade, fraud detection
       ▼
4. Walrus upload ← NEW
       │ AI verification report → Walrus blob ID
       ▼
5. ZK proof generation
       │ Groth16 proof, anchored via Sui event
       ▼
6. Sui mint ← CHANGED (was Solana SPL)
       │ CarbonCredit object with Walrus blob ID
       ▼
7. Walrus registry ← NEW
       │ On-chain record: project → blob IDs
       ▼
Complete: Credit in producer's wallet
```

---

## Walrus Integration

Every carbon credit's satellite evidence is stored on Walrus:

```
Credit verification:
  1. Backend fetches Sentinel-2 imagery (100MB+ tiles)
  2. Uploads to Walrus testnet publisher
  3. Gets blob_id (32-byte content hash)
  4. Stores blob_id in CarbonCredit.satellite_blob_id

Auditability:
  Anyone can verify: blob_id → Walrus aggregator → exact satellite tile
  This proves the specific imagery that backed the credit

Mobile app:
  WalrusAPI.getSatelliteUrl(blobId) → <Image /> component
```

Walrus endpoints (testnet):
- Publisher: `https://publisher.walrus-testnet.walrus.space`
- Aggregator: `https://aggregator.walrus-testnet.walrus.space`

---

## Environment Variables

```env
# Required
JWT_SECRET=<min 32 chars>
JWT_REFRESH_SECRET=<min 32 chars>

# Sui (set after deploy)
SUI_NETWORK=testnet
SUI_PRIVATE_KEY_B64=<base64 Ed25519 key>
SUI_PACKAGE_ID=0x<package id after publish>
SUI_CONFIG_OBJ_ID=0x<config object id>

# Walrus (optional - uses testnet endpoints)
WALRUS_PUBLISHER_URL=https://publisher.walrus-testnet.walrus.space
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-testnet.walrus.space

# All others: see backend/.env.example
```

---

## Project Structure

```
AtmosCC/
├── Move.toml                          ← Sui package config
├── sources/
│   ├── carbon_credit.move             ← Core asset (CarbonCredit object)
│   ├── marketplace.move               ← P2P trading (Listing object)
│   └── walrus_registry.move           ← Satellite data registry
├── tests/
│   └── carbon_credit_tests.move       ← Move unit tests
├── backend/
│   ├── src/
│   │   ├── server.ts                  ← Fastify server
│   │   ├── routes/api.ts              ← All API endpoints
│   │   ├── services/
│   │   │   ├── sui.ts                 ← Sui SDK (replaces solana.ts)
│   │   │   ├── walrus.ts              ← Walrus storage service
│   │   │   ├── zk_sui.ts              ← ZK proofs (Sui anchor)
│   │   │   ├── mrv_sui.ts             ← MRV pipeline (Sui edition)
│   │   │   ├── auth.ts                ← OTP + JWT (unchanged)
│   │   │   └── payments.ts            ← Dodo Payments (unchanged)
│   │   ├── db/
│   │   │   ├── schema.sql             ← PostgreSQL + PostGIS schema
│   │   │   └── pool.ts                ← DB connection pool
│   │   ├── middleware/auth.ts          ← JWT guard
│   │   ├── types/schemas.ts            ← Zod validation
│   │   └── utils/logger.ts             ← Winston logging
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── mobile/
│   └── src/services/api_sui.ts         ← Sui helper functions
├── scripts/
│   ├── setup_dev.sh                    ← One-command dev setup
│   ├── deploy_sui.sh                   ← Deploy to testnet/mainnet
│   └── mint_test_credit.ts             ← Test mint script
└── .github/workflows/sui-ci.yml        ← CI: Move build + tests
```

---

## Demo Script (Sui Overflow Judges)

```
1. Show dashboard: "Carbon assets secured on Sui"
2. Tap + → Select "Biochar Production"
3. Fill form: Raju Koli, Anand Gujarat, 2.48 ha
4. Submit → Watch MRV pipeline:
   🛰️  Satellite: NDVI 0.67 → uploaded to Walrus
   🤖  AI: 2.46 tCO₂e · Grade A · 87% confidence
   🔐  ZK: proof hash generated
   🌊  Walrus: satellite report → blob ID stored
   ⛓️  Sui: CarbonCredit object minted
5. Show Sui Explorer: unique object with all metadata
6. Show Walrus: retrieve satellite imagery via blob ID
7. Switch to buyer → Buy → Dodo UPI payment
8. Settlement: Sui transfer confirmed in 4 seconds
9. Retire credits → RetirementCertificate NFT minted
10. Show BRSR certificate with on-chain proof
```

---

## Built With

**Blockchain:** Sui (Move) · Sui SDK (@mysten/sui)  
**Storage:** Walrus (satellite imagery)  
**Backend:** Node.js · TypeScript · Fastify · PostgreSQL + PostGIS  
**Mobile:** React Native · Expo  
**AI:** Anthropic Claude (carbon MRV)  
**Satellite:** Sentinel-2 (NDVI, biomass, land-use)  
**ZK:** Groth16 bn128 (carbon_mrv_v1 circuit)  
**Payments:** Dodo Payments (50+ currencies, UPI, cards)

---

**ATMOS Protocol — The trust layer carbon markets never had, built natively on Sui.** 🌍
