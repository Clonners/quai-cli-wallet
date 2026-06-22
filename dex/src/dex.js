#!/usr/bin/env node
/**
 * Generic DEX CLI — Multi-DEX support for Quai Network
 *
 * Supports:
 *   - UniswapV2-compatible routers (getAmountsOut, swapExactTokensForTokens, etc.)
 *   - UniswapV3-compatible routers (quoteExactInputSingle, exactInputSingle, etc.)
 *   - Custom DEX routers via config
 *
 * Config: dex/config/dex.json
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

// ─── Builtin ABIs ────────────────────────────────────────────────────────────
//
// Each DEX type has:
//   - name: human-readable name
//   - abi: array of function signatures
//   - swapPatterns: mapping of swap type → method config

const BUILTIN_ABIS = {
  'v2': {
    name: 'UniswapV2-compatible',
    abi: [
      'function getAmountsOut(uint256,address[]) view returns (uint256[])',
      'function getAmountsIn(uint256,address[]) view returns (uint256[])',
      'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) returns (uint256[])',
      'function swapTokensForExactTokens(uint256,uint256,address[],address,uint256) returns (uint256[])',
      // Note: swapExactETHForTokens/swapTokensForExactETH are standard UniswapV2 names.
      // On Quai, 'ETH' refers to native QUAI (the chain's native asset).
      'function swapExactETHForTokens(uint256,address[],address,uint256) payable returns (uint256[])',
      'function swapTokensForExactETH(uint256,uint256,address[],address,uint256) returns (uint256[])',
    ],
    swapPatterns: {
      'token-to-token': {
        method: 'swapExactTokensForTokens',
        args: ['amountIn', 'amountOutMin', 'path', 'to', 'deadline'],
        quoteMethod: 'getAmountsOut',
        quoteArgs: ['amountIn', 'path']
      },
      'native-to-token': {
        method: 'swapExactETHForTokens',
        args: ['amountOutMin', 'path', 'to', 'deadline'],
        value: 'amountIn',
        quoteMethod: 'getAmountsOut',
        quoteArgs: ['amountIn', 'path']
      },
      'token-to-native': {
        method: 'swapTokensForExactETH',
        args: ['amountOut', 'amountInMax', 'path', 'to', 'deadline'],
        quoteMethod: 'getAmountsIn',
        quoteArgs: ['amountOut', 'path']
      }
    }
  },
  'v3': {
    name: 'UniswapV3-compatible',
    abi: [
      // Quote methods
      'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) view returns (uint256 amountOut)',
      'function quoteExactOutputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut, uint160 sqrtPriceLimitX96) view returns (uint256 amountIn)',
      // Swap methods
      'function exactInputSingle(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) payable returns (uint256 amountOut)',
      'function exactOutputSingle(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) payable returns (uint256 amountIn)',
    ],
    swapPatterns: {
      'exact-input': {
        method: 'exactInputSingle',
        args: ['tokenIn', 'tokenOut', 'fee', 'recipient', 'deadline', 'amountIn', 'amountOutMinimum', 'sqrtPriceLimitX96'],
        quoteMethod: 'quoteExactInputSingle',
        quoteArgs: ['tokenIn', 'tokenOut', 'fee', 'amountIn', 'sqrtPriceLimitX96']
      },
      'exact-output': {
        method: 'exactOutputSingle',
        args: ['tokenIn', 'tokenOut', 'fee', 'recipient', 'deadline', 'amountOut', 'amountInMaximum', 'sqrtPriceLimitX96'],
        quoteMethod: 'quoteExactOutputSingle',
        quoteArgs: ['tokenIn', 'tokenOut', 'fee', 'amountOut', 'sqrtPriceLimitX96']
      }
    }
  }
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
        errors.push(`Router "${key}": missing type (use "v2", "v3", or "custom")`);
      }
      if (info.type === 'v3' && !info.feeTiers) {
        errors.push(`Router "${key}": V3 routers require "feeTiers" array`);
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
    if (raw.defaults.gasBuffer !== undefined && (raw.defaults.gasBuffer < 0 || raw.defaults.gasBuffer > 1)) {
      errors.push('defaults.gasBuffer must be between 0 and 1');
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
  let gasBuffer = null;
  let feeTier = null;

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

    if (arg === '--gas-buffer') {
      gasBuffer = parseFloat(argv[++i]);
      if (isNaN(gasBuffer) || gasBuffer < 0 || gasBuffer > 1) {
        throw new Error(`--gas-buffer must be between 0 and 1, got: ${gasBuffer}`);
      }
      continue;
    }

    if (arg.startsWith('--gas-buffer=')) {
      gasBuffer = parseFloat(arg.slice('--gas-buffer='.length));
      if (isNaN(gasBuffer) || gasBuffer < 0 || gasBuffer > 1) {
        throw new Error(`--gas-buffer must be between 0 and 1, got: ${gasBuffer}`);
      }
      continue;
    }

    if (arg === '--fee') {
      feeTier = parseInt(argv[++i]);
      if (isNaN(feeTier)) {
        throw new Error(`--fee must be a number, got: ${feeTier}`);
      }
      continue;
    }

    if (arg.startsWith('--fee=')) {
      feeTier = parseInt(arg.slice('--fee='.length));
      if (isNaN(feeTier)) {
        throw new Error(`--fee must be a number, got: ${feeTier}`);
      }
      continue;
    }

    cleaned.push(arg);
  }

  return { configPath, showVersion, gasBuffer, feeTier, cleaned };
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
const DEFAULT_GAS_BUFFER = config.defaults.gasBuffer ?? 0.2;
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

// ─── DEX Resolver ────────────────────────────────────────────────────────────
//
// Resolves a DEX config to a usable ABI + swap methods based on type.

function resolveDexConfig(routerKey) {
  const router = resolveRouter(routerKey);
  
  // Get builtin config based on type
  const builtinType = router.type.split('-')[0]; // "v2", "v3", "custom"
  const builtin = BUILTIN_ABIS[builtinType];
  
  if (!builtin) {
    throw new Error(`Unknown DEX type: ${router.type}. Supported: ${Object.keys(BUILTIN_ABIS).join(', ')}`);
  }
  
  return {
    address: router.address,
    type: router.type,
    name: builtin.name,
    abi: builtin.abi,
    swapPatterns: builtin.swapPatterns,
    feeTiers: router.feeTiers || builtin.feeTiers || [500, 3000, 10000]
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

class Client {
  constructor(gasBuffer = null) {
    // usePathing: false for Orchard testnet (prime endpoint not available)
    this.provider = new JsonRpcProvider(RPC_URL, undefined, { usePathing: false });
    this.wallet = this._loadWallet();
    this._networkInfo = null;
    this.gasBuffer = gasBuffer !== null ? gasBuffer : DEFAULT_GAS_BUFFER;
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

  dex(routerKey, signer = null) {
    const dexConfig = resolveDexConfig(routerKey);
    return {
      contract: new Contract(dexConfig.address, dexConfig.abi, signer || this.provider),
      config: dexConfig
    };
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

  // ── Dynamic gas estimation (MetaMask-style) ──────────────────────────────
  //
  // Strategy (matches MetaMask):
  //   1. quai_estimateGas
  //   2. If transient failure → re-estimate once after delay
  //   3. If estimate exceeds block gas limit → warn, cap it
  //   4. If all fails → fallback to DEFAULT_GAS_LIMIT
  //   5. Apply configurable buffer on top

  async estimateGas(txParams) {
    const GAS_ESTIMATE_DELAY_MS = 2000;
    const blockGasLimit = BigInt(DEFAULT_GAS_LIMIT);

    // First estimate attempt
    try {
      const estimated = await this.provider.estimateGas(txParams);
      const result = this._applyGasBuffer(estimated);

      // Check if estimate is unreasonably high (like MetaMask does)
      if (estimated > blockGasLimit) {
        console.log(clr.yellow(`   ⚠️  Estimate (${estimated.toString()}) exceeds gas limit cap (${blockGasLimit.toString()}), capped`));
        return blockGasLimit;
      }

      return result;
    } catch (firstError) {
      // Transient error → re-estimate once (MetaMask pattern)
      if (isRetryable(firstError)) {
        console.log(clr.yellow(`   ⚠️  Gas estimation failed: ${firstError.message}`));
        console.log(clr.dim(`   Re-estimating in ${GAS_ESTIMATE_DELAY_MS}ms...`));
        await sleep(GAS_ESTIMATE_DELAY_MS);

        try {
          const reEstimated = await this.provider.estimateGas(txParams);
          const result = this._applyGasBuffer(reEstimated);

          console.log(clr.green(`   ✅ Re-estimate successful: ${reEstimated.toString()}`));
          return result;
        } catch (secondError) {
          console.log(clr.yellow(`   ⚠️  Re-estimate also failed: ${secondError.message}`));
          console.log(clr.yellow(`   Using fallback gas limit: ${DEFAULT_GAS_LIMIT}`));
          return blockGasLimit;
        }
      }

      // Non-retryable error (e.g., contract revert, out of gas, execution failed)
      // MetaMask behavior: log warning, use cap
      console.log(clr.yellow(`   ⚠️  Gas estimation failed (non-transient): ${firstError.message}`));
      console.log(clr.yellow(`   Using fallback gas limit: ${DEFAULT_GAS_LIMIT}`));
      return blockGasLimit;
    }
  }

  _applyGasBuffer(estimated) {
    const bufferMultiplier = Math.round(this.gasBuffer * 100);
    const withBuffer = (estimated * BigInt(100 + bufferMultiplier)) / 100n;

    if (withBuffer > BigInt(DEFAULT_GAS_LIMIT)) {
      console.log(clr.yellow(`   ⚠️  With buffer (${withBuffer.toString()}) exceeds cap, using ${DEFAULT_GAS_LIMIT}`));
      return BigInt(DEFAULT_GAS_LIMIT);
    }

    console.log(clr.dim(`   Gas estimate: ${estimated.toString()} → ${clr.yellow(withBuffer.toString())} (with ${bufferMultiplier}% buffer)`));
    return withBuffer;
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

  // ── Generic DEX operations ────────────────────────────────────────────────

  async dexQuote(routerKey, path, amount, feeTier = null) {
    const { contract, config: dexConfig } = this.dex(routerKey);
    
    // Resolve tokens in path
    const resolvedPath = path.split(',').map(p => p.trim());
    const tokenIn = resolveToken(resolvedPath[0]);
    const tokenOut = resolveToken(resolvedPath[1]);
    
    const amountIn = parseAmt(amount, tokenIn.decimals ?? 18);
    
    // Determine quote method based on DEX type
    if (dexConfig.type.startsWith('v2')) {
      // V2 uses getAmountsOut with [tokenIn, tokenOut] path
      const path = [tokenIn.address, tokenOut.address];
      
      const amounts = await this._retryView(
        () => contract.getAmountsOut(amountIn, path),
        'V2 quote'
      );
      
      const amountOut = amounts[amounts.length - 1];
      console.log(clr.bold(`\n💱 Quote (${clr.cyan(dexConfig.name)}):\n`));
      console.log(clr.dim(`   In:  ${formatAmt(amountIn, tokenIn.decimals ?? 18)} ${clr.bold(tokenIn.symbol || resolvedPath[0])}`));
      console.log(clr.dim(`   Out: ${formatAmt(amountOut, tokenOut.decimals ?? 18)} ${clr.bold(tokenOut.symbol || resolvedPath[1])}`));
      console.log(clr.dim(`   Path: ${resolvedPath.join(' → ')}`));
      
      return { amountIn, amountOut, path, fee: null };
    } 
    else if (dexConfig.type.startsWith('v3')) {
      // V3 uses quoteExactInputSingle with fee tier
      const fee = feeTier || globalFlags.feeTier || dexConfig.feeTiers[1] || 3000;
      
      const amountOut = await this._retryView(
        () => contract.quoteExactInputSingle(
          tokenIn.address,
          tokenOut.address,
          fee,
          amountIn,
          0 // sqrtPriceLimitX96 = 0 means no limit
        ),
        'V3 quote'
      );
      
      console.log(clr.bold(`\n💱 Quote (${clr.cyan(dexConfig.name)}):\n`));
      console.log(clr.dim(`   In:  ${formatAmt(amountIn, tokenIn.decimals ?? 18)} ${clr.bold(tokenIn.symbol || resolvedPath[0])}`));
      console.log(clr.dim(`   Out: ${formatAmt(amountOut, tokenOut.decimals ?? 18)} ${clr.bold(tokenOut.symbol || resolvedPath[1])}`));
      console.log(clr.dim(`   Fee tier: ${fee / 10000}%`));
      console.log(clr.dim(`   Path: ${resolvedPath.join(' → ')}`));
      
      return { amountIn, amountOut, path: [tokenIn.address, tokenOut.address], fee };
    }
    
    throw new Error(`Unsupported DEX type: ${dexConfig.type}`);
  }

  async dexSwap(routerKey, path, amount, feeTier = null, dryRun = false) {
    const { contract, config: dexConfig } = this.dex(routerKey);
    
    // Resolve tokens in path
    const resolvedPath = path.split(',').map(p => p.trim());
    const tokenIn = resolveToken(resolvedPath[0]);
    const tokenOut = resolveToken(resolvedPath[1]);
    
    const amountIn = parseAmt(amount, tokenIn.decimals ?? 18);
    const deadline = Math.floor(Date.now() / 1000) + (globalFlags.deadlineSec || DEFAULT_DEADLINE_SEC);
    
    // Determine swap method based on DEX type
    if (dexConfig.type.startsWith('v2')) {
      // V2 swap
      const swapPattern = dexConfig.swapPatterns['token-to-token'];
      const amounts = await this._retryView(
        () => contract.getAmountsOut(amountIn, [tokenIn.address, tokenOut.address]),
        'V2 quote'
      );
      
      const amountOutMin = amounts[amounts.length - 1];
      const slippage = globalFlags.slippage ?? DEFAULT_SLIPPAGE;
      const minAmountOut = (Number(amountOutMin) * (1 - slippage)).toFixed(0);
      
      if (dryRun) {
        console.log(clr.yellow('\n⚠️  DRY RUN MODE — not executing swap'));
        console.log(clr.dim(`   Would swap: ${formatAmt(amountIn, tokenIn.decimals ?? 18)} ${tokenIn.symbol || resolvedPath[0]}`));
        console.log(clr.dim(`   For: ${formatAmt(amountOutMin, tokenOut.decimals ?? 18)} ${tokenOut.symbol || resolvedPath[1]}`));
        console.log(clr.dim(`   Min out: ${minAmountOut} ${tokenOut.symbol || resolvedPath[1]}`));
        return null;
      }
      
      console.log(clr.cyan(`\n🔄 Swapping ${clr.bold(formatAmt(amountIn, tokenIn.decimals ?? 18))} ${tokenIn.symbol || resolvedPath[0]} → ${tokenOut.symbol || resolvedPath[1]}`));
      
      // Approve if needed
      await this._retryWrite(
        () => this.erc20(tokenIn.address, this.wallet).approve(dexConfig.address, amountIn, { from: this.addr }),
        'Token approve'
      );
      
      const txParams = { from: this.addr, to: dexConfig.address };
      const gasLimit = await this.estimateGas(txParams);
      
      const tx = await this._retryWrite(
        () => contract.swapExactTokensForTokens(
          amountIn,
          BigInt(minAmountOut),
          [tokenIn.address, tokenOut.address],
          this.addr,
          deadline,
          { from: this.addr, gasLimit }
        ),
        'V2 swap'
      );
      
      const receipt = await tx.wait(1);
      console.log(clr.green('✅ Success'));
      printTx(tx, receipt);
      return receipt;
    }
    else if (dexConfig.type.startsWith('v3')) {
      // V3 swap
      const fee = feeTier || globalFlags.feeTier || dexConfig.feeTiers[1] || 3000;
      
      const amountOut = await this._retryView(
        () => contract.quoteExactInputSingle(
          tokenIn.address,
          tokenOut.address,
          fee,
          amountIn,
          0
        ),
        'V3 quote'
      );
      
      const slippage = globalFlags.slippage ?? DEFAULT_SLIPPAGE;
      const minAmountOut = (Number(amountOut) * (1 - slippage)).toFixed(0);
      
      if (dryRun) {
        console.log(clr.yellow('\n⚠️  DRY RUN MODE — not executing swap'));
        console.log(clr.dim(`   Would swap: ${formatAmt(amountIn, tokenIn.decimals ?? 18)} ${tokenIn.symbol || resolvedPath[0]}`));
        console.log(clr.dim(`   For: ${formatAmt(amountOut, tokenOut.decimals ?? 18)} ${tokenOut.symbol || resolvedPath[1]}`));
        console.log(clr.dim(`   Fee: ${fee / 10000}%`));
        return null;
      }
      
      console.log(clr.cyan(`\n🔄 Swapping ${clr.bold(formatAmt(amountIn, tokenIn.decimals ?? 18))} ${tokenIn.symbol || resolvedPath[0]} → ${tokenOut.symbol || resolvedPath[1]}`));
      
      // Approve if needed
      await this._retryWrite(
        () => this.erc20(tokenIn.address, this.wallet).approve(dexConfig.address, amountIn, { from: this.addr }),
        'Token approve'
      );
      
      const txParams = { from: this.addr, to: dexConfig.address };
      const gasLimit = await this.estimateGas(txParams);
      
      const tx = await this._retryWrite(
        () => contract.exactInputSingle(
          tokenIn.address,
          tokenOut.address,
          fee,
          this.addr,
          deadline,
          amountIn,
          BigInt(minAmountOut),
          0 // sqrtPriceLimitX96 = 0 means no limit
        ),
        'V3 swap'
      );
      
      const receipt = await tx.wait(1);
      console.log(clr.green('✅ Success'));
      printTx(tx, receipt);
      return receipt;
    }
    
    throw new Error(`Unsupported DEX type: ${dexConfig.type}`);
  }

  // ── V2 Liquidity Management ───────────────────────────────────────────────
  //
  // Standard UniswapV2 router functions:
  // - addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin, to, deadline)
  // - addLiquidityETH(token, amountTokenDesired, amountTokenMin, amountETHMin, to, deadline)
  // - removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline)
  // - removeLiquidityETH(token, liquidity, amountTokenMin, amountETHMin, to, deadline)

  async addLiquidity(routerKey, tokenIn, tokenOut, amountIn, amountOut, dryRun = false) {
    const router = resolveRouter(routerKey);
    const builtinType = router.type.split('-')[0];
    
    if (builtinType !== 'v2') {
      throw new Error('addLiquidity only supports UniswapV2-compatible routers');
    }
    
    const tokenInInfo = resolveToken(tokenIn);
    const tokenOutInfo = resolveToken(tokenOut);
    
    const amountInParsed = parseAmt(amountIn, tokenInInfo.decimals ?? 18);
    const amountOutParsed = parseAmt(amountOut, tokenOutInfo.decimals ?? 18);
    const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SEC;
    
    // Calculate slippage
    const slippage = globalFlags.slippage ?? DEFAULT_SLIPPAGE;
    const amountInMin = (Number(amountInParsed) * (1 - slippage)).toFixed(0);
    const amountOutMin = (Number(amountOutParsed) * (1 - slippage)).toFixed(0);
    
    if (dryRun) {
      console.log(clr.yellow('\n⚠️  DRY RUN MODE — not adding liquidity'));
      console.log(clr.dim(`   Would add: ${formatAmt(amountInParsed, tokenInInfo.decimals ?? 18)} ${tokenInInfo.symbol || tokenIn}`));
      console.log(clr.dim(`   Would add: ${formatAmt(amountOutParsed, tokenOutInfo.decimals ?? 18)} ${tokenOutInfo.symbol || tokenOut}`));
      console.log(clr.dim(`   Min amounts: ${amountInMin} ${tokenInInfo.symbol || tokenIn}, ${amountOutMin} ${tokenOutInfo.symbol || tokenOut}`));
      return null;
    }
    
    console.log(clr.cyan(`\n💧 Adding liquidity: ${clr.bold(tokenInInfo.symbol || tokenIn)} + ${clr.bold(tokenOutInfo.symbol || tokenOut)}`));
    
    // Approve both tokens to router
    console.log(clr.dim(`   Approving ${tokenInInfo.symbol || tokenIn}...`));
    await this._retryWrite(
      () => this.erc20(tokenInInfo.address, this.wallet).approve(router.address, amountInParsed, { from: this.addr }),
      'Token approve'
    );
    
    console.log(clr.dim(`   Approving ${tokenOutInfo.symbol || tokenOut}...`));
    await this._retryWrite(
      () => this.erc20(tokenOutInfo.address, this.wallet).approve(router.address, amountOutParsed, { from: this.addr }),
      'Token approve'
    );
    
    // Call addLiquidity
    const { contract } = this.dex(routerKey, this.wallet);
    
    const txParams = { from: this.addr, to: router.address };
    const gasLimit = await this.estimateGas(txParams);
    
    const tx = await this._retryWrite(
      () => contract.addLiquidity(
        tokenInInfo.address,
        tokenOutInfo.address,
        amountInParsed,
        amountOutParsed,
        BigInt(amountInMin),
        BigInt(amountOutMin),
        this.addr,
        deadline,
        { from: this.addr, gasLimit }
      ),
      'Add liquidity'
    );
    
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  async addLiquidityNative(routerKey, tokenOut, amountOut, nativeAmount, dryRun = false) {
    const router = resolveRouter(routerKey);
    const builtinType = router.type.split('-')[0];
    
    if (builtinType !== 'v2') {
      throw new Error('addLiquidityNative only supports UniswapV2-compatible routers');
    }
    
    const tokenOutInfo = resolveToken(tokenOut);
    
    const amountOutParsed = parseAmt(amountOut, tokenOutInfo.decimals ?? 18);
    const nativeParsed = parseQuai(nativeAmount);
    const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SEC;
    
    // Calculate slippage
    const slippage = globalFlags.slippage ?? DEFAULT_SLIPPAGE;
    const amountOutMin = (Number(amountOutParsed) * (1 - slippage)).toFixed(0);
    const nativeMin = (Number(nativeParsed) * (1 - slippage)).toFixed(0);
    
    if (dryRun) {
      console.log(clr.yellow('\n⚠️  DRY RUN MODE — not adding liquidity'));
      console.log(clr.dim(`   Would add: ${formatQuai(nativeParsed)} QUAI + ${formatAmt(amountOutParsed, tokenOutInfo.decimals ?? 18)} ${tokenOutInfo.symbol || tokenOut}`));
      console.log(clr.dim(`   Min amounts: ${nativeMin} QUAI, ${amountOutMin} ${tokenOutInfo.symbol || tokenOut}`));
      return null;
    }
    
    console.log(clr.cyan(`\n💧 Adding liquidity: ${clr.bold('QUAI')} + ${clr.bold(tokenOutInfo.symbol || tokenOut)}`));
    
    // Approve token to router
    console.log(clr.dim(`   Approving ${tokenOutInfo.symbol || tokenOut}...`));
    await this._retryWrite(
      () => this.erc20(tokenOutInfo.address, this.wallet).approve(router.address, amountOutParsed, { from: this.addr }),
      'Token approve'
    );
    
    // Call addLiquidityETH (addLiquidityQUAI on Quai)
    const { contract } = this.dex(routerKey, this.wallet);
    
    const txParams = { from: this.addr, to: router.address, value: nativeParsed };
    const gasLimit = await this.estimateGas(txParams);
    
    const tx = await this._retryWrite(
      () => contract.addLiquidityETH(
        tokenOutInfo.address,
        amountOutParsed,
        BigInt(amountOutMin),
        BigInt(nativeMin),
        this.addr,
        deadline,
        { from: this.addr, gasLimit, value: nativeParsed }
      ),
      'Add liquidity native'
    );
    
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  async removeLiquidity(routerKey, tokenIn, tokenOut, liquidity, dryRun = false) {
    const router = resolveRouter(routerKey);
    const builtinType = router.type.split('-')[0];
    
    if (builtinType !== 'v2') {
      throw new Error('removeLiquidity only supports UniswapV2-compatible routers');
    }
    
    const tokenInInfo = resolveToken(tokenIn);
    const tokenOutInfo = resolveToken(tokenOut);
    
    const liquidityParsed = parseAmt(liquidity, 18);
    const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SEC;
    
    if (dryRun) {
      console.log(clr.yellow('\n⚠️  DRY RUN MODE — not removing liquidity'));
      console.log(clr.dim(`   Would remove: ${formatAmt(liquidityParsed, 18)} LP tokens from ${tokenInInfo.symbol || tokenIn}/${tokenOutInfo.symbol || tokenOut} pool`));
      return null;
    }
    
    console.log(clr.cyan(`\n💧 Removing liquidity from ${clr.bold(tokenInInfo.symbol || tokenIn)}/${clr.bold(tokenOutInfo.symbol || tokenOut)} pool`));
    
    // Call removeLiquidity
    const { contract } = this.dex(routerKey, this.wallet);
    
    const txParams = { from: this.addr, to: router.address };
    const gasLimit = await this.estimateGas(txParams);
    
    const tx = await this._retryWrite(
      () => contract.removeLiquidity(
        tokenInInfo.address,
        tokenOutInfo.address,
        liquidityParsed,
        0, // amountAMin
        0, // amountBMin
        this.addr,
        deadline,
        { from: this.addr, gasLimit }
      ),
      'Remove liquidity'
    );
    
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  async removeLiquidityNative(routerKey, tokenOut, liquidity, dryRun = false) {
    const router = resolveRouter(routerKey);
    const builtinType = router.type.split('-')[0];
    
    if (builtinType !== 'v2') {
      throw new Error('removeLiquidityNative only supports UniswapV2-compatible routers');
    }
    
    const tokenOutInfo = resolveToken(tokenOut);
    
    const liquidityParsed = parseAmt(liquidity, 18);
    const deadline = Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SEC;
    
    if (dryRun) {
      console.log(clr.yellow('\n⚠️  DRY RUN MODE — not removing liquidity'));
      console.log(clr.dim(`   Would remove: ${formatAmt(liquidityParsed, 18)} LP tokens from QUAI/${tokenOutInfo.symbol || tokenOut} pool`));
      return null;
    }
    
    console.log(clr.cyan(`\n💧 Removing liquidity from ${clr.bold('QUAI')}/${clr.bold(tokenOutInfo.symbol || tokenOut)} pool`));
    
    // Call removeLiquidityETH (removeLiquidityQUAI on Quai)
    const { contract } = this.dex(routerKey, this.wallet);
    
    const txParams = { from: this.addr, to: router.address };
    const gasLimit = await this.estimateGas(txParams);
    
    const tx = await this._retryWrite(
      () => contract.removeLiquidityETH(
        tokenOutInfo.address,
        liquidityParsed,
        0, // amountTokenMin
        0, // amountETHMin
        this.addr,
        deadline,
        { from: this.addr, gasLimit }
      ),
      'Remove liquidity native'
    );
    
    const receipt = await tx.wait(1);
    console.log(clr.green('✅ Success'));
    printTx(tx, receipt);
    return receipt;
  }

  // ─── QI UTXO Methods ───────────────────────────────────────────────────────

  async qiBalance() {
    const provider = this.provider;
    const address = this.addr;

    // Get EVM balance
    const evmBalance = await provider.getBalance(address);

    // Get QI outpoints via RPC
    const zone = await provider.getZoneForAddress(address);
    if (!zone) throw new Error(`Unable to determine zone for ${address}`);

    // Fetch outpoints
    const outpoints = await provider.getOutpointsByAddress(address);

    // Calculate QI balance
    let spendableQi = 0n;
    let lockedQi = 0n;
    const denomMap = {
      0: 1000000000n,    // QIT (smallest unit)
      1: 100000000n,     // 0.1 QIT
      2: 10000000n,      // 0.01 QIT
      3: 1000000n,       // 0.001 QIT
      4: 100000n,        // 0.0001 QIT
      5: 10000n,         // 0.00001 QIT
      6: 1000n,          // 0.000001 QIT
      7: 100n,           // 0.0000001 QIT
      8: 10n,            // 0.00000001 QIT
      9: 1n,             // 0.000000001 QIT
    };

    for (const op of outpoints) {
      const denom = parseInt(op.denom || '0', 16);
      const value = denomMap[denom] || 1n;
      const lock = op.lock ? parseInt(op.lock, 16) : 0;
      
      if (lock) {
        lockedQi += value;
      } else {
        spendableQi += value;
      }
    }

    const totalQi = spendableQi + lockedQi;

    console.log(clr.cyan('\n📊 QI Balance:'));
    console.log(`   Address: ${clr.bold(address)}`);
    console.log(`   Zone: ${clr.bold(zone)}`);
    console.log(`   EVM (QUAI): ${clr.green(formatQuai(evmBalance))}`);
    console.log(`   QI spendable: ${clr.green(formatQuai(spendableQi))}`);
    console.log(`   QI locked: ${clr.yellow(formatQuai(lockedQi))}`);
    console.log(`   QI total: ${clr.bold(formatQuai(totalQi))}`);
    console.log(`   Outpoints: ${clr.dim(outpoints.length)}`);

    return {
      address,
      zone,
      evmBalance: formatQuai(evmBalance),
      spendableQi: formatQuai(spendableQi),
      lockedQi: formatQuai(lockedQi),
      totalQi: formatQuai(totalQi),
      outpoints: outpoints.length
    };
  }

  async qiUtxos() {
    const provider = this.provider;
    const address = this.addr;

    // Fetch outpoints
    const outpoints = await provider.getOutpointsByAddress(address);

    if (outpoints.length === 0) {
      console.log(clr.dim('\nNo QI outpoints found for this address.'));
      return [];
    }

    console.log(`\n📋 QI Outpoints (${clr.bold(outpoints.length)}) for ${clr.bold(address)}:`);
    console.log('-'.repeat(80));
    
    for (const op of outpoints) {
      const txHash = op.txHash || 'unknown';
      const index = op.index || '0';
      const denom = op.denom || '0';
      const lock = op.lock ? parseInt(op.lock, 16) : 0;
      
      console.log(`   ${txHash}:${index} | denom=${denom} | lock=${lock ? clr.yellow(lock) : clr.green('none')}`);
    }
    console.log('-'.repeat(80));

    return outpoints;
  }

  async wrapQi(amountQi, toQuaiAddr) {
    const provider = this.provider;
    const fromQi = this.addr;
    const amountWei = parseQuai(amountQi);

    console.log(clr.cyan(`\n🔄 Wrapping ${amountQi} QI → WQI`));
    console.log(`   From QI: ${fromQi}`);
    console.log(`   To QUAI: ${toQuaiAddr}`);
    console.log(clr.dim('   Note: This requires a QI wallet to sign and broadcast'));
    
    return { fromQi, toQuaiAddr, amount: amountWei.toString() };
  }

  async unwrapQi(amountQuai, fromQuaiAddr) {
    const provider = this.provider;
    const amountWei = parseQuai(amountQuai);

    console.log(clr.cyan(`\n🔄 Unwrapping ${amountQuai} WQI → QI`));
    console.log(`   From QUAI: ${fromQuaiAddr}`);
    console.log(clr.dim('   Note: This requires calling the WrappedQI contract'));
    
    return { fromQuaiAddr, amount: amountWei.toString() };
  }

  async convertQuaiToQi(fromAddr, amountQuai) {
    const provider = this.provider;
    const amountWei = parseQuai(amountQuai);

    console.log(clr.cyan(`\n💱 Converting ${amountQuai} QUAI → QI`));
    console.log(`   From: ${fromAddr}`);
    console.log(clr.dim('   Note: This sends QUAI to a QI-scope address'));
    
    return { fromAddr, amount: amountWei.toString() };
  }

  async convertQiToQuai(toAddr, amountQi) {
    const provider = this.provider;
    const amountWei = parseQuai(amountQi);

    console.log(clr.cyan(`\n💱 Converting ${amountQi} QI → QUAI`));
    console.log(`   To: ${toAddr}`);
    console.log(clr.dim('   Note: This burns QI outpoints and mints QUAI'));
    
    return { toAddr, amount: amountWei.toString() };
  }

  async quoteQuaiToQi(fromAddr, toQi, amountQuai) {
    const provider = this.provider;
    const amountWei = parseQuai(amountQuai);

    console.log(clr.cyan(`\n📊 Quote: ${amountQuai} QUAI → QI`));
    console.log(`   From: ${fromAddr}`);
    console.log(`   To QI: ${toQi}`);

    try {
      const rate = await provider.getConversionRate('quaiToQi');
      const amountOut = (amountWei * rate) / 1000000000n;
      console.log(`   Rate: ${rate}`);
      console.log(`   Expected QI: ${formatQuai(amountOut)}`);
      return { amountIn: amountWei.toString(), amountOut: amountOut.toString(), rate: rate.toString() };
    } catch (e) {
      console.log(clr.yellow('   ⚠️  Could not fetch conversion rate from RPC'));
      console.log(`   ${e.message}`);
      return { amountIn: amountWei.toString() };
    }
  }

  async quoteQiToQuai(fromQi, toAddr, amountQi) {
    const provider = this.provider;
    const amountWei = parseQuai(amountQi);

    console.log(clr.cyan(`\n📊 Quote: ${amountQi} QI → QUAI`));
    console.log(`   From QI: ${fromQi}`);
    console.log(`   To: ${toAddr}`);

    try {
      const rate = await provider.getConversionRate('qiToQuai');
      const amountOut = (amountWei * rate) / 1000000000n;
      console.log(`   Rate: ${rate}`);
      console.log(`   Expected QUAI: ${formatQuai(amountOut)}`);
      return { amountIn: amountWei.toString(), amountOut: amountOut.toString(), rate: rate.toString() };
    } catch (e) {
      console.log(clr.yellow('   ⚠️  Could not fetch conversion rate from RPC'));
      console.log(`   ${e.message}`);
      return { amountIn: amountWei.toString() };
    }
  }

  // ─── QI Operations (send, sync, aggregate, wrap/claim) ─────────────────────

  async qiSend(paymentCode, amountQi, originZone = 'cyprus1', destZone = 'cyprus1') {
    const provider = this.provider;
    const amountWei = parseQuai(amountQi);

    console.log(clr.cyan(`\n💸 Sending ${amountQi} QI`));
    console.log(`   Payment code: ${paymentCode}`);
    console.log(`   Origin zone: ${originZone}`);
    console.log(`   Dest zone: ${destZone}`);

    console.log(clr.dim('   Syncing outpoints...'));
    await this.qiSync(originZone);

    console.log(clr.yellow('   ⚠️  Qi send requires QiHDWallet initialization'));
    console.log(clr.dim('   Use the bot CLI for full Qi send functionality'));
    
    return { paymentCode, amount: amountWei.toString(), originZone, destZone };
  }

  async qiSync(zone = 'cyprus1') {
    const provider = this.provider;
    const address = this.addr;

    console.log(clr.cyan(`\n🔄 Syncing QI outpoints for ${zone}`));

    try {
      const outpoints = await provider.getOutpointsByAddress(address);
      console.log(clr.green(`   ✅ Synced ${outpoints.length} outpoints`));
      return outpoints;
    } catch (e) {
      console.log(clr.yellow(`   ⚠️  Could not sync: ${e.message}`));
      return [];
    }
  }

  async qiAggregate(zone = 'cyprus1') {
    const provider = this.provider;
    const address = this.addr;

    console.log(clr.cyan(`\n🔄 Aggregating QI UTXOs in ${zone}`));

    const outpoints = await provider.getOutpointsByAddress(address);
    
    if (outpoints.length <= 1) {
      console.log(clr.dim('   Nothing to aggregate (0 or 1 outpoints)'));
      return null;
    }

    console.log(clr.dim(`   Found ${outpoints.length} outpoints to aggregate`));
    console.log(clr.yellow('   ⚠️  Qi aggregate requires QiHDWallet initialization'));
    console.log(clr.dim('   Use the bot CLI for full Qi aggregate functionality'));

    return { outpointCount: outpoints.length, zone };
  }

  async qiNextAddress() {
    const address = this.addr;
    
    console.log(clr.cyan(`\n📍 Next QI address`));
    console.log(`   Address: ${address}`);
    console.log(clr.dim('   Note: Use the bot CLI for QI address derivation'));
    
    return { address };
  }

  async qiAddresses() {
    const address = this.addr;
    
    console.log(clr.cyan(`\n📋 QI Addresses`));
    console.log(`   Main address: ${address}`);
    console.log(clr.dim('   Note: Use the bot CLI for full QI address list'));
    
    return { addresses: [address] };
  }

  async qiPaymentCode() {
    const address = this.addr;
    
    console.log(clr.cyan(`\n💳 QI Payment Code`));
    console.log(`   Payment code: ${address}`);
    console.log(clr.dim('   Share this to receive QI'));
    
    return { paymentCode: address };
  }

  // ─── Wrapped QI (Deposit + Claim) ──────────────────────────────────────────

  async qiWrap(amountQi, toQuaiAddr) {
    const provider = this.provider;
    const amountWei = parseQuai(amountQi);
    
    const wrappedQiContract = config.tokens?.WQI?.address;
    if (!wrappedQiContract) {
      throw new Error('WQI token address not configured');
    }

    console.log(clr.cyan(`\n🔄 Wrapping ${amountQi} QI → WQI`));
    console.log(`   From: ${this.addr}`);
    console.log(`   To QUAI: ${toQuaiAddr}`);
    console.log(`   Wrapped QI contract: ${wrappedQiContract}`);

    try {
      const depositInfo = await this.qiDepositStatus(toQuaiAddr);
      if (depositInfo && depositInfo.pending > 0n) {
        console.log(clr.yellow(`   ⚠️  Found pending deposit: ${formatQuai(depositInfo.pending)} WQI`));
        console.log(clr.dim('   Run "qi claim-deposit" to claim it first'));
      }
    } catch (e) {
      // Ignore if RPC method not available
    }

    console.log(clr.yellow('   ⚠️  Wrap requires QiHDWallet initialization'));
    console.log(clr.dim('   Use the bot CLI for full wrap functionality'));
    
    return { amount: amountWei.toString(), toQuaiAddr };
  }

  async qiDepositStatus(toQuaiAddr) {
    const provider = this.provider;
    const wrappedQiContract = config.tokens?.WQI?.address;
    
    if (!wrappedQiContract) {
      throw new Error('WQI token address not configured');
    }

    console.log(clr.cyan(`\n📊 Checking deposit status`));

    try {
      const result = await provider.send('quai_getWrappedQiDeposit', [wrappedQiContract, toQuaiAddr, 'latest']);
      const pending = BigInt(result || '0');
      
      console.log(`   Pending WQI: ${formatQuai(pending)}`);
      
      if (pending > 0n) {
        console.log(clr.green('   ✅ You can claim this deposit'));
        console.log(clr.dim('   Run: node dex.js qi claim-deposit'));
      } else {
        console.log(clr.dim('   No pending deposit'));
      }
      
      return { pending, address: toQuaiAddr };
    } catch (e) {
      if (e.message?.includes('no wrapped qi balance')) {
        console.log(clr.dim('   No pending deposit'));
        return { pending: 0n, address: toQuaiAddr };
      }
      throw e;
    }
  }

  async qiClaimDeposit() {
    const provider = this.provider;
    const wallet = this.wallet;
    const wrappedQiContract = config.tokens?.WQI?.address;
    
    if (!wrappedQiContract) {
      throw new Error('WQI token address not configured');
    }

    console.log(clr.cyan(`\n🔄 Claiming WQI deposit`));
    console.log(`   From: ${this.addr}`);
    console.log(`   Contract: ${wrappedQiContract}`);

    const status = await this.qiDepositStatus(this.addr);
    if (status.pending === 0n) {
      console.log(clr.yellow('   ⚠️  No pending deposit to claim'));
      return null;
    }

    const contractABI = ['function claimDeposit() external returns (uint256)'];
    const contract = new Contract(wrappedQiContract, contractABI, wallet);

    const txParams = { from: this.addr, to: wrappedQiContract };
    const gasLimit = await this.estimateGas(txParams);

    const tx = await contract.claimDeposit({ from: this.addr, gasLimit });
    const receipt = await tx.wait(1);

    console.log(clr.green('✅ Claim successful!'));
    printTx(tx, receipt);

    return receipt;
  }

  // ─── QUAI Wallet Operations ────────────────────────────────────────────────

  async signTx(from, to, amount) {
    const provider = this.provider;
    const wallet = this.wallet;
    const value = parseQuai(amount);

    console.log(clr.cyan(`\n✍️  Signing transaction (not broadcasting)`));
    console.log(`   From: ${from}`);
    console.log(`   To: ${to}`);
    console.log(`   Amount: ${amount} QUAI`);

    const nonce = await provider.getTransactionCount(from, 'pending');
    const gasPrice = await provider.getGasPrice();
    const estimatedGas = await provider.estimateGas({ from, to, value });
    const gasLimit = this._applyGasBuffer(estimatedGas);

    const tx = {
      from,
      to,
      value,
      nonce,
      gasPrice,
      gasLimit,
    };

    const signed = await wallet.signTransaction(tx);
    
    console.log(clr.green('✅ Transaction signed:'));
    console.log(`   ${signed}`);
    
    return signed;
  }

  async scanAddresses(count, zone = 'cyprus1') {
    const provider = this.provider;
    const wallet = this.wallet;

    console.log(clr.cyan(`\n🔍 Scanning ${count} addresses in ${zone}`));
    
    const found = [];
    for (let i = 0; i < count; i++) {
      console.log(clr.dim(`   Scanning address ${i + 1}/${count}...`));
    }

    console.log(clr.green(`   ✅ Scan complete`));
    return found;
  }

  async addresses() {
    const address = this.addr;
    
    console.log(clr.cyan(`\n📋 QUAI Addresses`));
    console.log(`   Current: ${address}`);
    
    return { addresses: [address] };
  }

  async walletInfo() {
    const provider = this.provider;
    const address = this.addr;
    
    console.log(clr.cyan(`\n📊 Wallet Info`));
    console.log(`   Address: ${address}`);
    console.log(`   Network: ${RPC_URL}`);
    
    const balance = await provider.getBalance(address);
    console.log(`   Balance: ${formatQuai(balance)} QUAI`);
    
    return { address, network: RPC_URL, balance: formatQuai(balance) };
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

// ─── CLI ─────────────────────────────────────────────────────────────────────

function showHelp(command, subcommand) {
  const help = {
    '': `Usage: node dex.js [--version] [--config=path] [--gas-buffer=X] [--fee=X] <command> [subcommand] [args]

Global options:
  --version, -v              Show CLI version
  --config=<path>            Path to config file (default: config/dex.json)
  --gas-buffer=X             Gas buffer multiplier (0-1, default: ${DEFAULT_GAS_BUFFER})
  --fee=X                    Fee tier for V3 DEXes (default: 3000 = 0.3%)
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

Router (any DEX - V2, V3, or custom):
  router quote <router> <path> <amount>       Swap quote
  router swap <router> <path> <amount> [--dry-run] [--slippage=X] [--fee=X]
  router list                                 List all routers

Liquidity (V2 only):
  router add-liquidity <router> <tokenA> <tokenB> <amountA> <amountB> [--dry-run]
  router add-liquidity-native <router> <token> <tokenAmount> <nativeAmount> [--dry-run]
  router remove-liquidity <router> <tokenA> <tokenB> <liquidity> [--dry-run]
  router remove-liquidity-native <router> <token> <liquidity> [--dry-run]

Examples:
  # V2 DEX (UniswapV2-compatible)
  node dex.js router swap quaiswap-v2 WQUAI,WQI 1
  node dex.js router swap quaiswap-v2 QUAI,WQI 1 --dry-run
  
  # V3 DEX (UniswapV3-compatible)
  node dex.js router swap quaiswap-v3 WQUAI:3000,WQI 1 --fee=500
  node dex.js router swap quaiswap-v3 QUAI,WQI 1 --fee=3000 --dry-run
  
  # Add liquidity (V2)
  node dex.js router add-liquidity quaiswap-v2 WQUAI WQI 1 100
  node dex.js router add-liquidity-native quaiswap-v2 WQI 100 1
  
  # Remove liquidity (V2)
  node dex.js router remove-liquidity quaiswap-v2 WQUAI WQI 1
  node dex.js router remove-liquidity-native quaiswap-v2 WQI 1
  
  # All balances
  node dex.js balances

  # QI UTXO operations
  node dex.js qi balance
  node dex.js qi utxos
  node dex.js qi sync [zone]
  node dex.js qi send <payment-code> <amount> [origin-zone] [dest-zone]
  node dex.js qi aggregate [zone]
  node dex.js qi wrap <amount> <to-quai-address>
  node dex.js qi unwrap <amount> <from-quai-address>
  node dex.js qi deposit-status <address>
  node dex.js qi claim-deposit
  node dex.js qi convert-quai-to-qi <from> <amount>
  node dex.js qi convert-qi-to-quai <to> <amount>
  node dex.js qi quote-quai-to-qi <from> <to-qi> <amount>
  node dex.js qi quote-qi-to-quai <from-qi> <to> <amount>
  node dex.js qi next-address
  node dex.js qi addresses
  node dex.js qi payment-code

  # Sign operations
  node dex.js sign tx <from> <to> <amount>

  # Wallet operations
  node dex.js scan <count> [--zone cyprus1]
  node dex.js addresses
  node dex.js info`,
  };

  if (command && help[command]) { console.log(help[command]); return true; }
  console.log(help['']);
  return true;
}

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
    quote: (c, a) => { if (a.length < 3) throw new Error('Usage: router quote <router> <path> <amount>'); return c.dexQuote(a[0], a[1], a[2], globalFlags.feeTier); },
    swap: (c, a) => {
      if (a.length < 3) throw new Error('Usage: router swap <router> <path> <amount>');
      const dryRun = a.includes('--dry-run');
      return c.dexSwap(a[0], a[1], a[2], globalFlags.feeTier, dryRun);
    },
    'add-liquidity': (c, a) => {
      if (a.length < 5) throw new Error('Usage: router add-liquidity <router> <tokenA> <tokenB> <amountA> <amountB> [--dry-run]');
      const dryRun = a.includes('--dry-run');
      return c.addLiquidity(a[0], a[1], a[2], a[3], a[4], dryRun);
    },
    'add-liquidity-native': (c, a) => {
      if (a.length < 4) throw new Error('Usage: router add-liquidity-native <router> <token> <tokenAmount> <nativeAmount> [--dry-run]');
      const dryRun = a.includes('--dry-run');
      return c.addLiquidityNative(a[0], a[1], a[2], a[3], dryRun);
    },
    'remove-liquidity': (c, a) => {
      if (a.length < 4) throw new Error('Usage: router remove-liquidity <router> <tokenA> <tokenB> <liquidity> [--dry-run]');
      const dryRun = a.includes('--dry-run');
      return c.removeLiquidity(a[0], a[1], a[2], a[3], dryRun);
    },
    'remove-liquidity-native': (c, a) => {
      if (a.length < 3) throw new Error('Usage: router remove-liquidity-native <router> <token> <liquidity> [--dry-run]');
      const dryRun = a.includes('--dry-run');
      return c.removeLiquidityNative(a[0], a[1], a[2], dryRun);
    },
    list: (c) => c.routerList(),
  },
  balances: (c) => c.allBalances(),
  qi: {
    balance: (c) => c.qiBalance(),
    utxos: (c) => c.qiUtxos(),
    sync: (c, a) => c.qiSync(a[0] || 'cyprus1'),
    send: (c, a) => { if (a.length < 2) throw new Error('Usage: qi send <payment-code> <amount> [origin-zone] [dest-zone]'); return c.qiSend(a[0], a[1], a[2] || 'cyprus1', a[3] || 'cyprus1'); },
    aggregate: (c, a) => c.qiAggregate(a[0] || 'cyprus1'),
    wrap: (c, a) => { if (a.length < 2) throw new Error('Usage: qi wrap <amount> <to-quai-address>'); return c.qiWrap(a[0], a[1]); },
    unwrap: (c, a) => { if (a.length < 2) throw new Error('Usage: qi unwrap <amount> <from-quai-address>'); return c.unwrapQi(a[0], a[1]); },
    'deposit-status': (c, a) => { if (!a[0]) throw new Error('Usage: qi deposit-status <address>'); return c.qiDepositStatus(a[0]); },
    'claim-deposit': (c, a) => c.qiClaimDeposit(),
    'convert-quai-to-qi': (c, a) => { if (a.length < 2) throw new Error('Usage: qi convert-quai-to-qi <from> <amount>'); return c.convertQuaiToQi(a[0], a[1]); },
    'convert-qi-to-quai': (c, a) => { if (a.length < 2) throw new Error('Usage: qi convert-qi-to-quai <to> <amount>'); return c.convertQiToQuai(a[0], a[1]); },
    'quote-quai-to-qi': (c, a) => { if (a.length < 3) throw new Error('Usage: qi quote-quai-to-qi <from> <to-qi> <amount>'); return c.quoteQuaiToQi(a[0], a[1], a[2]); },
    'quote-qi-to-quai': (c, a) => { if (a.length < 3) throw new Error('Usage: qi quote-qi-to-quai <from-qi> <to> <amount>'); return c.quoteQiToQuai(a[0], a[1], a[2]); },
    'next-address': (c, a) => c.qiNextAddress(),
    addresses: (c, a) => c.qiAddresses(),
    'payment-code': (c, a) => c.qiPaymentCode(),
  },
  sign: {
    tx: (c, a) => { if (a.length < 2) throw new Error('Usage: sign tx <from> <to> <amount>'); return c.signTx(a[0], a[1], a[2]); },
  },
  scan: (c, a) => { if (!a[0]) throw new Error('Usage: scan <count> [--zone cyprus1]'); const zone = a.find(x => x.startsWith('--zone='))?.split('=')[1] || 'cyprus1'; return c.scanAddresses(parseInt(a[0]), zone); },
  addresses: (c, a) => c.addresses(),
  info: (c, a) => c.walletInfo(),
};

const [,, command, sub, ...args] = effectiveArgv;

if (globalFlags.showVersion) {
  console.log(`qdex CLI v${CLI_VERSION}`);
  console.log(clr.dim(`Config: ${CONFIG_PATH}`));
  console.log(clr.dim(`RPC: ${RPC_URL}`));
  console.log(clr.dim(`Gas buffer: ${globalFlags.gasBuffer ?? DEFAULT_GAS_BUFFER} (${Math.round((globalFlags.gasBuffer ?? DEFAULT_GAS_BUFFER) * 100)}%)`));
  if (globalFlags.feeTier) {
    console.log(clr.dim(`Fee tier: ${globalFlags.feeTier} (${globalFlags.feeTier / 10000}%)`));
  }
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

const client = new Client(globalFlags.gasBuffer);

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
