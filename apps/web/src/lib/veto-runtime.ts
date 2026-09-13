import { createPublicClient, getAddress, http, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';

export { erc20Abi, factoryAbi, guardAbi, vaultAbi } from '@/lib/veto-contracts';

export const chainId = baseSepolia.id;

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
