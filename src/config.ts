import * as path from 'path';

export interface NetworkConfig {
    name: string;
    rpcUrl: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
    mainnet: {
        name: 'Quai Mainnet',
        rpcUrl: 'https://rpc.quai.network',
    },
    orchard: {
        name: 'Orchard Testnet',
        rpcUrl: 'https://rpc.orchard.quai.network',
    },
};

export const DEFAULT_NETWORK = 'mainnet';

// Use QUAI_WALLET_DIR env var, or current working directory + quai-wallet-data
// This allows the binary to work when packaged (can't write to __dirname in pkg snapshot)
export const WALLET_DIR = process.env.QUAI_WALLET_DIR || path.join(process.cwd(), 'quai-wallet-data');
export const KEYSTORE_FILE = path.join(WALLET_DIR, 'keystore.json');
export const CONFIG_FILE = path.join(WALLET_DIR, 'config.json');
