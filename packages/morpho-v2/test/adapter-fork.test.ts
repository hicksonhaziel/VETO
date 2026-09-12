import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { base } from 'viem/chains';

import { verifyManagementFeeProposal } from '../src/index.js';

const rpcUrl = 'http://127.0.0.1:18548';
const forkUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const forkBlock = 51_221_130;
const factory = getAddress('0x4501125508079A99ebBebCE205DeC9593C2b5857');
const vault = getAddress('0x050cE30b927Da55177A4914EC73480238BAD56f0');
const curator = getAddress('0x9E33faAE38ff641094fa68c65c2cE600b3410585');
const vaultAbi = parseAbi([
  'function submit(bytes data)',
  'function revoke(bytes data)',
  'function executableAt(bytes data) view returns (uint256)',
  'function setManagementFee(uint256 newManagementFee)',
]);

async function waitForRpc(client: { getBlockNumber(): Promise<bigint> }) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await client.getBlockNumber();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('adapter fork RPC did not start');
}

test('verifies and then rejects a revoked proposal on the pinned Morpho Base vault', async (context) => {
  const anvilEntrypoint = fileURLToPath(
    new URL('../../../contracts/node_modules/@foundry-rs/anvil/bin.mjs', import.meta.url),
  );
  const anvil = spawn(
    process.execPath,
    [
      anvilEntrypoint,
      '--host',
      '127.0.0.1',
      '--port',
      '18548',
      '--fork-url',
      forkUrl,
      '--fork-block-number',
      String(forkBlock),
      '--hardfork',
      'cancun',
      '--silent',
    ],
    { stdio: 'ignore' },
  );
  context.after(() => anvil.kill('SIGTERM'));

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
    cacheTime: 0,
  });
  await waitForRpc(publicClient);
  const testClient = createTestClient({
    chain: base,
    mode: 'anvil',
    transport: http(rpcUrl),
  });
  await testClient.setBalance({ address: curator, value: 1_000_000_000_000_000_000n });
  await testClient.impersonateAccount({ address: curator });
  const curatorClient = createWalletClient({
    chain: base,
    transport: http(rpcUrl),
    account: curator,
  });

  const maxFeePerSecond = 10n ** 16n / 31_536_000n;
  const proposedFee = (2n * 10n ** 16n) / 31_536_000n;
  const data = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'setManagementFee',
    args: [proposedFee],
  });
  const submitHash = await curatorClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'submit',
    args: [data],
  });
  const submitReceipt = await publicClient.waitForTransactionReceipt({ hash: submitHash });
  const expectedExecutableAt = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'executableAt',
    args: [data],
    blockNumber: submitReceipt.blockNumber,
  });

  const eligible = await verifyManagementFeeProposal({
    client: publicClient,
    factory,
    vault,
    data,
    maxFeePerSecond,
    safetySeconds: 300n,
    expectedExecutableAt,
    blockNumber: submitReceipt.blockNumber,
  });
  assert.equal(eligible.reason, 'eligible');
  assert.equal(eligible.proposedFee, proposedFee);

  const revokeHash = await curatorClient.writeContract({
    address: vault,
    abi: vaultAbi,
    functionName: 'revoke',
    args: [data],
  });
  const revokeReceipt = await publicClient.waitForTransactionReceipt({ hash: revokeHash });
  const revoked = await verifyManagementFeeProposal({
    client: publicClient,
    factory,
    vault,
    data,
    maxFeePerSecond,
    safetySeconds: 300n,
    expectedExecutableAt,
    blockNumber: revokeReceipt.blockNumber,
  });
  assert.equal(revoked.reason, 'proposal-cleared');
});
