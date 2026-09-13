import { createPublicClient, getAddress, http, parseAbi, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';

export const chainId = baseSepolia.id;

export const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const vaultAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function asset() view returns (address)',
  'function previewRedeem(uint256 shares) view returns (uint256 assets)',
]);

export const factoryAbi = parseAbi(['function isVaultV2(address account) view returns (bool)']);

export const guardAbi = parseAbi([
  'function activeMandateByOwnerVault(address owner, address vault) view returns (uint256)',
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 maxFeePerSecond, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active)',
  'function arm(address vault, uint256 shares, uint256 maxFeePerSecond, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds) returns (uint256 mandateId)',
  'function cancel(uint256 mandateId)',
  'event MandateArmed(uint256 indexed mandateId, address indexed owner, address indexed vault, uint256 shares, uint256 maxFeePerSecond, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds)',
  'event MandateCancelled(uint256 indexed mandateId, address indexed owner)',
]);

export type RuntimeConfig = {
  chainId: number;
  chainName: string;
  rpcUrl: string;
  factory: Address;
  vault: Address;
  guard: Address;
  explorerUrl: string;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}

export function runtimeConfig(): RuntimeConfig {
  const configuredChainId = Number.parseInt(process.env.VETO_CHAIN_ID ?? String(chainId), 10);
  if (configuredChainId !== chainId) throw new Error('UNSUPPORTED_VETO_CHAIN_ID');
  return {
    chainId: configuredChainId,
    chainName: 'Base Sepolia',
    rpcUrl: process.env.VETO_RPC_URL ?? 'https://sepolia.base.org',
    factory: getAddress(required('VETO_FACTORY_ADDRESS')),
    vault: getAddress(required('VETO_VAULT_ADDRESS')),
    guard: getAddress(required('VETO_GUARD_ADDRESS')),
    explorerUrl: 'https://base-sepolia.blockscout.com',
  };
}

export function publicClient() {
  const config = runtimeConfig();
  return createPublicClient({
    chain: baseSepolia,
    transport: http(config.rpcUrl),
    cacheTime: 0,
  });
}
