#!/usr/bin/env bash
# Start a local anvil chain and deploy the Society contracts with a mock $WIF (prizes paid in $WIF;
# MOCK_FES=true deploys a second, mock prize token and the fixed-rate converter instead).
# Writes contracts/deployments/31337.json, which the API server reads via DEPLOYMENT_FILE.
#
#   ./scripts/local-chain.sh            # anvil on :8545 (1s blocks) + deploy
#
# Requires Foundry (forge, anvil) on PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RPC="${RPC_URL:-http://127.0.0.1:8545}"
# Anvil's well-known development key #0 (never use on a real network).
DEPLOYER_KEY="${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

if ! curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1; then
  echo "Starting anvil on $RPC"
  anvil --block-time 1 --silent > "$ROOT/.anvil.log" 2>&1 &
  echo $! > "$ROOT/.anvil.pid"
  for _ in $(seq 1 30); do
    curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

cd "$ROOT/contracts"
DEPLOY_MOCK_TOKENS=true \
MOCK_FES="${MOCK_FES:-false}" \
ENTRY_FEE="${ENTRY_FEE:-10000000000000000000}" \
EXTRA_LIFE_FEE="${EXTRA_LIFE_FEE:-500000000000000000000}" \
FIXED_RATE="${FIXED_RATE:-1000000000000000000}" \
FES_INVENTORY="${FES_INVENTORY:-1000000000000000000000000}" \
PRIVATE_KEY="$DEPLOYER_KEY" \
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow ${FORGE_FLAGS:-}

echo
echo "Deployed. Addresses: contracts/deployments/31337.json"
cat "$ROOT/contracts/deployments/31337.json"
