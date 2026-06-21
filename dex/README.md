# @quai-wallet/dex-cli — Multi-DEX CLI for Quai Network

Universal CLI wallet for interacting with **any DEX on Quai Network** — supports UniswapV2, UniswapV3, and custom DEXes via config.

## Features

- ✅ **Multi-DEX support** — UniswapV2, UniswapV3, custom routers via config
- ✅ **Native QUAI** — balance, transfer, swap with native asset
- ✅ **Any ERC20 token** — balance, transfer, approve, allowance, info
- ✅ **Dry-run mode** — simulate swaps without executing
- ✅ **Gas estimation** — MetaMask-style with re-estimate and configurable buffer
- ✅ **Multi-shard** — switch shards via `QUAI_RPC` env var
- ✅ **Colored output** — with `NO_COLOR` override

## Installation

```bash
cd dex
npm install
```

## Configuration

Edit `config/dex.json`:

```json
{
  "tokens": {
    "WQUAI": {
      "address": "0x005c46f661Baef20671943f2b4c087Df3E7CEb13",
      "symbol": "WQUAI",
      "decimals": 18,
      "wrappedNative": true,
      "nativeAlias": "QUAI"
    }
  },
  "routers": {
    "my-dex-v2": {
      "address": "0xRouterAddress...",
      "type": "uniswap-v2"
    },
    "my-dex-v3": {
      "address": "0xRouterAddress...",
      "type": "uniswap-v3",
      "feeTiers": [500, 3000, 10000]
    }
  },
  "defaults": {
    "slippage": 0.05,
    "gasBuffer": 0.2,
    "rpc": "https://orchard.rpc.quai.network/cyprus1"
  }
}
```

## Supported DEX Types

| Type | Description | Quote Method | Swap Method |
|------|-------------|--------------|-------------|
| `uniswap-v2` | UniswapV2-compatible | `getAmountsOut` | `swapExactTokensForTokens` |
| `uniswap-v3` | UniswapV3-compatible | `quoteExactInputSingle` | `exactInputSingle` |
| `custom` | Custom ABI | Config-defined | Config-defined |

## Usage

### Native QUAI

```bash
node src/dex.js native balance
node src/dex.js native transfer 0xRecipient... 10
```

### Token Operations (ERC20)

```bash
# Balance
node src/dex.js token balance WQUAI
node src/dex.js token balance 0xAnyToken...

# Transfer
node src/dex.js token transfer WQUAI 0xRecipient... 10

# Approve spender
node src/dex.js token approve WQUAI 0xRouter... 1000

# Token info
node src/dex.js token info WQUAI
node src/dex.js token list
```

### DEX Operations

#### UniswapV2-compatible

```bash
# Quote
node src/dex.js router quote quaiswap-v2 WQUAI,WQI 1

# Swap
node src/dex.js router swap quaiswap-v2 WQUAI,WQI 1

# Native swap
node src/dex.js router swap quaiswap-v2 QUAI,WQI 1

# Dry run
node src/dex.js router swap quaiswap-v2 WQUAI,WQI 1 --dry-run
```

#### UniswapV3-compatible

```bash
# Quote with fee tier
node src/dex.js router quote quaiswap-v3 WQUAI,WQI 1 --fee=3000

# Swap with fee tier
node src/dex.js router swap quaiswap-v3 WQUAI,WQI 1 --fee=500

# Dry run
node src/dex.js router swap quaiswap-v3 WQUAI,WQI 1 --fee=10000 --dry-run
```

### CLI Flags

| Flag | Description |
|------|-------------|
| `--gas-buffer=X` | Gas buffer (0-1, default: 0.2 / 20%) |
| `--fee=X` | Fee tier for V3 DEXes (500 = 0.05%, 3000 = 0.3%, 10000 = 1%) |
| `--dry-run` | Simulate swap without executing |
| `--slippage=X` | Slippage tolerance (0-1, default: 0.05) |
| `--config=path` | Path to config file |

## Gas Estimation

MetaMask-style 3-step strategy:

1. **First attempt** — `quai_estimateGas`
2. **Re-estimate** — If transient failure, retries once after 2s
3. **Fallback** — If both fail, uses `DEFAULT_GAS_LIMIT` cap

## Security

- ✅ No private keys or mnemonics included
- ✅ Addresses in config are public testnet deployments
- ✅ Private key loaded from `QUAI_PRIVATE_KEY` env var only
- ✅ `.gitignore` excludes sensitive files

## License

MIT
