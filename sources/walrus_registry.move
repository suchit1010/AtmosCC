/// ATMOS Protocol — Walrus Satellite Data Registry
/// =========================================================
/// Walrus track integration: every carbon credit's satellite imagery
/// (Sentinel-2 tiles, NDVI maps, cloud masks) is stored on Walrus.
/// The Walrus blob ID is stored ON the CarbonCredit object, creating
/// a cryptographic link between the on-chain asset and its off-chain evidence.
///
/// Architecture:
///   1. Backend uploads 100MB+ satellite tiles to Walrus
///   2. Walrus returns a blob_id (32-byte hash)
///   3. blob_id is included in the mint transaction
///   4. Stored permanently in credit.satellite_blob_id
///   5. Anyone can reconstruct the exact imagery that backed the credit
///
/// This makes ATMOS verification PROVABLY AUDITABLE:
///   - Regulator: "Show me the satellite data for credit XYZ"
///   - Answer: Retrieve blob_id from on-chain object → fetch from Walrus → verify

module atmos_cc::walrus_registry {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};
    use std::string::String;

    // ── Satellite Data Record ────────────────────────────
    /// On-chain registry entry linking a project to its Walrus blobs.
    /// One record per verification run.
    public struct SatelliteDataRecord has key, store {
        id:               UID,
        project_id:       String,
        credit_id:        ID,

        // Walrus blob IDs for each data type
        ndvi_blob_id:     String,   // NDVI raster (GeoTIFF)
        rgb_blob_id:      String,   // True color imagery
        biomass_blob_id:  String,   // Biomass estimate map
        report_blob_id:   String,   // Full JSON verification report

        // Metadata
        image_date:       String,   // ISO date of satellite pass
        cloud_cover_pct:  u8,       // Cloud cover percentage
        data_source:      String,   // "sentinel-2" | "landsat-9"
        ndvi_score:       u8,       // NDVI × 100 (0-100 scale)
        recorded_at:      u64,
    }

    // ── Events ────────────────────────────────────────────
    public struct SatelliteDataRegistered has copy, drop {
        record_id:       ID,
        project_id:      String,
        credit_id:       ID,
        ndvi_blob_id:    String,
        rgb_blob_id:     String,
        report_blob_id:  String,
        image_date:      String,
        timestamp:       u64,
    }

    // ── Register satellite data ───────────────────────────
    /// Called by the backend after uploading imagery to Walrus.
    /// Creates a permanent on-chain record linking project → blobs.
    public entry fun register_satellite_data(
        project_id:      String,
        credit_id:       ID,
        ndvi_blob_id:    String,
        rgb_blob_id:     String,
        biomass_blob_id: String,
        report_blob_id:  String,
        image_date:      String,
        cloud_cover_pct: u8,
        data_source:     String,
        ndvi_score:      u8,
        clock:           &Clock,
        ctx:             &mut TxContext,
    ) {
        let now        = clock::timestamp_ms(clock);
        let record_uid = object::new(ctx);
        let record_id  = object::uid_to_inner(&record_uid);

        event::emit(SatelliteDataRegistered {
            record_id,
            project_id,
            credit_id,
            ndvi_blob_id,
            rgb_blob_id,
            report_blob_id,
            image_date,
            timestamp: now,
        });

        let record = SatelliteDataRecord {
            id:              record_uid,
            project_id,
            credit_id,
            ndvi_blob_id,
            rgb_blob_id,
            biomass_blob_id,
            report_blob_id,
            image_date,
            cloud_cover_pct,
            data_source,
            ndvi_score,
            recorded_at:     now,
        };

        // Transfer to caller (backend wallet)
        transfer::transfer(record, tx_context::sender(ctx));
    }

    // ── Read helpers ──────────────────────────────────────
    public fun get_ndvi_blob(record: &SatelliteDataRecord): &String {
        &record.ndvi_blob_id
    }

    public fun get_report_blob(record: &SatelliteDataRecord): &String {
        &record.report_blob_id
    }

    public fun get_ndvi_score(record: &SatelliteDataRecord): u8 {
        record.ndvi_score
    }
}
