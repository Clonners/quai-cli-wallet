#!/usr/bin/env node
/**
 * Generic DEX CLI — Native + ERC20 + Router operations on Quai Network
 *
 * Works with:
 *   - Native QUAI (balance, transfer, swap in/out)
 *   - Any ERC20 token (balance, transfer, approve, allowance, info)
 *   - Any UniswapV2-compatible router (QuaiSwap, etc.)
 *
 * Config: cli/qdex/config/dex.json
 *
 * Usage: node dex.js <command> [subcommand] [args]
 */

import { Wallet, JsonRpcProvider, Contract, parseQuai, formatQuai, parseUnits, formatUnits } from 'quais';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Version ─────────────────────────────────────────────────────────────────

const PKG_PATH = join(__dirname, '../package.json');
const CLI_VERSION = existsSync(PKG_PATH) ? JSON.parse(readFileSync(PKG_PATH, 'utf8')).version : '0.0.0';

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const supportsColor = !process.env.NO_COLOR && process.stdout.isTTY !== false;

function c(code, text) {
  return supportsColor ? `\x1b[${code}m${text}\x1b[0m` : String(text);
}

const clr = {
  bold: (s) => c('1', s),
  dim: (s) => c('2', s),
  cyan: (s) => c('36', s),
  green: (s) => c('32', s),
  yellow: (s) => c('33', s),
  red: (s) => c('31', s),
  magenta: (s) => c('35', s),
  blue: (s) => c('34', s),
  gray: (s) => c('90', s),
};

// ─── Config validation ──────────────────────────────────────────────────────

function validateConfig(raw) {
  const errors = [];

  if (!raw.tokens || typeof raw.tokens !== 'object') {
    errors.push('Missing "tokens" object');
  } else {
    for (const [key, info] of Object.entries(raw.tokens)) {
      if (!info.address || !info.address.startsWith('0x') || info.address.length !== 42) {
        errors.push(`Token "${key}": invalid address`);
      }
      if (info.decimals !== undefined && (typeof info.decimals !== 'number' || info.decimals < 0 || info.decimals > 256)) {
        errors.push(`Token "${key}": invalid decimals`);
      }
      if (info.nativeAlias && !info.wrappedNative) {
        errors.push(`Token "${key}": nativeAlias set but wrappedNative is not true`);
      }
    }
  }

  if (!raw.routers || typeof raw.routers !== 'object') {
    errors.push('Missing "routers" object');
  } else {
    for (const [key, info] of Object.entries(raw.routers)) {
      if (!info.address || !info.address.startsWith('0x') || info.address.length !== 42) {
        errors.push(`Router "${key}": invalid address`);
      }
      if (!info.type) {
        errors.push(`Router "${key}": missing type`);
      }
    }
  }

  if (!raw.defaults || typeof raw.defaults !== 'object') {
    errors.push('Missing "defaults" object');
  } else {
    if (raw.defaults.slippage !== undefined && (raw.defaults.slippage < 0 || raw.defaults.slippage > 1)) {
      errors.push('defaults.slippage must be between 0 and 1');
    }
    if (raw.defaults.deadlineSec !== undefined && raw.defaults.deadlineSec < 60) {
      errors.push('defaults.deadlineSec must be at least 60');
    }
    if (raw.defaults.gasLimit !== undefined && raw.defaults.gasLimit < 21000) {
      errors.push('defaults.gasLimit must be at least 21000');
    }
    if (raw.defaults.rpc && typeof raw.defaults.rpc !== 'string') {
      errors.push('defaults.rpc must be a string URL');
    }
  }

  if (errors.length > 0) {
    console.error(clr.red('❌ Invalid config (dex.json):'));
    for (const e of errors) console.error(clr.dim(`   - ${e}`));
    throw new Error(`Config validation failed with ${errors.length} error(s)`);
  }

  return raw;
}

// ─── CLI flags (global) ──────────────────────────────────────────────────────

function parseGlobalFlags(argv) {
  const cleaned = [];
  let configPath = null;
  let showVersion = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--version' || arg === '-v') {
      showVersion = true;
      continue;
    }

    if (arg === '--config') {
      configPath = argv[++i];
      if (!configPath) throw new Error('--config requires a path argument');
      continue;
    }

    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length);
      continue;
    }

    cleaned.push(arg);
  }

  return { configPath, showVersion, cleaned };
}

const globalFlags = parseGlobalFlags(process.argv);
const effectiveArgv = ['', '', ...globalFlags.cleaned];

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = join(__dirname, '../config/dex.json');
const CONFIG_PATH = globalFlags.configPath || DEFAULT_CONFIG_PATH;

let rawConfig;
try {
  rawConfig = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : { tokens: {}, routers: {}, defaults: {} };
  validateConfig(rawConfig);
} catch (e) {
  console.error(clr.red(`Failed to load config from ${CONFIG_PATH}`));
  throw e;
}
const config = rawConfig;

const RPC_URL = process.env.QUAI_RPC || config.defaults.rpc || 'https://orchard.rpc.quai.network/cyprus1';
const DEFAULT_SLIPPAGE = config.defaults.slippage ?? 0.05;
const DEFAULT_DEADLINE_SEC = config.defaults.deadlineSec ?? 3600;
const DEFAULT_GAS_LIMIT = config.defaults.gasLimit ?? 500000;
const EXPLORER_URL = config.defaults.explorer ?? '';

// ─── Retry with exponential backoff ─────────────────────────────────────────

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1500;
const RETRY_BACKOFF_FACTOR = 2;

const RETRYABLE_PATTERNS = [
  /timeout/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /network/i,
  /rate.limit/i,
  /rate limit/i,
  /too many requests/i,
  /server overloaded/i,
  /internal server error/i,
  /-32000/i,
  /deadline.exceeded/i,
];

function isRetryable(error) {
  if (!error || !error.message) return false;
  return RETRYABLE_PATTERNS.some(pattern => pattern.test(error.message));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, context, label, maxAttempts = RETRY_MAX_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error;
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1);
      console.log(clr.yellow(`⚠️  ${label} attempt ${attempt}/${maxAttempts} failed: ${error.message}`));
      console.log(clr.dim(`   Retrying in ${delay}ms...`));
      await sleep(delay);
    }
  }
  throw lastError;
}

// ─── ABIs ────────────────────────────────────────────────────────────────────

const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
];

const ROUTER_V2 = [
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
  'function getAmountsIn(uint256,address[]) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])',
  'function swapTokensForExactTokens(uint256,uint256,address[],address,uint256) returns (uint256[])',
  'function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])',
  'function swapTokensForExactETH(uint256,uint256,address[],address,uint256) returns (uint256[])',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveToken(ref) {
  if (typeof ref === 'string' && ref.startsWith('0x') && ref.length === 42) {
    return { address: ref.toLowerCase() };
  }

  const upper = ref.toUpperCase();
  for (const [key, info] of Object.entries(config.tokens)) {
    if (key.toUpperCase() === upper) return info;
    if (info.symbol?.toUpperCase() === upper) return info;
    if (info.nativeAlias?.toUpperCase() === upper) return info;
  }

  throw new Error(`Unknown token: ${ref}. Run 'token list' for available tokens.`);
}

function resolveRouter(ref) {
  if (typeof ref === 'string' && ref.startsWith('0x') && ref.length === 42) {
    return { address: ref.toLowerCase() };
  }

  const lower = ref.toLowerCase();
  for (const [key, info] of Object.entries(config.routers)) {
    if (key.toLowerCase() === lower) return info;
  }

  throw new Error(`Unknown router: ${ref}. Run 'router list' for available routers.`);
}

function parseAmt(amount, decimals = 18) {
  return decimals === 18 ? parseQuai(amount.toString()) : parseUnits(amount.toString(), decimals);
}

function formatAmt(value, decimals = 18) {
  return decimals === 18 ? formatQuai(value) : formatUnits(value, decimals);
}

function explorerLink(txHash) {
  return EXPLORER_URL ? `${EXPLORER_URL}${txHash}` : '';
}

function printTx(tx, receipt) {
  console.log(clr.dim(`   TX: ${clr.cyan(tx.hash)}`));
  console.log(clr.dim(`   Block: ${receipt.blockNumber} | Gas: ${clr.yellow(receipt.gasUsed.toString())}`));
  const link = explorerLink(tx.hash);
  if (link) console.log(clr.dim(`   Explorer: ${clr.cyan(link)}`));
}

// ─── Client ──────────────────────────────────────────────────────────────────

class Client {
  constructor() {
    // usePathing: false for Orchard testnet (prime endpoint not available)
    this.provider = new JsonRpcProvider(RPC_URL, undefined, { usePathing: false });
    this.wallet = this._loadWallet();
    this._networkInfo = null;
  }

  _loadWallet() {
    const pk = process.env.QUAI_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
    if (!pk) throw new Error('QUAI_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY not found in environment.');
    return new Wallet(pk, this.provider);
  }

  get addr() { return this.wallet.address; }

  erc20(tokenAddr, signer = null) {
    return new Contract(tokenAddr, ERC20, signer || this.provider);
  }

  router(routerAddr, signer = null) {
    return new Contract(routerAddr, ROUTER_V2, signer || this.provider);
  }

  // ── Network detection ─────────────────────────────────────────────────────

  async detectNetwork() {
    if (this._networkInfo) return this._networkInfo;

    this._networkInfo = await retryWithBackoff(
      () => this.provider.getNetwork(),
      this.provider,
      'Network detection'
    );

    console.log(clr.dim(`🌐 Connected to: ${clr.bold(this._networkInfo.name)} (chainId: ${this._networkInfo.chainId})`));
    return this._networkInfo;
  }

  // ── Dynamic gas estimation ────────────────────────────────────────────────

  async estimateGas(txParams) {
    try {
      const estimated = await retryWithBackoff(
        () => this.provider.estimateGas(txParams),
        this.provider,
        'Gas estimation'
      );
      // Add 20% buffer
      const withBuffer = (estimated * 120n) / 100n;
      if (withBuffer > BigInt(DEFAULT_GAS_LIMIT)) {
        console.log(clr.yellow(`   ⚠️  Estimated gas (${withBuffer.toString()}) exceeds cap, using ${DEFAULT_GAS_LIMIT}`));
        return BigInt(DEFAULT_GAS_LIMIT);
      }
      console.log(clr.dim(`   Gas estimate: ${estimated.toString()} → ${clr.yellow(withBuffer.toString())} (with 20% buffer)`));
      return withBuffer;
    } catch {
      console.log(clr.yellow(`   ⚠️  Gas estimation failed, falling back to ${DEFAULT_GAS_LIMIT}`));
      return BigInt(DEFAULT_GAS_LIMIT);
    }
  }

  // ── Wrapped RPC calls with retry ──────────────────────────────────────────

  async _retryView(fn, label) {
    return retryWithBackoff(fn, this.provider, label);
  }

  async _retryWrite(fn, label) {
    return retryWithBackoff(fn, this.wallet, label);
  }

  // ── Native QUAI ───────────────────────────────────────────────────────────

  async nativeBalance() {
    const balance = await this._retryView(
      () => this.provider.getBalance(this.addr),
      'Native balance read'
    );
    console.log(clr.green(`${formatQuai(balance)} QUAI`));
    return balance;
  }

  async nativeTransfer(to, amount) {
    if (!to.startsWith('0x') || to.length !== 42) {
      throw new Error(`Invalid address: ${to}`);
    }

    const value = parseQuai(amount.toString());
    console.log(clr.cyan(`📤 Transfer ${clr.bold(amount)} QUAI → ${to.slice(0, 10)}...`));

    const txParams = { from: this.addr, to, value };
    const gasLimit = await this.estimateGas(txParams);

    const tx = await this._retryWrite(
      () => this.wallet.sendTransaction({ ...txParams, gasLimit }),
      'Native transfer'
    );
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  // ── ERC20 operations ──────────────────────────────────────────────────────

  async tokenBalance(tokenRef, owner = null) {
    const token = resolveToken(tokenRef);
    const contract = this.erc20(token.address);
    const decimals = token.decimals ?? await contract.decimals();
    const balance = await this._retryView(
      () => contract.balanceOf(owner || this.addr),
      'Token balance read'
    );
    console.log(clr.green(`${formatAmt(balance, decimals)} ${clr.bold(tokenRef)}`));
    return { balance, decimals };
  }

  async tokenTransfer(tokenRef, to, amount) {
    if (!to.startsWith('0x') || to.length !== 42) {
      throw new Error(`Invalid address: ${to}`);
    }

    const token = resolveToken(tokenRef);
    const contract = this.erc20(token.address, this.wallet);
    const decimals = token.decimals ?? await contract.decimals();
    const value = parseAmt(amount, decimals);

    console.log(clr.cyan(`📤 Transfer ${clr.bold(amount)} ${tokenRef} → ${to.slice(0, 10)}...`));

    const txParams = { from: this.addr, to: token.address, data: contract.interface.encodeFunctionData('transfer', [to, value]) };
    const gasLimit = await this.estimateGas(txParams);

    const tx = await this._retryWrite(
      () => contract.transfer(to, value, { from: this.addr, gasLimit }),
      'Token transfer'
    );
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  async tokenApprove(tokenRef, spenderRef, amount) {
    const token = resolveToken(tokenRef);
    const spender = resolveRouter(spenderRef) || { address: spenderRef.toLowerCase() };
    const contract = this.erc20(token.address, this.wallet);
    const decimals = token.decimals ?? await contract.decimals();
    const value = parseAmt(amount, decimals);
    const spenderAddr = spender.address || spenderRef;

    console.log(clr.cyan(`✅ Approve ${clr.bold(amount)} ${tokenRef} for ${spenderAddr.slice(0, 10)}...`));

    const txParams = { from: this.addr, to: token.address, data: contract.interface.encodeFunctionData('approve', [spenderAddr, value]) };
    const gasLimit = await this.estimateGas(txParams);

    const tx = await this._retryWrite(
      () => contract.approve(spenderAddr, value, { from: this.addr, gasLimit }),
      'Token approve'
    );
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  async tokenAllowance(tokenRef, owner, spenderRef) {
    const token = resolveToken(tokenRef);
    const spender = resolveRouter(spenderRef) || { address: spenderRef.toLowerCase() };
    const contract = this.erc20(token.address);
    const decimals = token.decimals ?? await contract.decimals();
    const spenderAddr = spender.address || spenderRef;
    const allowance = await this._retryView(
      () => contract.allowance(owner || this.addr, spenderAddr),
      'Allowance read'
    );
    console.log(clr.green(`Allowance: ${formatAmt(allowance, decimals)}`));
  }

  async tokenInfo(tokenRef) {
    const token = resolveToken(tokenRef);
    const contract = this.erc20(token.address);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      this._retryView(() => contract.name(), 'Token name'),
      this._retryView(() => contract.symbol(), 'Token symbol'),
      this._retryView(() => contract.decimals(), 'Token decimals'),
      this._retryView(() => contract.totalSupply(), 'Token totalSupply'),
    ]);
    console.log(clr.dim(`Name: ${clr.bold(name)}`));
    console.log(clr.dim(`Symbol: ${clr.bold(symbol)}`));
    console.log(clr.dim(`Decimals: ${decimals}`));
    console.log(clr.dim(`Total supply: ${clr.green(formatAmt(totalSupply, decimals))}`));
  }

  async tokenList() {
    console.log(clr.bold(`\n📋 Registered tokens:\n`));
    console.log(clr.dim(`| Key | Symbol | Decimals | Address |`));
    console.log(clr.dim(`|-----|--------|----------|---------|`));
    for (const [key, info] of Object.entries(config.tokens)) {
      const alias = info.nativeAlias ? ` (${info.nativeAlias})` : '';
      console.log(`| ${clr.cyan(key + alias)} | ${clr.green(info.symbol)} | ${info.decimals} | ${clr.dim(info.address.slice(0, 10) + '...')} |`);
    }
    console.log();
  }

  async routerList() {
    console.log(clr.bold(`\n📋 Registered routers:\n`));
    console.log(clr.dim(`| Name | Type | Address |`));
    console.log(clr.dim(`|------|------|---------|`));
    for (const [key, info] of Object.entries(config.routers)) {
      console.log(`| ${clr.cyan(key)} | ${clr.magenta(info.type)} | ${clr.dim(info.address.slice(0, 10) + '...')} |`);
    }
    console.log();
  }

  // ── Router operations ─────────────────────────────────────────────────────

  _detectNativeInPath(path) {
    const result = [];
    for (const p of path) {
      const upper = p.toUpperCase();
      const token = resolveToken(p);
      const isNative = !!token.nativeAlias && token.nativeAlias.toUpperCase() === upper;
      result.push({ ...token, isNative });
    }
    return result;
  }

  async routerQuote(routerRef, pathStr, amount) {
    const router = resolveRouter(routerRef);
    const path = pathStr.split(',').map(s => s.trim());
    const resolved = this._detectNativeInPath(path);

    const firstNative = resolved[0].isNative;
    const lastNative = resolved[resolved.length - 1].isNative;

    if (firstNative && lastNative) {
      throw new Error('Cannot swap native → native directly. Use token → token path.');
    }

    if (firstNative) return this._nativeInQuote(router.address, resolved, amount);
    if (lastNative) return this._nativeOutQuote(router.address, resolved, amount);

    const addresses = resolved.map(t => t.address);
    const decimals = resolved[0].decimals;
    const valueIn = parseAmt(amount, decimals);
    const amounts = await this._retryView(
      () => this.router(router.address).getAmountsOut(valueIn, addresses),
      'Router quote'
    );
    const outDecimals = resolved[resolved.length - 1].decimals;
    console.log(clr.magenta(`💱 ${clr.bold(amount)} ${path[0]} → ${clr.green(formatAmt(amounts[amounts.length - 1], outDecimals))} ${path[path.length - 1]}`));
    return amounts;
  }

  async _nativeInQuote(routerAddr, resolved, amount) {
    const wAddress = resolved[0].address;
    const path = [wAddress, ...resolved.slice(1).map(t => t.address)];
    const valueIn = parseQuai(amount.toString());
    const amounts = await this._retryView(
      () => this.router(routerAddr).getAmountsOut(valueIn, path),
      'Native-in quote'
    );
    const outDecimals = resolved[resolved.length - 1].decimals;
    console.log(clr.magenta(`💱 ${clr.bold(amount)} QUAI → ${clr.green(formatAmt(amounts[amounts.length - 1], outDecimals))} ${resolved[resolved.length - 1].symbol}`));
    return amounts;
  }

  async _nativeOutQuote(routerAddr, resolved, amount) {
    const wAddress = resolved[resolved.length - 1].address;
    const path = [...resolved.slice(0, -1).map(t => t.address), wAddress];
    const decimals = resolved[0].decimals;
    const valueIn = parseAmt(amount, decimals);
    const amounts = await this._retryView(
      () => this.router(routerAddr).getAmountsOut(valueIn, path),
      'Native-out quote'
    );
    console.log(clr.magenta(`💱 ${clr.bold(amount)} ${resolved[0].symbol} → ${clr.green(formatQuai(amounts[amounts.length - 1]))} QUAI`));
    return amounts;
  }

  async routerSwap(routerRef, pathStr, amount, minOutStr = null, deadlineSec = DEFAULT_DEADLINE_SEC, gasLimit = DEFAULT_GAS_LIMIT, dryRun = false, slippage = DEFAULT_SLIPPAGE) {
    const router = resolveRouter(routerRef);
    const path = pathStr.split(',').map(s => s.trim());
    const resolved = this._detectNativeInPath(path);

    const firstNative = resolved[0].isNative;
    const lastNative = resolved[resolved.length - 1].isNative;

    if (firstNative && lastNative) {
      throw new Error('Cannot swap native → native directly. Use token → token path.');
    }

    if (firstNative) {
      return this._nativeInSwap(router.address, resolved, amount, minOutStr, deadlineSec, gasLimit, dryRun, slippage);
    }
    if (lastNative) {
      return this._nativeOutSwap(router.address, resolved, amount, minOutStr, deadlineSec, gasLimit, dryRun, slippage);
    }
    return this._tokenSwap(router.address, resolved, amount, minOutStr, deadlineSec, gasLimit, dryRun, slippage);
  }

  async _tokenSwap(routerAddr, resolved, amount, minOutStr, deadlineSec, gasLimit, dryRun, slippage = DEFAULT_SLIPPAGE) {
    const addresses = resolved.map(t => t.address);
    const decimals = resolved[0].decimals;
    const valueIn = parseAmt(amount, decimals);

    const allowance = await this._retryView(
      () => this.erc20(addresses[0]).allowance(this.addr, routerAddr),
      'Allowance check'
    );
    if (allowance < valueIn) {
      if (dryRun) {
        console.log(clr.yellow(`⚠️  Insufficient allowance. Would approve ${amount}.`));
      } else {
        console.log(clr.yellow(`⚠️  Insufficient allowance. Approving...`));
        await this.tokenApprove(addresses[0], routerAddr, amount);
      }
    }

    const amounts = await this._retryView(
      () => this.router(routerAddr).getAmountsOut(valueIn, addresses),
      'Router quote'
    );
    const minOut = minOutStr
      ? parseAmt(minOutStr, resolved[resolved.length - 1].decimals)
      : (amounts[amounts.length - 1] * BigInt(10000 - Math.round(slippage * 10000))) / 10000n;

    const outDecimals = resolved[resolved.length - 1].decimals;
    console.log(clr.cyan(`🔄 Swap ${clr.bold(amount)} ${resolved[0].symbol} → min ${formatAmt(minOut, outDecimals)} ${resolved[resolved.length - 1].symbol}`));
    console.log(clr.dim(`   (${clr.yellow(slippage * 100 + '% slippage')})`));
    console.log(clr.dim(`   Path: ${addresses.map(a => clr.cyan(a.slice(0, 10))).join(clr.dim(' → '))}`));

    if (dryRun) {
      const txParams = { from: this.addr, to: routerAddr, data: this.router(routerAddr, this.wallet).interface.encodeFunctionData('swapExactTokensForTokens', [
        valueIn, minOut, addresses, this.addr, Math.floor(Date.now() / 1000) + deadlineSec,
      ]) };
      const estimatedGas = await this.estimateGas(txParams);
      console.log(clr.yellow(`   [DRY RUN] Would execute swap with estimated gas ${estimatedGas.toString()}`));
      return null;
    }

    const deadline = Math.floor(Date.now() / 1000) + deadlineSec;
    const txParams = { from: this.addr, to: routerAddr, data: this.router(routerAddr, this.wallet).interface.encodeFunctionData('swapExactTokensForTokens', [
      valueIn, minOut, addresses, this.addr, deadline,
    ]) };
    const finalGasLimit = await this.estimateGas(txParams);

    const tx = await this._retryWrite(
      () => this.router(routerAddr, this.wallet).swapExactTokensForTokens(
        valueIn, minOut, addresses, this.addr, deadline, { from: this.addr, gasLimit: finalGasLimit },
      ),
      'Token swap'
    );
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  async _nativeInSwap(routerAddr, resolved, amount, minOutStr, deadlineSec, gasLimit, dryRun, slippage = DEFAULT_SLIPPAGE) {
    const wAddress = resolved[0].address;
    const addresses = [wAddress, ...resolved.slice(1).map(t => t.address)];
    const valueIn = parseQuai(amount.toString());

    const amounts = await this._retryView(
      () => this.router(routerAddr).getAmountsOut(valueIn, addresses),
      'Native-in quote'
    );
    const minOut = minOutStr
      ? parseAmt(minOutStr, resolved[resolved.length - 1].decimals)
      : (amounts[amounts.length - 1] * BigInt(10000 - Math.round(slippage * 10000))) / 10000n;

    const outDecimals = resolved[resolved.length - 1].decimals;
    console.log(clr.cyan(`🔄 Swap ${clr.bold(amount)} QUAI → min ${formatAmt(minOut, outDecimals)} ${resolved[resolved.length - 1].symbol}`));
    console.log(clr.dim(`   (${clr.yellow(slippage * 100 + '% slippage')})`));
    console.log(clr.dim(`   Path: ${clr.cyan('QUAI')} → ${addresses.slice(1).map(a => clr.cyan(a.slice(0, 10))).join(clr.dim(' → '))}`));

    if (dryRun) {
      const txParams = { from: this.addr, to: routerAddr, value: valueIn, data: this.router(routerAddr, this.wallet).interface.encodeFunctionData('swapExactETHForTokens', [
        minOut, addresses, this.addr, Math.floor(Date.now() / 1000) + deadlineSec,
      ]) };
      const estimatedGas = await this.estimateGas(txParams);
      console.log(clr.yellow(`   [DRY RUN] Would execute swap with estimated gas ${estimatedGas.toString()}`));
      return null;
    }

    const deadline = Math.floor(Date.now() / 1000) + deadlineSec;
    const txParams = { from: this.addr, to: routerAddr, value: valueIn, data: this.router(routerAddr, this.wallet).interface.encodeFunctionData('swapExactETHForTokens', [
      minOut, addresses, this.addr, deadline,
    ]) };
    const finalGasLimit = await this.estimateGas(txParams);

    const tx = await this._retryWrite(
      () => this.router(routerAddr, this.wallet).swapExactETHForTokens(
        minOut, addresses, this.addr, deadline,
        { from: this.addr, value: valueIn, gasLimit: finalGasLimit },
      ),
      'Native-in swap'
    );
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  async _nativeOutSwap(routerAddr, resolved, amount, minOutStr, deadlineSec, gasLimit, dryRun, slippage = DEFAULT_SLIPPAGE) {
    const wAddress = resolved[resolved.length - 1].address;
    const addresses = [...resolved.slice(0, -1).map(t => t.address), wAddress];
    const decimals = resolved[0].decimals;
    const valueIn = parseAmt(amount, decimals);

    const allowance = await this._retryView(
      () => this.erc20(addresses[0]).allowance(this.addr, routerAddr),
      'Allowance check'
    );
    if (allowance < valueIn) {
      if (dryRun) {
        console.log(clr.yellow(`⚠️  Insufficient allowance. Would approve ${amount}.`));
      } else {
        console.log(clr.yellow(`⚠️  Insufficient allowance. Approving...`));
        await this.tokenApprove(addresses[0], routerAddr, amount);
      }
    }

    const amounts = await this._retryView(
      () => this.router(routerAddr).getAmountsOut(valueIn, addresses),
      'Native-out quote'
    );
    const minOut = minOutStr
      ? parseQuai(minOutStr)
      : (amounts[amounts.length - 1] * BigInt(10000 - Math.round(slippage * 10000))) / 10000n;

    console.log(clr.cyan(`🔄 Swap ${clr.bold(amount)} ${resolved[0].symbol} → min ${formatQuai(minOut)} QUAI`));
    console.log(clr.dim(`   (${clr.yellow(slippage * 100 + '% slippage')})`));
    console.log(clr.dim(`   Path: ${addresses.slice(0, -1).map(a => clr.cyan(a.slice(0, 10))).join(clr.dim(' → '))} → ${clr.cyan('QUAI')}`));

    if (dryRun) {
      const txParams = { from: this.addr, to: routerAddr, data: this.router(routerAddr, this.wallet).interface.encodeFunctionData('swapTokensForExactETH', [
        valueIn, minOut, addresses, this.addr, Math.floor(Date.now() / 1000) + deadlineSec,
      ]) };
      const estimatedGas = await this.estimateGas(txParams);
      console.log(clr.yellow(`   [DRY RUN] Would execute swap with estimated gas ${estimatedGas.toString()}`));
      return null;
    }

    const deadline = Math.floor(Date.now() / 1000) + deadlineSec;
    const txParams = { from: this.addr, to: routerAddr, data: this.router(routerAddr, this.wallet).interface.encodeFunctionData('swapTokensForExactETH', [
      valueIn, minOut, addresses, this.addr, deadline,
    ]) };
    const finalGasLimit = await this.estimateGas(txParams);

    const tx = await this._retryWrite(
      () => this.router(routerAddr, this.wallet).swapTokensForExactETH(
        valueIn, minOut, addresses, this.addr, deadline, { from: this.addr, gasLimit: finalGasLimit },
      ),
      'Native-out swap'
    );
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  // ── Balances ──────────────────────────────────────────────────────────────

  async allBalances() {
    console.log(clr.bold(`\n📊 ${clr.cyan(this.addr)}\n`));
    const nativeBal = await this._retryView(
      () => this.provider.getBalance(this.addr),
      'Native balance'
    );
    console.log(`${clr.bold('QUAI')}: ${clr.green(formatQuai(nativeBal))}`);
    for (const [key, info] of Object.entries(config.tokens)) {
      try {
        const bal = await this._retryView(
          () => this.erc20(info.address).balanceOf(this.addr),
          `${info.symbol} balance`
        );
        const decimals = info.decimals ?? 18;
        console.log(`${clr.bold(info.symbol)}: ${clr.green(formatAmt(bal, decimals))}`);
      } catch (e) {
        const errLabel = clr.red('(error reading)');
        console.log(`${clr.bold(info.symbol)}: ${errLabel}`);
      }
    }
    console.log();
  }
}

// ─── CLI arg parsing helpers ─────────────────────────────────────────────────

function parseSwapArgs(args) {
  const result = {
    router: null, path: null, amount: null, minOut: null,
    deadlineSec: DEFAULT_DEADLINE_SEC, gasLimit: DEFAULT_GAS_LIMIT,
    dryRun: false, slippage: DEFAULT_SLIPPAGE, gasEstimate: false,
  };

  let positional = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') { result.dryRun = true; continue; }
    if (arg === '--gas-estimate') { result.gasEstimate = true; continue; }
    if (arg.startsWith('--slippage=')) {
      const val = parseFloat(arg.slice('--slippage='.length));
      if (isNaN(val) || val < 0 || val > 1) throw new Error(`Invalid --slippage value: ${val} (must be 0-1)`);
      result.slippage = val;
      continue;
    }
    if (positional === 0) result.router = arg;
    else if (positional === 1) result.path = arg;
    else if (positional === 2) result.amount = arg;
    else if (positional === 3) result.minOut = arg;
    else if (positional === 4) result.deadlineSec = parseInt(arg) || DEFAULT_DEADLINE_SEC;
    else if (positional === 5) result.gasLimit = parseInt(arg) || DEFAULT_GAS_LIMIT;
    positional++;
  }

  if (!result.router || !result.path || !result.amount) {
    throw new Error('Usage: router swap <router> <path> <amount> [minOut] [deadlineSec] [gasLimit] [--dry-run] [--slippage=X]');
  }
  return result;
}

function showHelp(command, subcommand) {
  const help = {
    '': `Usage: node dex.js [--version] [--config=path] <command> [subcommand] [args]

Global options:
  --version, -v              Show CLI version
  --config=<path>            Path to config file (default: config/dex.json)
  --help, -h                 Show this help

Native QUAI:
  native balance                              Native balance
  native transfer <to> <amount>               Send native QUAI

Token (any ERC20):
  token balance <token> [owner]               ERC20 balance
  token transfer <token> <to> <amount>        ERC20 transfer
  token approve <token> <spender> <amount>    ERC20 approve
  token allowance <token> [owner] <spender>   ERC20 allowance
  token info <token>                          Token info (name, symbol, decimals)
  token list                                  List all registered tokens

Router (any UniswapV2-compatible):
  router quote <router> <path> <amount>       Swap quote
  router swap <router> <path> <amount> [minOut] [deadlineSec] [gasLimit] [--dry-run] [--slippage=X]
  router list                                 List all registered routers

Shortcuts:
  balances                                    All balances (native + tokens)

Swap options:
  --dry-run          Simulate swap without executing
  --slippage=X       Slippage tolerance (0-1, default: ${DEFAULT_SLIPPAGE})

Examples:
  node src/dex.js --version
  node src/dex.js --config=my-config.json token balance WQUAI
  node src/dex.js native balance
  node src/dex.js token transfer WQUAI 0xRecipient... 10
  node src/dex.js router swap quaiswap WQUAI,WQI 1 --slippage=0.03
  node src/dex.js router swap quaiswap QUAI,WQI 1 --dry-run`,
  };

  if (command && help[command]) { console.log(help[command]); return true; }
  console.log(help['']);
  return true;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const cmds = {
  native: {
    balance: (c) => c.nativeBalance(),
    transfer: (c, a) => { if (a.length < 2) throw new Error('Usage: native transfer <to> <amount>'); return c.nativeTransfer(a[0], a[1]); },
  },
  token: {
    balance: (c, a) => { if (!a[0]) throw new Error('Usage: token balance <token> [owner]'); return c.tokenBalance(a[0], a[1]); },
    transfer: (c, a) => { if (a.length < 3) throw new Error('Usage: token transfer <token> <to> <amount>'); return c.tokenTransfer(a[0], a[1], a[2]); },
    approve: (c, a) => { if (a.length < 3) throw new Error('Usage: token approve <token> <spender> <amount>'); return c.tokenApprove(a[0], a[1], a[2]); },
    allowance: (c, a) => {
      if (a.length < 2) throw new Error('Usage: token allowance <token> <spender> [owner]');
      const spenderRef = a[1];
      const owner = a[2] || null;
      return c.tokenAllowance(a[0], owner, spenderRef);
    },
    info: (c, a) => { if (!a[0]) throw new Error('Usage: token info <token>'); return c.tokenInfo(a[0]); },
    list: (c) => c.tokenList(),
  },
  router: {
    quote: (c, a) => { if (a.length < 3) throw new Error('Usage: router quote <router> <path> <amount>'); return c.routerQuote(a[0], a[1], a[2]); },
    swap: (c, a) => {
      const parsed = parseSwapArgs(a);
      return c.routerSwap(parsed.router, parsed.path, parsed.amount, parsed.minOut, parsed.deadlineSec, parsed.gasLimit, parsed.dryRun, parsed.slippage);
    },
    list: (c) => c.routerList(),
  },
  balances: (c) => c.allBalances(),
};

const [,, command, sub, ...args] = effectiveArgv;

if (globalFlags.showVersion) {
  console.log(`qdex CLI v${CLI_VERSION}`);
  console.log(clr.dim(`Config: ${CONFIG_PATH}`));
  console.log(clr.dim(`RPC: ${RPC_URL}`));
  process.exit(0);
}

if (command === '--help' || command === '-h' || (sub === '--help' || sub === '-h')) {
  showHelp(command, sub);
  process.exit(0);
}

if (!command) {
  showHelp();
  process.exit(1);
}

const handler = cmds[command];
if (!handler) {
  console.error(clr.red(`❌ Unknown command: ${command}`));
  console.log(clr.dim('Run with --help for usage.'));
  process.exit(1);
}

const client = new Client();

(async () => {
  try {
    await client.detectNetwork();
  } catch (e) {
    console.error(clr.yellow(`⚠️  Could not detect network: ${e.message}`));
    console.log(clr.dim('   Continuing anyway...'));
  }

  if (typeof handler === 'object' && sub) {
    const fn = handler[sub];
    if (!fn) { console.error(clr.red(`❌ Unknown ${command} subcommand: ${sub}`)); process.exit(1); }
    try {
      await fn(client, args);
    } catch (e) {
      console.error(clr.red(`❌ ${e.message}`));
      process.exit(1);
    }
    process.exit(0);
  } else if (typeof handler === 'function') {
    try {
      await handler(client, args);
    } catch (e) {
      console.error(clr.red(`❌ ${e.message}`));
      process.exit(1);
    }
    process.exit(0);
  } else {
    console.error(clr.red(`❌ Missing subcommand for: ${command}`));
    showHelp(command);
    process.exit(1);
  }
})();
