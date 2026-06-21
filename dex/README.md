# @quai-wallet/dex-cli — Generic DEX & Token CLI

Generic CLI wallet for interacting with **any ERC20 token**, **native QUAI**, and **any UniswapV2-compatible router** on Quai Network.

## Features

- ✅ Native QUAI: balance, transfer
- ✅ Any ERC20 token: balance, transfer, approve, allowance, info
- ✅ Any UniswapV2-compatible router: quote, swap
- ✅ Native ↔ token swaps (QUAI → token, token → QUAI)
- ✅ Token/router registry in `config/dex.json`
- ✅ Dry-run mode for swaps
- ✅ Explorer links
- ✅ Multi-shard support via `QUAI_RPC` env var
- ✅ No wallet extension needed — uses private key from env

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
    },
    "WQI": {
      "address": "0x002b2596EcF05C93a31ff916E8b456DF6C77c750",
      "symbol": "WQI",
      "decimals": 18,
      "wrappedNative": true,
      "nativeAlias": "QI"
    }
  },
  "routers": {
    "quaiswap": {
      "address": "0x0044E4779b3e1C88f931DE4940bC87C1a85628c3",
      "type": "uniswap-v2"
    }
  },
  "defaults": {
    "slippage": 0.05,
    "deadlineSec": 3600,
    "gasLimit": 500000,
    "gasBuffer": 0.2,
    "rpc": "https://orchard.rpc.quai.network/cyprus1",
    "explorer": "https://testnet.explorer.quai.network/tx/"
  }
}
```

### Defaults

| Option | Default | Description |
|--------|---------|-------------|
| `slippage` | `0.05` | Slippage tolerance (5%) |
| `deadlineSec` | `3600` | Transaction deadline (1 hour) |
| `gasLimit` | `500000` | Maximum gas limit cap |
| `gasBuffer` | `0.2` | Gas buffer multiplier (20%, like MetaMask) |
| `rpc` | `orchard.rpc.quai.network/cyprus1` | RPC endpoint |
| `explorer` | `testnet.explorer.quai.network/tx/` | Block explorer |

### Gas Estimation (MetaMask-style)

The CLI uses a 3-step gas estimation strategy matching MetaMask:

1. **First attempt** — `quai_estimateGas`
2. **Re-estimate** — If transient failure (timeout, network error), retries once after 2s
3. **Fallback** — If both fail or estimate exceeds cap, uses `DEFAULT_GAS_LIMIT`

Non-retryable errors (contract revert, out of gas) skip re-estimate and use the cap directly.

## Usage

```bash
node src/dex.js <command> [subcommand] [args]
```

### Native QUAI

```bash
node src/dex.js native balance
node src/dex.js native transfer 0xRecipient... 10
```

### Token (any ERC20)

```bash
# Check balance
node src/dex.js token balance WQUAI
node src/dex.js token balance 0xAnyToken...
node src/dex.js token balance WQUAI 0xOwnerAddress...  # anyone's balance

# Transfer
node src/dex.js token transfer WQUAI 0xRecipient... 10

# Approve spender
node src/dex.js token approve WQUAI 0xRouter... 1000

# Check allowance
node src/dex.js token allowance WQUAI 0xSpender...

# Token info
node src/dex.js token info WQUAI

# List all tokens
node src/dex.js token list
```

### Router (any UniswapV2-compatible)

```bash
# Token → Token
node src/dex.js router quote quaiswap WQUAI,WQI 1
node src/dex.js router swap quaiswap WQUAI,WQI 1

# Native → Token (QUAI keyword)
node src/dex.js router swap quaiswap QUAI,WQI 1

# Token → Native (QUAI keyword)
node src/dex.js router swap quaiswap WQI,QUAI 1

# Dry run (no actual transaction)
node src/dex.js router swap quaiswap QUAI,WQI 1 --dry-run

# Custom params
node src/dex.js router swap quaiswap WQUAI,WQI 1 0.9 3600 500000

# List all routers
node src/dex.js router list
```

### Shortcuts

```bash
node src/dex.js balances  # All balances (native + tokens)
```

## Multi-Shard

```bash
QUAI_RPC=https://orchard.rpc.quai.network/cyprus2 node src/dex.js token balance WQUAI
```

## Adding New Tokens

Add to `config/dex.json`:

```json
"NEW": {
  "address": "0xYourToken...",
  "symbol": "NEW",
  "decimals": 18,
  "wrappedNative": false
}
```

For native tokens, add `nativeAlias` to enable native swap support:

```json
"WQUAI": {
  "address": "...",
  "symbol": "WQUAI",
  "decimals": 18,
  "wrappedNative": true,
  "nativeAlias": "QUAI"  // enables 'QUAI' keyword in router paths
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `QUAI_PRIVATE_KEY` | Wallet private key (hex, with `0x` prefix) |
| `QUAI_RPC` | Override RPC endpoint |
| `NO_COLOR` | Set to `1` to disable ANSI colors |

## CLI Flags

| Flag | Description |
|------|-------------|
| `--gas-buffer=X` | Gas buffer multiplier (0-1, default: 0.2 / 20%) |
| `--slippage=X` | Slippage tolerance (0-1, default: 0.05 / 5%) |
| `--dry-run` | Simulate swap without executing |
| `--config=path` | Path to config file |

## Security

- ⚠️ Never commit your private key or `.env` file
- ⚠️ The config file contains public testnet addresses — safe to share
- ⚠️ Use `--dry-run` before executing real swaps

## License

MIT
