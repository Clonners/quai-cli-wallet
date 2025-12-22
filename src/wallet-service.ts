import {
    QuaiHDWallet,
    JsonRpcProvider,
    Zone,
    formatQuai,
    parseQuai,
    getZoneForAddress,
    type TransactionResponse,
} from 'quais';
import { NETWORKS, type NetworkConfig } from './config';
import { loadConfig, saveConfig, loadWallet, saveWalletState, saveWalletStateWithAddresses, type WalletConfig } from './storage';

// Transaction request interface for Quai
interface QuaiTxRequest {
    from: string;
    to?: string;
    value?: bigint;
    nonce?: number;
    gasLimit?: bigint;
    gasPrice?: bigint;
    data?: string;
}

export class WalletService {
    private wallet: QuaiHDWallet | null = null;
    private provider: JsonRpcProvider | null = null;
    private config: WalletConfig;
    private password: string = '';

    constructor() {
        this.config = loadConfig();
    }

    get currentNetwork(): NetworkConfig {
        return NETWORKS[this.config.network] || NETWORKS['orchard'];
    }

    get networkName(): string {
        return this.config.network;
    }

    async initialize(password: string): Promise<void> {
        this.password = password;
        this.wallet = await loadWallet(password);
        // usePathing: true is required for proper zone routing
        this.provider = new JsonRpcProvider(this.currentNetwork.rpcUrl, undefined, { usePathing: true });
        this.wallet.connect(this.provider);
    }

    setNetwork(network: string): void {
        if (!NETWORKS[network]) {
            throw new Error(`Unknown network: ${network}. Available: ${Object.keys(NETWORKS).join(', ')}`);
        }
        this.config.network = network;
        saveConfig(this.config);

        // Reconnect provider if initialized
        if (this.wallet) {
            this.provider = new JsonRpcProvider(this.currentNetwork.rpcUrl, undefined, { usePathing: true });
            this.wallet.connect(this.provider);
        }
    }

    async generateAddress(zone: Zone): Promise<{ address: string; zone: Zone }> {
        if (!this.wallet) {
            throw new Error('Wallet not initialized');
        }

        const addressInfo = await this.wallet.getNextAddress(0, zone);

        // Save wallet state with new address
        await saveWalletState(this.wallet, this.password);

        // Update current address in config
        this.config.currentAddress = addressInfo.address;
        saveConfig(this.config);

        return {
            address: addressInfo.address,
            zone: addressInfo.zone,
        };
    }

    getAddresses(): Array<{ address: string; zone: Zone }> {
        if (!this.wallet) {
            throw new Error('Wallet not initialized');
        }

        const serialized = this.wallet.serialize();
        return serialized.addresses.map((addr) => ({
            address: addr.address,
            zone: addr.zone as Zone,
        }));
    }

    getAddressesForZone(zone: Zone): Array<{ address: string; zone: Zone }> {
        if (!this.wallet) {
            throw new Error('Wallet not initialized');
        }

        return this.wallet.getAddressesForZone(zone).map((addr) => ({
            address: addr.address,
            zone: addr.zone,
        }));
    }

    async getBalance(address: string): Promise<{ balance: string; balanceWei: bigint }> {
        if (!this.provider) {
            throw new Error('Provider not initialized');
        }

        const balanceWei = await this.provider.getBalance(address);
        return {
            balance: formatQuai(balanceWei),
            balanceWei,
        };
    }

    async getLockedBalance(address: string): Promise<{ balance: string; balanceWei: bigint }> {
        if (!this.provider) {
            throw new Error('Provider not initialized');
        }

        const balanceWei = await this.provider.getLockedBalance(address);
        return {
            balance: formatQuai(balanceWei),
            balanceWei,
        };
    }

    async getTotalBalance(address: string): Promise<{
        available: string;
        locked: string;
        total: string;
        availableWei: bigint;
        lockedWei: bigint;
        totalWei: bigint;
    }> {
        const [available, locked] = await Promise.all([
            this.getBalance(address),
            this.getLockedBalance(address),
        ]);

        const totalWei = available.balanceWei + locked.balanceWei;

        return {
            available: available.balance,
            locked: locked.balance,
            total: formatQuai(totalWei),
            availableWei: available.balanceWei,
            lockedWei: locked.balanceWei,
            totalWei,
        };
    }

    async estimateGas(tx: QuaiTxRequest): Promise<bigint> {
        if (!this.provider) {
            throw new Error('Provider not initialized');
        }

        return await this.provider.estimateGas(tx as any);
    }

    async getGasPrice(address: string): Promise<bigint> {
        if (!this.provider) {
            throw new Error('Provider not initialized');
        }

        const zone = getZoneForAddress(address);
        if (!zone) {
            throw new Error('Could not determine zone from address');
        }
        const feeData = await this.provider.getFeeData(zone);
        return feeData.gasPrice || 0n;
    }

    async getNonce(address: string): Promise<number> {
        if (!this.provider) {
            throw new Error('Provider not initialized');
        }

        return await this.provider.getTransactionCount(address, 'pending');
    }

    async sendTransaction(
        from: string,
        to: string,
        amount: string,
        options?: {
            gasLimit?: bigint;
            gasPrice?: bigint;
        }
    ): Promise<TransactionResponse> {
        if (!this.wallet || !this.provider) {
            throw new Error('Wallet not initialized');
        }

        const value = parseQuai(amount);
        const nonce = await this.getNonce(from);
        const gasPrice = options?.gasPrice || await this.getGasPrice(from);

        const tx: QuaiTxRequest = {
            from,
            to,
            value,
            nonce,
            gasPrice,
        };

        // Estimate gas if not provided
        if (options?.gasLimit) {
            tx.gasLimit = options.gasLimit;
        } else {
            const estimatedGas = await this.estimateGas(tx);
            tx.gasLimit = (estimatedGas * 120n) / 100n; // Add 20% buffer
        }

        return await this.wallet.sendTransaction(tx as any);
    }

    async signTransaction(
        from: string,
        to: string,
        amount: string,
        options?: {
            gasLimit?: bigint;
            gasPrice?: bigint;
        }
    ): Promise<string> {
        if (!this.wallet || !this.provider) {
            throw new Error('Wallet not initialized');
        }

        const value = parseQuai(amount);
        const nonce = await this.getNonce(from);
        const gasPrice = options?.gasPrice || await this.getGasPrice(from);

        const tx: QuaiTxRequest = {
            from,
            to,
            value,
            nonce,
            gasPrice,
        };

        // Estimate gas if not provided
        if (options?.gasLimit) {
            tx.gasLimit = options.gasLimit;
        } else {
            const estimatedGas = await this.estimateGas(tx);
            tx.gasLimit = (estimatedGas * 120n) / 100n; // Add 20% buffer
        }

        return await this.wallet.signTransaction(tx as any);
    }

    getPrivateKey(address: string): string {
        if (!this.wallet) {
            throw new Error('Wallet not initialized');
        }

        return this.wallet.getPrivateKey(address);
    }

    getCurrentAddress(): string | undefined {
        return this.config.currentAddress;
    }

    setCurrentAddress(address: string): void {
        this.config.currentAddress = address;
        saveConfig(this.config);
    }

    /**
     * Scan for addresses with balance (useful for wallet recovery)
     * Generates addresses sequentially and checks their balance
     * Only stores addresses that have a non-zero balance
     */
    async scanAddresses(
        count: number,
        zone: Zone,
        onProgress?: (current: number, total: number, address: string, hasBalance: boolean) => void
    ): Promise<Array<{ address: string; zone: Zone; balance: string; balanceWei: bigint }>> {
        if (!this.wallet || !this.provider) {
            throw new Error('Wallet not initialized');
        }

        const foundAddresses: Array<{ address: string; zone: Zone; balance: string; balanceWei: bigint }> = [];

        // Get existing addresses to avoid re-checking them
        const existingAddresses = new Set(this.getAddresses().map(a => a.address));

        for (let i = 0; i < count; i++) {
            // Generate next address for the zone
            const addressInfo = await this.wallet.getNextAddress(0, zone);

            // Skip if already in wallet
            if (existingAddresses.has(addressInfo.address)) {
                continue;
            }

            // Check balance
            const balanceWei = await this.provider.getBalance(addressInfo.address);
            const hasBalance = balanceWei > 0n;

            if (onProgress) {
                onProgress(i + 1, count, addressInfo.address, hasBalance);
            }

            if (hasBalance) {
                foundAddresses.push({
                    address: addressInfo.address,
                    zone: addressInfo.zone,
                    balance: formatQuai(balanceWei),
                    balanceWei,
                });
            }
        }

        // Save wallet state - only include addresses with balance (plus existing ones)
        if (foundAddresses.length > 0) {
            const addressSet = new Set(foundAddresses.map(a => a.address));
            await saveWalletStateWithAddresses(this.wallet, this.password, addressSet);

            // Set the first found address as current if none set
            if (!this.config.currentAddress) {
                this.config.currentAddress = foundAddresses[0].address;
                saveConfig(this.config);
            }
        }

        return foundAddresses;
    }
}
