'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseUnits,
  type Address,
  type EIP1193Provider,
  type Hash,
} from 'viem';
import { baseSepolia } from 'viem/chains';

import { guardAbi, vaultAbi } from '@/lib/veto-contracts';

type EthereumProvider = EIP1193Provider & {
  on?: (event: 'accountsChanged', listener: (accounts: string[]) => void) => void;
  removeListener?: (event: 'accountsChanged', listener: (accounts: string[]) => void) => void;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export type RuntimeStatus = {
  chainId: number;
  chainName: string;
  factory: Address;
  vault: Address;
  guard: Address;
  explorerUrl: string;
  latestBlock: string;
  database: 'ready' | 'unavailable' | 'unconfigured';
  monitoringReady: boolean;
};

export type LivePosition = {
  observedAtBlock: string;
  position: {
    owner: Address;
    vault: Address;
    asset: Address;
    symbol: string;
    decimals: number;
    supported: boolean;
    shares: string;
    sharesFormatted: string;
    assets: string;
    assetsFormatted: string;
    allowance: string;
  };
  mandate: null | {
    mandateId: string;
    shares: string;
    maxFeePerSecond: string;
    minAssets: string;
    expiresAt: string;
    safetySeconds: string;
    active: boolean;
  };
  contracts: {
    factory: Address;
    guard: Address;
    chainId: number;
    explorerUrl: string;
  };
};

export type ManagedRule = {
  mandate_id: string;
  owner_address: Address;
  vault_address: Address;
  shares: string;
  max_fee_per_second: string;
  min_assets: string;
  expires_at: string;
  safety_seconds: string;
  arm_transaction_hash: Hash;
  state: 'ACTIVE' | 'CANCELLED' | 'EXITED';
  execution_state?: string;
  execution_id?: string;
  exit_transaction_hash?: Hash;
};

export type RuleDraft = {
  feePercent: string;
  shares: string;
  minimumReturn: string;
  expiresHours: string;
  safetyMinutes: string;
};

type ActionState =
  | { stage: 'idle' }
  | { stage: 'approving'; message: string }
  | { stage: 'arming'; message: string; approvalHash: Hash }
  | { stage: 'registering'; message: string; transactionHash: Hash }
  | { stage: 'cancelling'; message: string }
  | { stage: 'complete'; message: string; transactionHash: Hash }
  | { stage: 'error'; message: string; transactionHash?: Hash };

const publicChainClient = createPublicClient({ chain: baseSepolia, transport: http() });

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `REQUEST_FAILED_${response.status}`);
  return body;
}

export function useVetoWallet() {
  const [address, setAddress] = useState<Address>();
  const [runtime, setRuntime] = useState<RuntimeStatus>();
  const [position, setPosition] = useState<LivePosition>();
  const [rules, setRules] = useState<ManagedRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('Connect wallet');
  const [action, setAction] = useState<ActionState>({ stage: 'idle' });

  const refreshOwner = useCallback(async (owner: Address) => {
    setLoading(true);
    try {
      const [nextPosition, ruleResponse] = await Promise.all([
        fetch(`/api/positions?owner=${owner}`, { cache: 'no-store' }).then((response) =>
          responseJson<LivePosition>(response),
        ),
        fetch(`/api/rules?owner=${owner}`, { cache: 'no-store' })
          .then((response) => responseJson<{ rules: ManagedRule[] }>(response))
          .catch(() => ({ rules: [] })),
      ]);
      setPosition(nextPosition);
      setRules(ruleResponse.rules);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch('/api/runtime', { cache: 'no-store' })
      .then((response) => responseJson<RuntimeStatus>(response))
      .then(setRuntime)
      .catch(() => setRuntime(undefined))
      .finally(() => setLoading(false));
  }, []);

  const receiveAccounts = useCallback(
    (accounts: string[]) => {
      const candidate = accounts[0];
      if (!candidate || !candidate.startsWith('0x')) {
        setAddress(undefined);
        setPosition(undefined);
        setRules([]);
        setMessage('Connect wallet');
        return;
      }
      const owner = candidate as Address;
      setAddress(owner);
      setMessage(`${owner.slice(0, 6)}…${owner.slice(-4)}`);
      void refreshOwner(owner);
    },
    [refreshOwner],
  );

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;
    provider.on('accountsChanged', receiveAccounts);
    return () => provider.removeListener?.('accountsChanged', receiveAccounts);
  }, [receiveAccounts]);

  async function connect() {
    const provider = window.ethereum;
    if (!provider) {
      setMessage('Install a wallet');
      return;
    }
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      receiveAccounts(Array.isArray(accounts) ? accounts.map(String) : []);
    } catch {
      setMessage('Connection cancelled');
    }
  }

  async function walletClient() {
    if (!window.ethereum || !address) throw new Error('CONNECT_WALLET_FIRST');
    const client = createWalletClient({
      account: address,
      chain: baseSepolia,
      transport: custom(window.ethereum),
    });
    await client.switchChain({ id: baseSepolia.id });
    return client;
  }

  async function approveAndArm(draft: RuleDraft) {
    if (!runtime?.monitoringReady) {
      setAction({ stage: 'error', message: 'Monitoring database is not ready.' });
      return;
    }
    if (!address || !position) {
      setAction({ stage: 'error', message: 'Connect the owner wallet first.' });
      return;
    }
    try {
      const shares = parseUnits(draft.shares, position.position.decimals);
      const minimumReturn = parseUnits(draft.minimumReturn, position.position.decimals);
      const feeWad = parseUnits(draft.feePercent, 18) / 100n;
      const maxFeePerSecond = feeWad / 31_536_000n;
      const safetySeconds = BigInt(Math.round(Number(draft.safetyMinutes) * 60));
      const expiresAt = BigInt(Math.floor(Date.now() / 1000 + Number(draft.expiresHours) * 3600));
      if (shares <= 0n || shares > BigInt(position.position.shares)) {
        throw new Error('Share amount exceeds the connected position.');
      }
      if (minimumReturn <= 0n || minimumReturn > BigInt(position.position.assets)) {
        throw new Error('Minimum return must fit the current preview.');
      }
      if (maxFeePerSecond <= 0n || safetySeconds <= 0n) throw new Error('Rule limits are invalid.');

      const wallet = await walletClient();
      setAction({ stage: 'approving', message: '1 of 2 · Approve the exact share amount' });
      const approvalHash = await wallet.writeContract({
        address: position.position.vault,
        abi: vaultAbi,
        functionName: 'approve',
        args: [runtime.guard, shares],
      });
      const approvalReceipt = await publicChainClient.waitForTransactionReceipt({
        hash: approvalHash,
        confirmations: 1,
      });
      if (approvalReceipt.status !== 'success') throw new Error('Share approval reverted.');

      setAction({ stage: 'arming', message: '2 of 2 · Sign the bounded exit rule', approvalHash });
      const armHash = await wallet.writeContract({
        address: runtime.guard,
        abi: guardAbi,
        functionName: 'arm',
        args: [
          position.position.vault,
          shares,
          maxFeePerSecond,
          minimumReturn,
          expiresAt,
          safetySeconds,
        ],
      });
      const armReceipt = await publicChainClient.waitForTransactionReceipt({
        hash: armHash,
        confirmations: 1,
      });
      if (armReceipt.status !== 'success') throw new Error('Rule activation reverted.');

      setAction({
        stage: 'registering',
        message: 'Registering the verified receipt with VETO',
        transactionHash: armHash,
      });
      await fetch('/api/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'register', owner: address, transactionHash: armHash }),
      }).then((response) => responseJson(response));
      await refreshOwner(address);
      setAction({
        stage: 'complete',
        message: 'Exit rule armed and monitored',
        transactionHash: armHash,
      });
    } catch (error) {
      setAction({
        stage: 'error',
        message: error instanceof Error ? error.message : 'Rule activation failed.',
      });
    }
  }

  async function cancelRule(mandateId: string) {
    if (!address || !runtime) return;
    try {
      setAction({ stage: 'cancelling', message: 'Confirm cancellation in the owner wallet' });
      const wallet = await walletClient();
      const transactionHash = await wallet.writeContract({
        address: runtime.guard,
        abi: guardAbi,
        functionName: 'cancel',
        args: [BigInt(mandateId)],
      });
      const receipt = await publicChainClient.waitForTransactionReceipt({
        hash: transactionHash,
        confirmations: 1,
      });
      if (receipt.status !== 'success') throw new Error('Cancellation reverted.');
      await fetch('/api/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel', owner: address, transactionHash }),
      }).then((response) => responseJson(response));
      await refreshOwner(address);
      setAction({ stage: 'complete', message: 'Exit rule cancelled', transactionHash });
    } catch (error) {
      setAction({
        stage: 'error',
        message: error instanceof Error ? error.message : 'Cancellation failed.',
      });
    }
  }

  return {
    address,
    runtime,
    position,
    rules,
    loading,
    message,
    action,
    connect,
    refresh: () => (address ? refreshOwner(address) : Promise.resolve()),
    approveAndArm,
    cancelRule,
    resetAction: () => setAction({ stage: 'idle' }),
  };
}

export type VetoWallet = ReturnType<typeof useVetoWallet>;
