# Quai CLI Wallet

A command-line wallet for Quai Network built with TypeScript and quais.js.

## Features

- **HD Wallet**: BIP44-compliant hierarchical deterministic wallet (coinType 994)
- **Multi-zone support**: Generate addresses for any Quai zone (Cyprus, Paxos, Hydra)
- **Encrypted storage**: Mnemonic encrypted with AES-256-GCM using PBKDF2 key derivation
- **Balance tracking**: View available and locked (coinbase) balances
- **Transaction management**: Send, sign, and estimate gas for transactions
- **Multi-network**: Support for mainnet and orchard testnet
- **Standalone binary**: Can be packaged as a standalone executable

## Installation

### From source
```bash
cd cli-wallet
npm install
npm run build
```

### Build standalone executable
```bash
npm run package:mac      # macOS ARM64
npm run package:linux    # Linux x64
npm run package:win      # Windows x64
npm run package:all      # All platforms
```

The executable will be created in the `bin/` directory.

## Usage

Run with Node.js:
```bash
node dist/index.js <command> [options]
```

Or use the standalone binary:
```bash
./bin/quai-cli-wallet <command> [options]
```

### Wallet Management

#### Create a new wallet
```bash
quai-cli-wallet create
```
Creates a new HD wallet with a 12-word recovery phrase. **Save this phrase securely!**

#### Import existing wallet
```bash
quai-cli-wallet import
```
Import a wallet from an existing 12-word recovery phrase.

#### Delete wallet
```bash
quai-cli-wallet delete
```
Permanently delete the wallet. Requires double confirmation.

#### Show wallet info
```bash
quai-cli-wallet info
```
Display wallet information including network, address count, and zone distribution.

### Address Management

#### Generate new address
```bash
quai-cli-wallet new-address [zone]
```
Generate a new address for a specific zone. Defaults to `cyprus1` if no zone specified.

**Available zones:**
- `cyprus1`, `cyprus2`, `cyprus3`
- `paxos1`, `paxos2`, `paxos3`
- `hydra1`, `hydra2`, `hydra3`

Examples:
```bash
quai-cli-wallet new-address           # Creates cyprus1 address
quai-cli-wallet new-address cyprus1   # Creates cyprus1 address
quai-cli-wallet new-address paxos2    # Creates paxos2 address
```

#### List all addresses
```bash
quai-cli-wallet addresses
```

Filter by zone:
```bash
quai-cli-wallet addresses --zone cyprus1
```

### Balance Operations

#### Check single address balance
```bash
quai-cli-wallet balance <address>
```
Shows available, locked (coinbase rewards), and total balance.

#### Check total wallet balance
```bash
quai-cli-wallet total-balance
```
Shows balance for each address and grand total across all addresses.

### Transactions

#### Send QUAI
```bash
quai-cli-wallet send <from> <to> <amount>
```

The command will:
1. Check your balance
2. Estimate gas costs
3. Verify you have sufficient funds (amount + gas)
4. Ask for confirmation before sending

Send maximum balance (minus gas):
```bash
quai-cli-wallet send <from> <to> --max
# or
quai-cli-wallet send <from> <to> max
# or simply omit amount
quai-cli-wallet send <from> <to>
```

With custom gas limit:
```bash
quai-cli-wallet send <from> <to> <amount> --gas-limit 50000
```

#### Sign transaction (without broadcasting)
```bash
quai-cli-wallet sign <from> <to> <amount>
```
Returns the signed transaction hex for offline signing workflows.

### Network Management

#### Show current network
```bash
quai-cli-wallet network
```

#### Switch network
```bash
quai-cli-wallet network mainnet
quai-cli-wallet network orchard
```

**Available networks:**
| Network | RPC URL |
|---------|---------|
| mainnet | https://rpc.quai.network |
| orchard | https://rpc.orchard.quai.network |

### Key Export

#### Export private key
```bash
quai-cli-wallet export-key <address>
```
**Warning:** Exposes your private key. Use with caution!

## Environment Variables

| Variable | Description |
|----------|-------------|
| `QUAI_WALLET_PASSWORD` | Bypass interactive password prompt (for scripting) |
| `QUAI_WALLET_DIR` | Custom wallet data directory (default: `./quai-wallet-data`) |

Example:
```bash
export QUAI_WALLET_PASSWORD="your-password"
export QUAI_WALLET_DIR="/path/to/wallet"
```

## Data Storage

Wallet data is stored in `./quai-wallet-data/` (relative to where you run the command):

```
quai-wallet-data/
├── keystore.json   # Encrypted mnemonic + wallet state
└── config.json     # Network settings
```

### keystore.json structure
```json
{
  "encryptedMnemonic": "...",
  "salt": "...",
  "iv": "...",
  "authTag": "...",
  "walletData": {
    "version": 1,
    "phrase": "...",
    "coinType": 994,
    "addresses": [...]
  }
}
```

**Security notes:**
- The mnemonic is encrypted with AES-256-GCM; password is required to decrypt
- PBKDF2 with 100,000 iterations for key derivation
- Addresses and public keys are stored in plaintext (not secret)
- Private keys are derived at runtime from the mnemonic
- File permissions are set to 0600 (owner read/write only)

## Architecture

```
cli-wallet/
├── src/
│   ├── index.ts          # Entry point
│   ├── cli.ts            # Commander CLI definitions
│   ├── config.ts         # Network and path configuration
│   ├── storage.ts        # Wallet encryption/storage
│   └── wallet-service.ts # Core wallet operations
├── bin/                  # Standalone executables (after packaging)
├── quai-wallet-data/     # Wallet storage (created on first use)
├── package.json
└── tsconfig.json
```

### Key Components

**WalletService** (`wallet-service.ts`)
- Manages QuaiHDWallet instance
- Handles provider connections with zone routing (`usePathing: true`)
- Transaction building with gas estimation

**Storage** (`storage.ts`)
- AES-256-GCM encryption with PBKDF2 (100,000 iterations)
- Wallet serialization/deserialization
- Secure file operations

**CLI** (`cli.ts`)
- Commander-based command definitions
- Password prompting with hidden input (no echo)
- Zone name mapping

## Examples

### Complete workflow
```bash
# Create wallet
quai-cli-wallet create
# Save your 12-word phrase!

# Generate address (defaults to cyprus1)
quai-cli-wallet new-address

# Check balance (after receiving funds)
quai-cli-wallet balance 0x00...

# Send transaction
quai-cli-wallet send 0x00... 0x00... 1.5

# Send max balance
quai-cli-wallet send 0x00... 0x00... --max

# Check total across all addresses
quai-cli-wallet total-balance
```

### Scripted usage
```bash
export QUAI_WALLET_PASSWORD="mypassword"

# Generate addresses for all zones
for zone in cyprus1 cyprus2 cyprus3 paxos1 paxos2 paxos3 hydra1 hydra2 hydra3; do
  quai-cli-wallet new-address $zone
done

# Check all balances
quai-cli-wallet total-balance
```

## Dependencies

- **quais** (1.0.0-alpha.52) - Quai Network JavaScript SDK
- **commander** (^12.0.0) - CLI framework
- **typescript** (^5.3.0) - TypeScript compiler

## License

MIT
