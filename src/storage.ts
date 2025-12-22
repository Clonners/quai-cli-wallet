import * as fs from 'fs';
import * as crypto from 'crypto';
import {
    Mnemonic,
    QuaiHDWallet,
    randomBytes,
    Zone,
} from 'quais';
import { WALLET_DIR, KEYSTORE_FILE, CONFIG_FILE, DEFAULT_NETWORK } from './config';

// Type for serialized wallet data
type AllowedCoinType = 969 | 994;

interface SerializedQuaiHDWallet {
    version: number;
    phrase: string;
    coinType: AllowedCoinType;
    addresses: Array<{
        pubKey: string;
        address: string;
        account: number;
        index: number;
        zone: Zone;
    }>;
}

export interface WalletConfig {
    network: string;
    currentAddress?: string;
}

export interface StoredWallet {
    encryptedMnemonic: string; // AES-256-GCM encrypted mnemonic
    salt: string;
    iv: string;
    authTag: string;
    walletData: SerializedQuaiHDWallet; // serialized HD wallet state
}

function ensureWalletDir(): void {
    if (!fs.existsSync(WALLET_DIR)) {
        fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
    }
}

export function walletExists(): boolean {
    return fs.existsSync(KEYSTORE_FILE);
}

export function loadConfig(): WalletConfig {
    if (fs.existsSync(CONFIG_FILE)) {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        return JSON.parse(data);
    }
    return { network: DEFAULT_NETWORK };
}

export function saveConfig(config: WalletConfig): void {
    ensureWalletDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// Derive encryption key from password using PBKDF2
function deriveKey(password: string, salt: Buffer): Buffer {
    return crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');
}

// Encrypt mnemonic phrase
function encryptMnemonic(phrase: string, password: string): { encrypted: string; salt: string; iv: string; authTag: string } {
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    const key = deriveKey(password, salt);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(phrase, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return {
        encrypted,
        salt: salt.toString('hex'),
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
    };
}

// Decrypt mnemonic phrase
function decryptMnemonic(encrypted: string, password: string, salt: string, iv: string, authTag: string): string {
    const key = deriveKey(password, Buffer.from(salt, 'hex'));

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

// Strip sensitive data from serialized wallet before storage
function sanitizeWalletData(walletData: SerializedQuaiHDWallet): SerializedQuaiHDWallet {
    return {
        ...walletData,
        phrase: '', // Remove plaintext phrase - we store it encrypted separately
    };
}

export async function createWallet(password: string): Promise<{ wallet: QuaiHDWallet; mnemonic: string }> {
    ensureWalletDir();

    // Generate new mnemonic
    const mnemonic = Mnemonic.fromEntropy(randomBytes(16));

    // Create HD wallet
    const wallet = QuaiHDWallet.fromMnemonic(mnemonic);

    // Encrypt mnemonic phrase
    const { encrypted, salt, iv, authTag } = encryptMnemonic(mnemonic.phrase, password);

    // Serialize wallet state and remove plaintext phrase
    const walletData = sanitizeWalletData(wallet.serialize());

    const storedWallet: StoredWallet = {
        encryptedMnemonic: encrypted,
        salt,
        iv,
        authTag,
        walletData,
    };

    fs.writeFileSync(KEYSTORE_FILE, JSON.stringify(storedWallet, null, 2), { mode: 0o600 });

    // Save default config
    saveConfig({ network: DEFAULT_NETWORK });

    return { wallet, mnemonic: mnemonic.phrase };
}

export async function importWallet(phrase: string, password: string): Promise<QuaiHDWallet> {
    ensureWalletDir();

    // Parse mnemonic to validate it
    const mnemonic = Mnemonic.fromPhrase(phrase);

    // Create HD wallet
    const wallet = QuaiHDWallet.fromMnemonic(mnemonic);

    // Encrypt mnemonic phrase
    const { encrypted, salt, iv, authTag } = encryptMnemonic(phrase, password);

    // Serialize wallet state and remove plaintext phrase
    const walletData = sanitizeWalletData(wallet.serialize());

    const storedWallet: StoredWallet = {
        encryptedMnemonic: encrypted,
        salt,
        iv,
        authTag,
        walletData,
    };

    fs.writeFileSync(KEYSTORE_FILE, JSON.stringify(storedWallet, null, 2), { mode: 0o600 });

    // Save default config
    saveConfig({ network: DEFAULT_NETWORK });

    return wallet;
}

export async function loadWallet(password: string): Promise<QuaiHDWallet> {
    if (!walletExists()) {
        throw new Error('No wallet found. Create one with "quai-cli-wallet create" or import with "quai-cli-wallet import"');
    }

    const data = fs.readFileSync(KEYSTORE_FILE, 'utf8');
    const storedWallet: StoredWallet = JSON.parse(data);

    // Decrypt mnemonic to get the phrase
    let phrase: string;
    try {
        phrase = decryptMnemonic(
            storedWallet.encryptedMnemonic,
            password,
            storedWallet.salt,
            storedWallet.iv,
            storedWallet.authTag
        );
    } catch {
        throw new Error('Incorrect password');
    }

    // Restore the phrase in wallet data for deserialization
    const walletDataWithPhrase = {
        ...storedWallet.walletData,
        phrase,
    };

    // Deserialize wallet with stored addresses
    const wallet = await QuaiHDWallet.deserialize(walletDataWithPhrase);

    return wallet;
}

export async function saveWalletState(wallet: QuaiHDWallet, password: string): Promise<void> {
    if (!walletExists()) {
        throw new Error('No wallet found');
    }

    const data = fs.readFileSync(KEYSTORE_FILE, 'utf8');
    const storedWallet: StoredWallet = JSON.parse(data);

    // Verify password by attempting to decrypt
    try {
        decryptMnemonic(
            storedWallet.encryptedMnemonic,
            password,
            storedWallet.salt,
            storedWallet.iv,
            storedWallet.authTag
        );
    } catch {
        throw new Error('Incorrect password');
    }

    // Update wallet data (addresses, etc.) - sanitize to remove plaintext phrase
    storedWallet.walletData = sanitizeWalletData(wallet.serialize());

    fs.writeFileSync(KEYSTORE_FILE, JSON.stringify(storedWallet, null, 2), { mode: 0o600 });
}

/**
 * Save wallet state but only include specified addresses (plus existing ones)
 * Used by scan to avoid storing addresses without balance
 */
export async function saveWalletStateWithAddresses(
    wallet: QuaiHDWallet,
    password: string,
    addressesToKeep: Set<string>
): Promise<void> {
    if (!walletExists()) {
        throw new Error('No wallet found');
    }

    const data = fs.readFileSync(KEYSTORE_FILE, 'utf8');
    const storedWallet: StoredWallet = JSON.parse(data);

    // Verify password by attempting to decrypt
    try {
        decryptMnemonic(
            storedWallet.encryptedMnemonic,
            password,
            storedWallet.salt,
            storedWallet.iv,
            storedWallet.authTag
        );
    } catch {
        throw new Error('Incorrect password');
    }

    // Get existing addresses that were already stored
    const existingAddresses = new Set(storedWallet.walletData.addresses.map(a => a.address));

    // Serialize wallet and filter addresses
    const serialized = sanitizeWalletData(wallet.serialize());
    serialized.addresses = serialized.addresses.filter(
        addr => existingAddresses.has(addr.address) || addressesToKeep.has(addr.address)
    );

    storedWallet.walletData = serialized;

    fs.writeFileSync(KEYSTORE_FILE, JSON.stringify(storedWallet, null, 2), { mode: 0o600 });
}

export function deleteWallet(): void {
    if (fs.existsSync(KEYSTORE_FILE)) {
        fs.unlinkSync(KEYSTORE_FILE);
    }
    if (fs.existsSync(CONFIG_FILE)) {
        fs.unlinkSync(CONFIG_FILE);
    }
}
