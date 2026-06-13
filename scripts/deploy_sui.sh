#!/bin/bash
# ──────────────────────────────────────────────────────────
# ATMOS Protocol — Sui Deployment Script
# ──────────────────────────────────────────────────────────
# Usage:
#   chmod +x scripts/deploy_sui.sh
#   ./scripts/deploy_sui.sh testnet   # Deploy to testnet
#   ./scripts/deploy_sui.sh mainnet   # Deploy to mainnet (requires audit)
# ──────────────────────────────────────────────────────────

set -e

NETWORK=${1:-testnet}
echo "🌍 ATMOS Protocol — Deploying to Sui $NETWORK"
echo "─────────────────────────────────────────────────────"

# ── 1. Check prerequisites ───────────────────────────────
echo "⚙️  Checking Sui CLI..."
if ! command -v sui &> /dev/null; then
    echo "❌ Sui CLI not found. Install with:"
    echo "   cargo install --locked --git https://github.com/MystenLabs/sui.git --branch $NETWORK sui"
    exit 1
fi

echo "✅ Sui CLI: $(sui --version)"

# ── 2. Switch to correct network ─────────────────────────
echo ""
echo "🔗 Switching to $NETWORK..."
sui client switch --env $NETWORK

# ── 3. Check wallet and balance ──────────────────────────
echo ""
echo "💼 Active wallet:"
sui client active-address

echo ""
echo "💰 Balance:"
sui client gas

# ── 4. Get SUI for gas (testnet/devnet only) ─────────────
if [[ "$NETWORK" == "testnet" || "$NETWORK" == "devnet" ]]; then
    echo ""
    echo "🪙  Requesting testnet SUI for gas..."
    sui client faucet || echo "Faucet failed — you may already have sufficient balance"
fi

# ── 5. Build Move contracts ───────────────────────────────
echo ""
echo "🔨 Building Move contracts..."
sui move build

echo "✅ Build successful"

# ── 6. Run tests ──────────────────────────────────────────
echo ""
echo "🧪 Running Move tests..."
sui move test

echo "✅ All tests passed"

# ── 7. Publish package ───────────────────────────────────
echo ""
echo "🚀 Publishing ATMOS protocol on Sui $NETWORK..."
echo "   Gas budget: 100,000,000 MIST"
echo ""

PUBLISH_OUTPUT=$(sui client publish \
    --gas-budget 100000000 \
    --json)

echo "$PUBLISH_OUTPUT" > deploy_result_$NETWORK.json

# ── 8. Extract deployed addresses ─────────────────────────
echo ""
echo "📋 Extracting deployment addresses..."

PACKAGE_ID=$(echo "$PUBLISH_OUTPUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
effects = data.get('effects', {})
for obj in effects.get('created', []):
    if obj.get('owner') == 'Immutable':
        print(obj['reference']['objectId'])
        break
" 2>/dev/null || echo "PARSE_ERROR")

CONFIG_ID=$(echo "$PUBLISH_OUTPUT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
effects = data.get('effects', {})
for obj in effects.get('created', []):
    if isinstance(obj.get('owner'), dict) and 'Shared' in obj.get('owner', {}):
        print(obj['reference']['objectId'])
        break
" 2>/dev/null || echo "PARSE_ERROR")

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅  ATMOS DEPLOYED SUCCESSFULLY"
echo "═══════════════════════════════════════════════════════"
echo ""
echo "  Network:      $NETWORK"
echo "  Package ID:   $PACKAGE_ID"
echo "  Config Obj:   $CONFIG_ID"
echo "  Explorer:     https://suiexplorer.com/object/$PACKAGE_ID?network=$NETWORK"
echo ""
echo "═══════════════════════════════════════════════════════"
echo ""
echo "📝 Add these to your .env file:"
echo ""
echo "  SUI_PACKAGE_ID=$PACKAGE_ID"
echo "  SUI_CONFIG_OBJ_ID=$CONFIG_ID"
echo ""

# ── 9. Update .env automatically ─────────────────────────
if [[ -f "backend/.env" ]]; then
    sed -i.bak "s|SUI_PACKAGE_ID=.*|SUI_PACKAGE_ID=$PACKAGE_ID|" backend/.env
    sed -i.bak "s|SUI_CONFIG_OBJ_ID=.*|SUI_CONFIG_OBJ_ID=$CONFIG_ID|" backend/.env
    echo "✅ backend/.env updated automatically"
fi

echo ""
echo "🎉 Deployment complete! Next steps:"
echo "   1. Verify on explorer: https://suiexplorer.com/object/$PACKAGE_ID?network=$NETWORK"
echo "   2. Update mobile app env with new addresses"
echo "   3. Run a test mint: npm run test:e2e"
echo ""
