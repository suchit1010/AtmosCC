#!/bin/bash
# ──────────────────────────────────────────────────────────
# ATMOS Protocol — Dev Environment Setup
# ──────────────────────────────────────────────────────────

set -e

echo "🌱 ATMOS Protocol — Development Setup"
echo "══════════════════════════════════════════"

# ── 1. Install Rust + Sui CLI ─────────────────────────────
if ! command -v cargo &> /dev/null; then
    echo "📦 Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    source $HOME/.cargo/env
fi

if ! command -v sui &> /dev/null; then
    echo "📦 Installing Sui CLI (testnet branch)..."
    cargo install --locked \
        --git https://github.com/MystenLabs/sui.git \
        --branch testnet-v1.40.1 \
        sui
fi

echo "✅ Sui: $(sui --version)"

# ── 2. Configure Sui for testnet ─────────────────────────
echo ""
echo "🔗 Configuring Sui for testnet..."
sui client new-env --alias testnet --rpc https://fullnode.testnet.sui.io:443 || true
sui client switch --env testnet

# ── 3. Create wallet (if needed) ─────────────────────────
echo ""
echo "💼 Setting up wallet..."
if ! sui client active-address &>/dev/null; then
    sui client new-address ed25519
fi

ADDRESS=$(sui client active-address)
echo "   Address: $ADDRESS"

# ── 4. Get testnet SUI ────────────────────────────────────
echo ""
echo "🪙  Getting testnet SUI tokens..."
sui client faucet || echo "Faucet already used — check balance"
sleep 2
sui client gas

# ── 5. Install backend dependencies ──────────────────────
echo ""
echo "📦 Installing backend dependencies..."
cd backend
npm install
cd ..

# ── 6. Install mobile dependencies ───────────────────────
echo ""
echo "📱 Installing mobile dependencies..."
cd mobile
npm install
cd ..

# ── 7. Copy env files ─────────────────────────────────────
echo ""
if [[ ! -f "backend/.env" ]]; then
    cp backend/.env.example backend/.env
    echo "✅ backend/.env created from template"
    echo "   ⚠️  Edit backend/.env and add your keys"
fi

if [[ ! -f "mobile/.env.local" ]]; then
    cp mobile/.env.example mobile/.env.local
    echo "✅ mobile/.env.local created from template"
fi

# ── 8. Build Move contracts ───────────────────────────────
echo ""
echo "🔨 Building Move contracts..."
sui move build

echo ""
echo "🧪 Running tests..."
sui move test

echo ""
echo "══════════════════════════════════════════"
echo "✅  Dev setup complete!"
echo "══════════════════════════════════════════"
echo ""
echo "Next steps:"
echo "  1. Edit backend/.env (add API keys)"
echo "  2. Deploy to testnet: ./scripts/deploy_sui.sh testnet"
echo "  3. Start backend: cd backend && npm run dev"
echo "  4. Start mobile: cd mobile && npx expo start"
echo ""
echo "Your Sui address: $ADDRESS"
echo "Testnet faucet: https://faucet.testnet.sui.io"
echo ""
