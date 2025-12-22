import { Command } from 'commander';
import * as readline from 'readline';
import { Zone, formatQuai, parseQuai } from 'quais';
import { WalletService } from './wallet-service';
import { createWallet, importWallet, walletExists, deleteWallet, loadConfig, saveConfig } from './storage';
import { NETWORKS, WALLET_DIR } from './config';

const program = new Command();

// Zone mapping for user-friendly names
const ZONE_MAP: Record<string, Zone> = {
    'cyprus1': Zone.Cyprus1,
    'cyprus2': Zone.Cyprus2,
    'cyprus3': Zone.Cyprus3,
    'paxos1': Zone.Paxos1,
    'paxos2': Zone.Paxos2,
    'paxos3': Zone.Paxos3,
    'hydra1': Zone.Hydra1,
    'hydra2': Zone.Hydra2,
    'hydra3': Zone.Hydra3,
};

function parseZone(zoneName: string): Zone {
    const zone = ZONE_MAP[zoneName.toLowerCase()];
    if (!zone) {
        throw new Error(`Invalid zone: ${zoneName}. Valid zones: ${Object.keys(ZONE_MAP).join(', ')}`);
    }
    return zone;
}

function getZoneName(zone: Zone): string {
    for (const [name, z] of Object.entries(ZONE_MAP)) {
        if (z === zone) return name;
    }
    return zone;
}

async function promptPassword(prompt: string = 'Enter password: '): Promise<string> {
    // Allow password from environment variable for testing/scripting
    if (process.env.QUAI_WALLET_PASSWORD) {
        return process.env.QUAI_WALLET_PASSWORD;
    }

    const stdin = process.stdin;

    // Use raw mode for TTY to hide password
    if (stdin.isTTY) {
        return new Promise((resolve) => {
            process.stdout.write(prompt);
            let password = '';

            stdin.setRawMode(true);
            stdin.resume();
            stdin.setEncoding('utf8');

            const onData = (char: string) => {
                const charCode = char.charCodeAt(0);

                if (charCode === 13 || charCode === 10) {
                    // Enter
                    stdin.setRawMode(false);
                    stdin.removeListener('data', onData);
                    stdin.pause();
                    console.log();
                    resolve(password);
                } else if (charCode === 127 || charCode === 8) {
                    // Backspace
                    if (password.length > 0) {
                        password = password.slice(0, -1);
                    }
                } else if (charCode === 3) {
                    // Ctrl+C
                    stdin.setRawMode(false);
                    process.exit(0);
                } else if (charCode >= 32) {
                    password += char;
                    // Don't echo anything - hide password length
                }
            };

            stdin.on('data', onData);
        });
    } else {
        // Non-TTY fallback (piped input)
        const rl = readline.createInterface({
            input: stdin,
            output: process.stdout,
        });

        return new Promise((resolve) => {
            rl.question(prompt, (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    }
}

async function promptConfirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(`${message} (y/N): `, (answer) => {
            rl.close();
            resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
        });
    });
}

program
    .name('quai-cli-wallet')
    .description('CLI wallet for Quai Network')
    .version('1.0.0');

// Create wallet
program
    .command('create')
    .description('Create a new HD wallet')
    .action(async () => {
        try {
            if (walletExists()) {
                const confirm = await promptConfirm('A wallet already exists. This will overwrite it. Continue?');
                if (!confirm) {
                    console.log('Aborted.');
                    return;
                }
            }

            const password = await promptPassword('Enter new password: ');
            const confirmPassword = await promptPassword('Confirm password: ');

            if (password !== confirmPassword) {
                console.error('Passwords do not match.');
                process.exit(1);
            }

            if (password.length < 8) {
                console.error('Password must be at least 8 characters.');
                process.exit(1);
            }

            console.log('\nCreating wallet...');
            const { mnemonic } = await createWallet(password);

            console.log('\n=== IMPORTANT: Save your recovery phrase! ===');
            console.log('Write down these 12 words and store them safely:\n');
            console.log(`  ${mnemonic}\n`);
            console.log('WARNING: Anyone with this phrase can access your funds!');
            console.log('=========================================\n');
            console.log(`Wallet created successfully!`);
            console.log(`Wallet stored at: ${WALLET_DIR}`);
        } catch (error) {
            console.error('Error creating wallet:', (error as Error).message);
            process.exit(1);
        }
    });

// Import wallet
program
    .command('import')
    .description('Import wallet from recovery phrase')
    .action(async () => {
        try {
            if (walletExists()) {
                const confirm = await promptConfirm('A wallet already exists. This will overwrite it. Continue?');
                if (!confirm) {
                    console.log('Aborted.');
                    return;
                }
            }

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });

            const phrase = await new Promise<string>((resolve) => {
                rl.question('Enter recovery phrase (12 or 24 words): ', (answer) => {
                    rl.close();
                    resolve(answer.trim());
                });
            });

            const password = await promptPassword('Enter new password: ');
            const confirmPassword = await promptPassword('Confirm password: ');

            if (password !== confirmPassword) {
                console.error('Passwords do not match.');
                process.exit(1);
            }

            console.log('\nImporting wallet...');
            await importWallet(phrase, password);

            console.log('Wallet imported successfully!');
            console.log(`Wallet stored at: ${WALLET_DIR}`);
        } catch (error) {
            console.error('Error importing wallet:', (error as Error).message);
            process.exit(1);
        }
    });

// Generate new address
program
    .command('new-address')
    .description('Generate a new address for a zone (default: cyprus1)')
    .argument('[zone]', `Zone name (${Object.keys(ZONE_MAP).join(', ')})`, 'cyprus1')
    .action(async (zoneName: string) => {
        try {
            const zone = parseZone(zoneName);
            const password = await promptPassword();

            const service = new WalletService();
            await service.initialize(password);

            console.log(`\nGenerating new address for ${zoneName}...`);
            const { address } = await service.generateAddress(zone);

            console.log(`\nNew address: ${address}`);
            console.log(`Zone: ${zoneName}`);
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

// List addresses
program
    .command('addresses')
    .description('List all addresses')
    .option('-z, --zone <zone>', 'Filter by zone')
    .action(async (options) => {
        try {
            const password = await promptPassword();

            const service = new WalletService();
            await service.initialize(password);

            let addresses;
            if (options.zone) {
                const zone = parseZone(options.zone);
                addresses = service.getAddressesForZone(zone);
            } else {
                addresses = service.getAddresses();
            }

            if (addresses.length === 0) {
                console.log('\nNo addresses found. Use "new-address <zone>" to generate one.');
                return;
            }

            console.log('\nAddresses:');
            console.log('-'.repeat(60));
            for (const addr of addresses) {
                console.log(`  ${addr.address} (${getZoneName(addr.zone)})`);
            }
            console.log('-'.repeat(60));
            console.log(`Total: ${addresses.length} address(es)`);
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

// Scan for addresses with balance (wallet recovery)
program
    .command('scan')
    .description('Scan for addresses with balance (useful for wallet recovery)')
    .argument('<count>', 'Number of addresses to scan')
    .option('--zone <zone>', 'Zone to scan (default: cyprus1)', 'cyprus1')
    .action(async (countStr: string, options) => {
        try {
            const count = parseInt(countStr, 10);
            if (isNaN(count) || count < 1) {
                console.error('Count must be a positive integer');
                process.exit(1);
            }

            if (count > 10000) {
                console.error('Count cannot exceed 10000');
                process.exit(1);
            }

            const zone = parseZone(options.zone);
            const password = await promptPassword();

            const service = new WalletService();
            await service.initialize(password);

            console.log(`\nScanning ${count} addresses for ${options.zone}...`);
            console.log(`Network: ${service.currentNetwork.name}\n`);

            const foundAddresses = await service.scanAddresses(count, zone, (current, total, address, hasBalance) => {
                const status = hasBalance ? '✓ FOUND' : '  -';
                process.stdout.write(`\r[${current}/${total}] ${address} ${status}`.padEnd(80));
                if (hasBalance) {
                    process.stdout.write('\n');
                }
            });

            // Clear the progress line
            process.stdout.write('\r' + ' '.repeat(80) + '\r');

            console.log('\n' + '='.repeat(60));
            if (foundAddresses.length === 0) {
                console.log('No addresses with balance found.');
            } else {
                console.log(`Found ${foundAddresses.length} address(es) with balance:\n`);
                let total = 0n;
                for (const addr of foundAddresses) {
                    console.log(`  ${addr.address}`);
                    console.log(`    Balance: ${addr.balance} QUAI\n`);
                    total += addr.balanceWei;
                }
                console.log('-'.repeat(60));
                console.log(`Total balance found: ${formatQuai(total)} QUAI`);
                console.log('\nAddresses with balance have been saved to your wallet.');
            }
        } catch (error) {
            console.error('\nError:', (error as Error).message);
            process.exit(1);
        }
    });

// Check balance
program
    .command('balance')
    .description('Check balance of an address')
    .argument('<address>', 'Address to check')
    .action(async (address: string) => {
        try {
            const password = await promptPassword();

            const service = new WalletService();
            await service.initialize(password);

            console.log(`\nFetching balance for ${address}...`);
            console.log(`Network: ${service.currentNetwork.name}`);

            const balances = await service.getTotalBalance(address);

            console.log('\nBalance:');
            console.log('-'.repeat(40));
            console.log(`  Available: ${balances.available} QUAI`);
            console.log(`  Locked:    ${balances.locked} QUAI`);
            console.log('-'.repeat(40));
            console.log(`  Total:     ${balances.total} QUAI`);
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

// Check total balance across all addresses
program
    .command('total-balance')
    .description('Check total balance across all wallet addresses')
    .action(async () => {
        try {
            const password = await promptPassword();

            const service = new WalletService();
            await service.initialize(password);

            const addresses = service.getAddresses();

            if (addresses.length === 0) {
                console.log('\nNo addresses found. Use "new-address <zone>" to generate one.');
                return;
            }

            console.log(`\nFetching balances for ${addresses.length} address(es)...`);
            console.log(`Network: ${service.currentNetwork.name}\n`);

            let totalAvailable = 0n;
            let totalLocked = 0n;

            for (const addr of addresses) {
                const balances = await service.getTotalBalance(addr.address);
                totalAvailable += balances.availableWei;
                totalLocked += balances.lockedWei;

                console.log(`${addr.address} (${getZoneName(addr.zone)})`);
                console.log(`  Available: ${balances.available} QUAI`);
                if (balances.lockedWei > 0n) {
                    console.log(`  Locked:    ${balances.locked} QUAI`);
                }
                console.log();
            }

            const grandTotal = totalAvailable + totalLocked;

            console.log('='.repeat(50));
            console.log('TOTAL ACROSS ALL ADDRESSES:');
            console.log('-'.repeat(50));
            console.log(`  Available: ${formatQuai(totalAvailable)} QUAI`);
            console.log(`  Locked:    ${formatQuai(totalLocked)} QUAI`);
            console.log('-'.repeat(50));
            console.log(`  Total:     ${formatQuai(grandTotal)} QUAI`);
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

// Send transaction
program
    .command('send')
    .description('Send QUAI to an address')
    .argument('<from>', 'Sender address')
    .argument('<to>', 'Recipient address')
    .argument('<amount>', 'Amount in QUAI (use "max" to send full balance minus gas)')
    .option('--gas-limit <limit>', 'Gas limit')
    .action(async (from: string, to: string, amount: string, options) => {
        try {
            const password = await promptPassword();

            const service = new WalletService();
            await service.initialize(password);

            console.log(`\nPreparing transaction...`);
            console.log(`Network: ${service.currentNetwork.name}`);
            console.log(`From: ${from}`);
            console.log(`To: ${to}`);

            // Get balance and fee data
            const balance = await service.getBalance(from);
            const gasPrice = await service.getGasPrice(from);
            console.log(`Balance: ${balance.balance} QUAI`);
            console.log(`Gas Price: ${gasPrice} wei`);

            // Estimate gas using a small test value (gas for simple transfer doesn't depend on value)
            const testGas = await service.estimateGas({ from, to, value: 1n });
            const estimatedGas = options.gasLimit ? BigInt(options.gasLimit) : (testGas * 120n) / 100n;
            const gasCost = estimatedGas * gasPrice;
            console.log(`Estimated gas: ${estimatedGas}`);
            console.log(`Gas cost: ~${formatQuai(gasCost)} QUAI`);

            let sendAmount: string;
            let sendAmountWei: bigint;

            // Calculate max amount if amount is "max"
            if (amount.toLowerCase() === 'max') {
                if (balance.balanceWei <= gasCost) {
                    console.error('\nInsufficient balance to cover gas fees');
                    process.exit(1);
                }

                sendAmountWei = balance.balanceWei - gasCost;
                sendAmount = formatQuai(sendAmountWei);
                console.log(`Amount to send (max): ${sendAmount} QUAI`);
            } else {
                sendAmount = amount;
                sendAmountWei = parseQuai(amount);
                console.log(`Amount: ${sendAmount} QUAI`);

                // Check if balance is sufficient for amount + gas
                const totalNeeded = sendAmountWei + gasCost;
                if (balance.balanceWei < totalNeeded) {
                    console.error('\nInsufficient balance');
                    console.log(`Amount + gas: ${formatQuai(totalNeeded)} QUAI`);
                    console.log(`Shortfall: ${formatQuai(totalNeeded - balance.balanceWei)} QUAI`);
                    process.exit(1);
                }
            }

            const confirm = await promptConfirm('\nSend this transaction?');
            if (!confirm) {
                console.log('Transaction cancelled.');
                return;
            }

            console.log('\nSending transaction...');
            const txResponse = await service.sendTransaction(from, to, sendAmount, {
                gasLimit: options.gasLimit ? BigInt(options.gasLimit) : undefined,
            });

            console.log(`\nTransaction sent!`);
            console.log(`Transaction hash: ${txResponse.hash}`);
            console.log('\nWaiting for confirmation...');

            const receipt = await txResponse.wait();
            console.log(`\nTransaction confirmed!`);
            console.log(`Block number: ${receipt?.blockNumber}`);
            if (receipt && 'gasUsed' in receipt) {
                console.log(`Gas used: ${(receipt as any).gasUsed}`);
            }
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

// Sign transaction (without sending)
program
    .command('sign')
    .description('Sign a transaction without broadcasting')
    .argument('<from>', 'Sender address')
    .argument('<to>', 'Recipient address')
    .argument('<amount>', 'Amount in QUAI')
    .action(async (from: string, to: string, amount: string) => {
        try {
            const password = await promptPassword();

            const service = new WalletService();
            await service.initialize(password);

            console.log(`\nSigning transaction...`);
            const signedTx = await service.signTransaction(from, to, amount);

            console.log(`\nSigned transaction:`);
            console.log(signedTx);
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

// Export private key
program
    .command('export-key')
    .description('Export private key for an address')
    .argument('<address>', 'Address to export key for')
    .action(async (address: string) => {
        try {
            console.log('\nWARNING: Exposing your private key can result in loss of funds!');
            const confirm = await promptConfirm('Are you sure you want to export the private key?');
            if (!confirm) {
                console.log('Aborted.');
                return;
            }

            const password = await promptPassword();

            const service = new WalletService();
            await service.initialize(password);

            const privateKey = service.getPrivateKey(address);

            console.log(`\nPrivate key for ${address}:`);
            console.log(`  ${privateKey}`);
            console.log('\nWARNING: Never share this key with anyone!');
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

// Network commands
program
    .command('network')
    .description('Show or change network')
    .argument('[network]', 'Network to switch to (mainnet, orchard)')
    .action(async (network?: string) => {
        try {
            const config = loadConfig();

            if (!network) {
                console.log(`\nCurrent network: ${config.network}`);
                console.log(`RPC URL: ${NETWORKS[config.network]?.rpcUrl || 'unknown'}`);
                console.log('\nAvailable networks:');
                for (const [name, net] of Object.entries(NETWORKS)) {
                    const marker = name === config.network ? '*' : ' ';
                    console.log(`  ${marker} ${name}: ${net.rpcUrl}`);
                }
                return;
            }

            if (!NETWORKS[network]) {
                console.error(`Unknown network: ${network}`);
                console.log(`Available: ${Object.keys(NETWORKS).join(', ')}`);
                process.exit(1);
            }

            config.network = network;
            saveConfig(config);
            console.log(`Switched to ${network}`);
            console.log(`RPC URL: ${NETWORKS[network].rpcUrl}`);
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

// Delete wallet
program
    .command('delete')
    .description('Delete the wallet (irreversible!)')
    .action(async () => {
        try {
            if (!walletExists()) {
                console.log('No wallet found.');
                return;
            }

            console.log('\nWARNING: This will permanently delete your wallet!');
            console.log('Make sure you have backed up your recovery phrase.');

            const confirm1 = await promptConfirm('Are you sure you want to delete the wallet?');
            if (!confirm1) {
                console.log('Aborted.');
                return;
            }

            const confirm2 = await promptConfirm('This action is IRREVERSIBLE. Type "y" again to confirm:');
            if (!confirm2) {
                console.log('Aborted.');
                return;
            }

            deleteWallet();
            console.log('\nWallet deleted.');
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

// Info command
program
    .command('info')
    .description('Show wallet info')
    .action(async () => {
        try {
            if (!walletExists()) {
                console.log('No wallet found. Create one with the "create" command.');
                return;
            }

            const password = await promptPassword();

            const service = new WalletService();
            await service.initialize(password);

            const addresses = service.getAddresses();
            const config = loadConfig();

            console.log('\n=== Wallet Info ===');
            console.log(`Network: ${config.network} (${service.currentNetwork.rpcUrl})`);
            console.log(`Current address: ${config.currentAddress || 'none set'}`);
            console.log(`Total addresses: ${addresses.length}`);

            if (addresses.length > 0) {
                console.log('\nAddresses by zone:');
                const byZone: Record<string, number> = {};
                for (const addr of addresses) {
                    const zoneName = getZoneName(addr.zone);
                    byZone[zoneName] = (byZone[zoneName] || 0) + 1;
                }
                for (const [zone, count] of Object.entries(byZone)) {
                    console.log(`  ${zone}: ${count}`);
                }

                // Fetch total balance
                console.log('\nFetching balances...');
                let totalAvailable = 0n;
                let totalLocked = 0n;

                for (const addr of addresses) {
                    const balances = await service.getTotalBalance(addr.address);
                    totalAvailable += balances.availableWei;
                    totalLocked += balances.lockedWei;
                }

                const grandTotal = totalAvailable + totalLocked;
                console.log('\nTotal Balance:');
                console.log(`  Available: ${formatQuai(totalAvailable)} QUAI`);
                if (totalLocked > 0n) {
                    console.log(`  Locked:    ${formatQuai(totalLocked)} QUAI`);
                }
                console.log(`  Total:     ${formatQuai(grandTotal)} QUAI`);
            }
        } catch (error) {
            console.error('Error:', (error as Error).message);
            process.exit(1);
        }
    });

export { program };
