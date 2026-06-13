/// ATMOS Protocol — Move Tests
/// Tests for carbon_credit module: mint, retire, admin operations

#[test_only]
module atmos_cc::carbon_credit_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::clock;
    use std::string;
    use atmos_cc::carbon_credit::{Self, AdminCap, ProtocolConfig, CarbonCredit, RetirementCertificate};

    // ── Test addresses ────────────────────────────────────
    const ADMIN:    address = @0xA;
    const PRODUCER: address = @0xB;
    const BUYER:    address = @0xC;
    const ORG:      address = @0xD;

    // ── Helper: initialize protocol ───────────────────────
    fun setup(scenario: &mut Scenario) {
        ts::next_tx(scenario, ADMIN);
        {
            carbon_credit::init_for_testing(ts::ctx(scenario));
        };
    }

    // ── Test 1: Mint a credit ─────────────────────────────
    #[test]
    fun test_mint_credit() {
        let mut scenario = ts::begin(ADMIN);
        setup(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut config = ts::take_shared<ProtocolConfig>(&scenario);
            let clock      = clock::create_for_testing(ts::ctx(&mut scenario));

            carbon_credit::mint_credit(
                &mut config,
                string::utf8(b"proj-001"),
                string::utf8(b"Biochar Farm Gujarat"),
                2460,   // 2.46 tCO2e in kg
                3,      // Grade A
                string::utf8(b"VM0044"),
                2025,
                87,     // 87% confidence
                string::utf8(b"zk_abc123def456"),
                string::utf8(b"walrus_blob_xyz789"),
                PRODUCER,
                &clock,
                ts::ctx(&mut scenario),
            );

            let (total_minted, total_retired, total_count) = carbon_credit::protocol_stats(&config);
            assert!(total_minted == 2460, 0);
            assert!(total_retired == 0, 1);
            assert!(total_count == 1, 2);

            clock::destroy_for_testing(clock);
            ts::return_shared(config);
        };

        // Verify producer received the credit
        ts::next_tx(&mut scenario, PRODUCER);
        {
            let credit = ts::take_from_sender<CarbonCredit>(&scenario);
            assert!(carbon_credit::get_tonnes(&credit) == 2460, 3);
            assert!(carbon_credit::get_grade(&credit) == 3, 4);
            assert!(!carbon_credit::is_retired(&credit), 5);
            ts::return_to_sender(&scenario, credit);
        };

        ts::end(scenario);
    }

    // ── Test 2: Retire a credit ───────────────────────────
    #[test]
    fun test_retire_credit() {
        let mut scenario = ts::begin(ADMIN);
        setup(&mut scenario);

        // Mint
        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut config = ts::take_shared<ProtocolConfig>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            carbon_credit::mint_credit(
                &mut config,
                string::utf8(b"proj-002"),
                string::utf8(b"Agroforestry Maharashtra"),
                5000,
                3,
                string::utf8(b"VM0047"),
                2025,
                92,
                string::utf8(b"zk_retire_test"),
                string::utf8(b"walrus_retire_blob"),
                BUYER,
                &clock,
                ts::ctx(&mut scenario),
            );
            clock::destroy_for_testing(clock);
            ts::return_shared(config);
        };

        // Retire
        ts::next_tx(&mut scenario, BUYER);
        {
            let mut config = ts::take_shared<ProtocolConfig>(&scenario);
            let mut credit = ts::take_from_sender<CarbonCredit>(&scenario);
            let clock      = clock::create_for_testing(ts::ctx(&mut scenario));

            carbon_credit::retire_credit(
                &mut config,
                &mut credit,
                string::utf8(b"Tata Motors Ltd"),
                string::utf8(b"ESG-2025-Q4-001"),
                &clock,
                ts::ctx(&mut scenario),
            );

            assert!(carbon_credit::is_retired(&credit), 6);

            let (_, total_retired, _) = carbon_credit::protocol_stats(&config);
            assert!(total_retired == 5000, 7);

            clock::destroy_for_testing(clock);
            ts::return_shared(config);
            ts::return_to_sender(&scenario, credit);
        };

        // Verify certificate was issued
        ts::next_tx(&mut scenario, BUYER);
        {
            let _cert = ts::take_from_sender<RetirementCertificate>(&scenario);
            ts::return_to_sender(&scenario, _cert);
        };

        ts::end(scenario);
    }

    // ── Test 3: Cannot retire twice ───────────────────────
    #[test]
    #[expected_failure(abort_code = atmos_cc::carbon_credit::EAlreadyRetired)]
    fun test_cannot_retire_twice() {
        let mut scenario = ts::begin(ADMIN);
        setup(&mut scenario);

        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut config = ts::take_shared<ProtocolConfig>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            carbon_credit::mint_credit(
                &mut config,
                string::utf8(b"proj-003"),
                string::utf8(b"Solar Farm Rajasthan"),
                1000,
                2,
                string::utf8(b"AMS-I.D"),
                2025,
                80,
                string::utf8(b"zk_solar"),
                string::utf8(b"walrus_solar"),
                PRODUCER,
                &clock,
                ts::ctx(&mut scenario),
            );
            clock::destroy_for_testing(clock);
            ts::return_shared(config);
        };

        // First retirement - should succeed
        ts::next_tx(&mut scenario, PRODUCER);
        {
            let mut config = ts::take_shared<ProtocolConfig>(&scenario);
            let mut credit = ts::take_from_sender<CarbonCredit>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            carbon_credit::retire_credit(
                &mut config, &mut credit,
                string::utf8(b"Corp A"), string::utf8(b"REF-1"),
                &clock, ts::ctx(&mut scenario),
            );
            clock::destroy_for_testing(clock);
            ts::return_shared(config);
            ts::return_to_sender(&scenario, credit);
        };

        // Second retirement - should FAIL with EAlreadyRetired
        ts::next_tx(&mut scenario, PRODUCER);
        {
            let mut config = ts::take_shared<ProtocolConfig>(&scenario);
            let mut credit = ts::take_from_sender<CarbonCredit>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            carbon_credit::retire_credit(
                &mut config, &mut credit,
                string::utf8(b"Corp B"), string::utf8(b"REF-2"),
                &clock, ts::ctx(&mut scenario),
            );
            clock::destroy_for_testing(clock);
            ts::return_shared(config);
            ts::return_to_sender(&scenario, credit);
        };

        ts::end(scenario);
    }

    // ── Test 4: Admin pause ───────────────────────────────
    #[test]
    #[expected_failure(abort_code = atmos_cc::carbon_credit::EProgramPaused)]
    fun test_pause_prevents_mint() {
        let mut scenario = ts::begin(ADMIN);
        setup(&mut scenario);

        // Pause the protocol
        ts::next_tx(&mut scenario, ADMIN);
        {
            let cap    = ts::take_from_sender<AdminCap>(&scenario);
            let mut config = ts::take_shared<ProtocolConfig>(&scenario);
            carbon_credit::pause(&cap, &mut config, ts::ctx(&mut scenario));
            ts::return_to_sender(&scenario, cap);
            ts::return_shared(config);
        };

        // Try to mint — should FAIL with EProgramPaused
        ts::next_tx(&mut scenario, ADMIN);
        {
            let mut config = ts::take_shared<ProtocolConfig>(&scenario);
            let clock = clock::create_for_testing(ts::ctx(&mut scenario));
            carbon_credit::mint_credit(
                &mut config,
                string::utf8(b"proj-paused"),
                string::utf8(b"Should Fail"),
                1000, 3,
                string::utf8(b"VM0044"),
                2025, 85,
                string::utf8(b"zk_hash"),
                string::utf8(b"walrus_blob"),
                PRODUCER,
                &clock,
                ts::ctx(&mut scenario),
            );
            clock::destroy_for_testing(clock);
            ts::return_shared(config);
        };

        ts::end(scenario);
    }

    // ── Test 5: Grade byte conversion ─────────────────────
    #[test]
    fun test_grade_to_string() {
        assert!(carbon_credit::grade_to_string(4) == b"S", 0);
        assert!(carbon_credit::grade_to_string(3) == b"A", 1);
        assert!(carbon_credit::grade_to_string(2) == b"B", 2);
        assert!(carbon_credit::grade_to_string(1) == b"C", 3);
        assert!(carbon_credit::grade_to_string(0) == b"D", 4);
    }
}
