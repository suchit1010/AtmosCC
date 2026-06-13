/**
 * ATMOS Protocol — Test: Mint a Carbon Credit on Sui
 * ─────────────────────────────────────────────────────
 * Run: npx ts-node scripts/mint_test_credit.ts
 *
 * This script demonstrates the full mint flow:
 *  1. Connect to Sui testnet
 *  2. Call carbon_credit::mint_credit()
 *  3. Display the created CarbonCredit object
 *  4. Verify on Sui Explorer
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair }            from '@mysten/sui/keypairs/ed25519';
import { Transaction }               from '@mysten/sui/transactions';
import { fromB64 }                   from '@mysten/sui/utils';
import dotenv from 'dotenv';

dotenv.config({ path: '../backend/.env' });

const PACKAGE_ID    = process.env.SUI_PACKAGE_ID!;
const CONFIG_OBJ_ID = process.env.SUI_CONFIG_OBJ_ID!;
const CLOCK_ID      = '0x6';

async function main() {
  console.log('\n🌱 ATMOS Protocol — Mint Test Credit on Sui');
  console.log('═══════════════════════════════════════════\n');

  if (!PACKAGE_ID || PACKAGE_ID === '0x0') {
    console.error('❌ SUI_PACKAGE_ID not set. Run ./scripts/deploy_sui.sh testnet first.');
    process.exit(1);
  }

  // ── Setup client ──────────────────────────────────────
  const network = (process.env.SUI_NETWORK || 'testnet') as any;
  const client  = new SuiClient({ url: getFullnodeUrl(network) });

  // ── Load keypair ──────────────────────────────────────
  let keypair: Ed25519Keypair;
  if (process.env.SUI_PRIVATE_KEY_B64) {
    keypair = Ed25519Keypair.fromSecretKey(fromB64(process.env.SUI_PRIVATE_KEY_B64));
  } else {
    keypair = Ed25519Keypair.generate();
    console.log('⚠️  Using ephemeral keypair (no SUI_PRIVATE_KEY_B64 set)');
  }

  const senderAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`💼 Wallet: ${senderAddress}`);

  // Check balance
  const balance = await client.getBalance({ owner: senderAddress });
  console.log(`💰 Balance: ${parseInt(balance.totalBalance) / 1e9} SUI\n`);

  if (parseInt(balance.totalBalance) < 1_000_000) {
    console.log('⚠️  Low balance. Getting testnet SUI...');
    // Request from faucet via CLI: sui client faucet
  }

  // ── Build mint transaction ─────────────────────────────
  const tx = new Transaction();

  console.log('🔨 Building mint transaction...');
  console.log('   Project: Gujarat Biochar Farm');
  console.log('   CO2e: 2.46 tonnes (2460 kg)');
  console.log('   Grade: A (3)');
  console.log('   Methodology: VM0044\n');

  tx.moveCall({
    target: `${PACKAGE_ID}::carbon_credit::mint_credit`,
    arguments: [
      tx.object(CONFIG_OBJ_ID),
      tx.pure.string('proj-test-001'),
      tx.pure.string('Gujarat Biochar Farm'),
      tx.pure.u64(2460),              // 2.46 tonnes in kg
      tx.pure.u8(3),                  // Grade A
      tx.pure.string('VM0044'),
      tx.pure.u16(2025),
      tx.pure.u8(87),                 // 87% confidence
      tx.pure.string('zk_abc123def456789'),
      tx.pure.string('walrus_ndvi_blob_xyz'),
      tx.pure.address(senderAddress), // Mint to self for test
      tx.object(CLOCK_ID),
    ],
  });

  // ── Execute ────────────────────────────────────────────
  console.log('📡 Submitting to Sui testnet...\n');

  try {
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer:      keypair,
      options:     { showObjectChanges: true, showEvents: true, showEffects: true },
    });

    if (result.effects?.status?.status !== 'success') {
      console.error('❌ Transaction failed:', result.effects?.status?.error);
      process.exit(1);
    }

    // Find the created CarbonCredit object
    const createdObjs = result.objectChanges?.filter(
      (c) => c.type === 'created' && (c as any).objectType?.includes('CarbonCredit')
    ) || [];

    const creditObjectId = createdObjs[0] ? (createdObjs[0] as any).objectId : 'not found';

    console.log('═══════════════════════════════════════════');
    console.log('✅  CARBON CREDIT MINTED ON SUI!');
    console.log('═══════════════════════════════════════════\n');
    console.log(`  Transaction: ${result.digest}`);
    console.log(`  Credit Object ID: ${creditObjectId}`);
    console.log(`  Owner: ${senderAddress}`);
    console.log(`  Network: ${network}\n`);
    console.log(`  🔍 Explorer:`);
    console.log(`  https://suiexplorer.com/txblock/${result.digest}?network=${network}`);
    console.log(`  https://suiexplorer.com/object/${creditObjectId}?network=${network}\n`);

    // Show events
    if (result.events && result.events.length > 0) {
      console.log('📡 Events emitted:');
      result.events.forEach(e => {
        console.log(`  - ${e.type.split('::').pop()}`);
        if (e.parsedJson) {
          const j = e.parsedJson as any;
          if (j.tonnes_kg) console.log(`    CO2e: ${j.tonnes_kg / 1000} tonnes`);
          if (j.grade)     console.log(`    Grade: ${['D','C','B','A','S'][j.grade]}`);
          if (j.zk_proof_hash) console.log(`    ZK Hash: ${j.zk_proof_hash.slice(0, 16)}...`);
        }
      });
    }

    console.log('\n🎉 Success! The CarbonCredit is now in your Sui wallet.');
    console.log('   Next: run retire test or list on marketplace\n');

  } catch (err: any) {
    console.error('❌ Error:', err.message);
    if (err.message?.includes('InsufficientCoinBalance')) {
      console.error('   Run: sui client faucet (then wait 60 seconds)');
    }
    process.exit(1);
  }
}

main().catch(console.error);
