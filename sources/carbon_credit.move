/// ATMOS Protocol — Carbon Credit Module
/// =========================================================
/// Carbon credits are Sui OBJECTS, not fungible tokens.
/// Each credit has unique properties: grade, vintage, methodology,
/// satellite evidence, ZK proof — things SPL tokens cannot express natively.
///
/// Sui Object Model advantages for carbon credits:
///   - Owned objects: each credit belongs to exactly one address
///   - Rich metadata: grade, methodology, satellite data Walrus blob
///   - Mutability: mark retired = true permanently
///   - Events: every action emits an auditable on-chain event
///   - Composability: credits can be wrapped/transferred/split
///
/// Tracks: Explorations (RWA/DePIN) · DeFi & Payments · Walrus

module atmos_cc::carbon_credit {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::transfer;
    use sui::event;
    use sui::clock::{Self, Clock};
    use std::string::{Self, String};
    use std::vector;

    // ── Error codes ──────────────────────────────────────
    const EAlreadyRetired:     u64 = 1;
    const EInvalidAmount:      u64 = 2;
    const ENotAuthorized:      u64 = 3;
    const EInvalidGrade:       u64 = 4;
    const EInvalidMethodology: u64 = 5;
    const EProgramPaused:      u64 = 6;
    const EInvalidProof:       u64 = 7;

    // ── Grade constants ───────────────────────────────────
    const GRADE_S: u8 = 4;
    const GRADE_A: u8 = 3;
    const GRADE_B: u8 = 2;
    const GRADE_C: u8 = 1;
    const GRADE_D: u8 = 0;

    // ── Admin capability ──────────────────────────────────
    /// One-time admin capability. Created at init, transferred to deployer.
    public struct AdminCap has key, store {
        id: UID,
    }

    // ── Protocol configuration ────────────────────────────
    /// Global config object (shared, one per protocol)
    public struct ProtocolConfig has key {
        id:                 UID,
        admin:              address,
        fee_recipient:      address,
        protocol_fee_bps:   u64,     // Basis points: 200 = 2%
        total_minted_kg:    u64,     // kg CO2e total minted
        total_retired_kg:   u64,     // kg CO2e total retired
        total_credits:      u64,     // Count of credits ever minted
        paused:             bool,
    }

    // ── CarbonCredit Object ───────────────────────────────
    /// The core asset of ATMOS. Each represents a verified CO2e reduction.
    /// Stored as a Sui object — unique, owned, transferable.
    public struct CarbonCredit has key, store {
        id:                  UID,
        // Identity
        project_id:          String,   // Off-chain project ID (UUID)
        project_name:        String,
        producer:            address,   // Original producer wallet

        // Carbon data
        tonnes_kg:           u64,       // CO2e in kg (1 tonne = 1000 kg)
        grade:               u8,        // 0=D, 1=C, 2=B, 3=A, 4=S
        methodology:         String,    // "VM0044", "VM0047", etc.
        vintage_year:        u16,

        // Verification provenance
        confidence_score:    u8,        // 0–100 from AI verification
        zk_proof_hash:       String,    // Groth16 proof hash
        satellite_blob_id:   String,    // Walrus blob ID for satellite imagery
        verification_time:   u64,       // Unix timestamp ms

        // State
        retired:             bool,
        retired_by:          address,
        retired_at:          u64,
        retirement_org:      String,    // Organisation retiring for BRSR
        esg_reference:       String,    // Internal ESG reference code
    }

    // ── Retirement Certificate ────────────────────────────
    /// Issued when a credit is retired. Permanent proof of offset.
    /// This IS a transferable NFT that can be shown to auditors.
    public struct RetirementCertificate has key, store {
        id:              UID,
        credit_id:       ID,
        project_id:      String,
        project_name:    String,
        tonnes_kg:       u64,
        grade:           u8,
        methodology:     String,
        vintage_year:    u16,
        retired_by:      address,
        organisation:    String,
        esg_reference:   String,
        retired_at:      u64,
        zk_proof_hash:   String,
        certificate_seq: u64,    // Sequential certificate number
    }

    // ── Events ────────────────────────────────────────────
    public struct CreditMinted has copy, drop {
        credit_id:     ID,
        project_id:    String,
        producer:      address,
        tonnes_kg:     u64,
        grade:         u8,
        methodology:   String,
        vintage_year:  u16,
        confidence:    u8,
        zk_proof_hash: String,
        walrus_blob:   String,
        timestamp:     u64,
    }

    public struct CreditTransferred has copy, drop {
        credit_id: ID,
        from:      address,
        to:        address,
        tonnes_kg: u64,
        timestamp: u64,
    }

    public struct CreditRetired has copy, drop {
        credit_id:    ID,
        credit_obj:   ID,
        project_id:   String,
        tonnes_kg:    u64,
        grade:        u8,
        retired_by:   address,
        organisation: String,
        esg_reference:String,
        timestamp:    u64,
    }

    public struct CertificateIssued has copy, drop {
        certificate_id: ID,
        credit_id:      ID,
        project_id:     String,
        tonnes_kg:      u64,
        organisation:   String,
        timestamp:      u64,
    }

    public struct ConfigUpdated has copy, drop {
        admin:             address,
        fee_recipient:     address,
        protocol_fee_bps:  u64,
        timestamp:         u64,
    }

    // ── Initialization ────────────────────────────────────
    fun init(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);

        // Create admin cap → sent to deployer
        let admin_cap = AdminCap {
            id: object::new(ctx),
        };
        transfer::transfer(admin_cap, sender);

        // Create shared protocol config
        let config = ProtocolConfig {
            id:               object::new(ctx),
            admin:            sender,
            fee_recipient:    sender,   // Update via set_fee_recipient
            protocol_fee_bps: 200,      // 2% default
            total_minted_kg:  0,
            total_retired_kg: 0,
            total_credits:    0,
            paused:           false,
        };
        transfer::share_object(config);
    }

    // ── Mint a carbon credit ──────────────────────────────
    /// Called by the ATMOS backend after AI + ZK verification.
    /// Producer receives the CarbonCredit object in their wallet.
    ///
    /// Arguments:
    ///   project_id       — UUID from backend database
    ///   project_name     — Human-readable project name
    ///   tonnes_kg        — Amount in kg (1 tonne = 1000 kg). Use u64.
    ///   grade            — 0=D, 1=C, 2=B, 3=A, 4=S
    ///   methodology      — Standard code e.g. "VM0044"
    ///   vintage_year     — Year of CO2e reduction
    ///   confidence_score — 0–100 from AI model
    ///   zk_proof_hash    — Hash of Groth16 ZK proof
    ///   satellite_blob_id— Walrus blob storing Sentinel-2 imagery
    ///   recipient        — Address to receive the credit
    public entry fun mint_credit(
        config:           &mut ProtocolConfig,
        project_id:       String,
        project_name:     String,
        tonnes_kg:        u64,
        grade:            u8,
        methodology:      String,
        vintage_year:     u16,
        confidence_score: u8,
        zk_proof_hash:    String,
        satellite_blob_id:String,
        recipient:        address,
        clock:            &Clock,
        ctx:              &mut TxContext,
    ) {
        assert!(!config.paused, EProgramPaused);
        assert!(tonnes_kg > 0, EInvalidAmount);
        assert!(grade <= GRADE_S, EInvalidGrade);
        assert!(string::length(&zk_proof_hash) > 0, EInvalidProof);

        let now = clock::timestamp_ms(clock);
        let credit_uid = object::new(ctx);
        let credit_id  = object::uid_to_inner(&credit_uid);

        let credit = CarbonCredit {
            id:               credit_uid,
            project_id:       project_id,
            project_name:     project_name,
            producer:         tx_context::sender(ctx),
            tonnes_kg,
            grade,
            methodology,
            vintage_year,
            confidence_score,
            zk_proof_hash,
            satellite_blob_id,
            verification_time:now,
            retired:          false,
            retired_by:       @0x0,
            retired_at:       0,
            retirement_org:   string::utf8(b""),
            esg_reference:    string::utf8(b""),
        };

        // Update protocol stats
        config.total_minted_kg = config.total_minted_kg + tonnes_kg;
        config.total_credits   = config.total_credits + 1;

        // Emit event (auditable on-chain record)
        event::emit(CreditMinted {
            credit_id,
            project_id:    credit.project_id,
            producer:      credit.producer,
            tonnes_kg,
            grade,
            methodology:   credit.methodology,
            vintage_year,
            confidence:    confidence_score,
            zk_proof_hash: credit.zk_proof_hash,
            walrus_blob:   credit.satellite_blob_id,
            timestamp:     now,
        });

        // Transfer to recipient
        transfer::public_transfer(credit, recipient);
    }

    // ── Retire a credit ───────────────────────────────────
    /// Permanently retires a carbon credit and issues a certificate.
    /// Retirement is IRREVERSIBLE — sets retired=true on the object.
    /// The original credit stays in the owner's wallet but is marked retired.
    /// A RetirementCertificate NFT is minted and sent to the retiree.
    ///
    /// BRSR compliance: organisation_name and esg_reference are stored
    /// on-chain so auditors can verify corporate ESG claims.
    public entry fun retire_credit(
        config:            &mut ProtocolConfig,
        credit:            &mut CarbonCredit,
        organisation_name: String,
        esg_reference:     String,
        clock:             &Clock,
        ctx:               &mut TxContext,
    ) {
        assert!(!config.paused, EProgramPaused);
        assert!(!credit.retired, EAlreadyRetired);

        let retiree   = tx_context::sender(ctx);
        let now       = clock::timestamp_ms(clock);
        let credit_id = object::uid_to_inner(&credit.id);

        // Mutate the credit object permanently
        credit.retired       = true;
        credit.retired_by    = retiree;
        credit.retired_at    = now;
        credit.retirement_org= organisation_name;
        credit.esg_reference = esg_reference;

        // Update protocol stats
        config.total_retired_kg = config.total_retired_kg + credit.tonnes_kg;

        // Emit retirement event
        event::emit(CreditRetired {
            credit_id,
            credit_obj:    credit_id,
            project_id:    credit.project_id,
            tonnes_kg:     credit.tonnes_kg,
            grade:         credit.grade,
            retired_by:    retiree,
            organisation:  organisation_name,
            esg_reference,
            timestamp:     now,
        });

        // Mint retirement certificate NFT
        let cert_uid  = object::new(ctx);
        let cert_id   = object::uid_to_inner(&cert_uid);
        let cert_seq  = config.total_credits; // Use as sequential ID

        let certificate = RetirementCertificate {
            id:           cert_uid,
            credit_id,
            project_id:   credit.project_id,
            project_name: credit.project_name,
            tonnes_kg:    credit.tonnes_kg,
            grade:        credit.grade,
            methodology:  credit.methodology,
            vintage_year: credit.vintage_year,
            retired_by:   retiree,
            organisation: organisation_name,
            esg_reference,
            retired_at:   now,
            zk_proof_hash:credit.zk_proof_hash,
            certificate_seq: cert_seq,
        };

        event::emit(CertificateIssued {
            certificate_id: cert_id,
            credit_id,
            project_id:    credit.project_id,
            tonnes_kg:     credit.tonnes_kg,
            organisation:  organisation_name,
            timestamp:     now,
        });

        // Transfer certificate to retiree
        transfer::public_transfer(certificate, retiree);
    }

    // ── Admin: pause / unpause ────────────────────────────
    public entry fun pause(
        _cap:   &AdminCap,
        config: &mut ProtocolConfig,
        _ctx:   &mut TxContext,
    ) {
        config.paused = true;
    }

    public entry fun unpause(
        _cap:   &AdminCap,
        config: &mut ProtocolConfig,
        _ctx:   &mut TxContext,
    ) {
        config.paused = false;
    }

    // ── Admin: update fee config ──────────────────────────
    public entry fun set_fee_config(
        _cap:              &AdminCap,
        config:            &mut ProtocolConfig,
        new_fee_recipient: address,
        new_fee_bps:       u64,
        clock:             &Clock,
        ctx:               &mut TxContext,
    ) {
        config.fee_recipient    = new_fee_recipient;
        config.protocol_fee_bps = new_fee_bps;

        event::emit(ConfigUpdated {
            admin:            tx_context::sender(ctx),
            fee_recipient:    new_fee_recipient,
            protocol_fee_bps: new_fee_bps,
            timestamp:        clock::timestamp_ms(clock),
        });
    }

    // ── Read-only helpers ─────────────────────────────────
    public fun is_retired(credit: &CarbonCredit): bool {
        credit.retired
    }

    public fun get_tonnes(credit: &CarbonCredit): u64 {
        credit.tonnes_kg
    }

    public fun get_grade(credit: &CarbonCredit): u8 {
        credit.grade
    }

    public fun get_project_id(credit: &CarbonCredit): &String {
        &credit.project_id
    }

    public fun get_methodology(credit: &CarbonCredit): &String {
        &credit.methodology
    }

    public fun get_zk_proof(credit: &CarbonCredit): &String {
        &credit.zk_proof_hash
    }

    public fun get_walrus_blob(credit: &CarbonCredit): &String {
        &credit.satellite_blob_id
    }

    public fun get_confidence(credit: &CarbonCredit): u8 {
        credit.confidence_score
    }

    public fun grade_to_string(grade: u8): vector<u8> {
        if      (grade == GRADE_S) { b"S" }
        else if (grade == GRADE_A) { b"A" }
        else if (grade == GRADE_B) { b"B" }
        else if (grade == GRADE_C) { b"C" }
        else                       { b"D" }
    }

    public fun protocol_stats(config: &ProtocolConfig): (u64, u64, u64) {
        (config.total_minted_kg, config.total_retired_kg, config.total_credits)
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx)
    }
}
