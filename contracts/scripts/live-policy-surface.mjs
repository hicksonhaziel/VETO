import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPublicClient, fallback, getAddress, http, parseAbi, toFunctionSelector } from 'viem';
import { base } from 'viem/chains';

const rpcUrl = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const client = createPublicClient({
  chain: base,
  transport: fallback([
    http(rpcUrl, { batch: true }),
    http('https://base-rpc.publicnode.com', { batch: true }),
    http('https://base.llamarpc.com', { batch: true }),
  ]),
});

const VAULT_ADDRESS = getAddress('0x050cE30b927Da55177A4914EC73480238BAD56f0');
const FACTORY_ADDRESS = getAddress('0x4501125508079A99ebBebCE205DeC9593C2b5857');

const vaultAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function timelock(bytes4 selector) view returns (uint256)',
  'function abdicated(bytes4 selector) view returns (bool)',
  'function managementFeeRecipient() view returns (address)',
  'function performanceFeeRecipient() view returns (address)',
  'function sendSharesGate() view returns (address)',
  'function receiveAssetsGate() view returns (address)',
]);

const SELECTORS = [
  { name: 'setManagementFee', signature: 'setManagementFee(uint256)' },
  { name: 'setPerformanceFee', signature: 'setPerformanceFee(uint256)' },
  { name: 'increaseRelativeCap', signature: 'increaseRelativeCap(bytes,uint256)' },
  { name: 'addAdapter', signature: 'addAdapter(address)' },
  { name: 'setSendSharesGate', signature: 'setSendSharesGate(address)' },
  { name: 'setReceiveAssetsGate', signature: 'setReceiveAssetsGate(address)' },
];

export async function readPolicySurface() {
  const [
    blockNumber,
    name,
    symbol,
    mgmtRecipient,
    perfRecipient,
    currentSendGate,
    currentRecvGate,
  ] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'name' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'symbol' }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'managementFeeRecipient',
    }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'performanceFeeRecipient',
    }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'sendSharesGate',
    }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'receiveAssetsGate',
    }),
  ]);

  const surface = [];
  for (const item of SELECTORS) {
    const selector = toFunctionSelector(item.signature);
    const [timelockSeconds, isAbdicated] = await Promise.all([
      client.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'timelock',
        args: [selector],
      }),
      client.readContract({
        address: VAULT_ADDRESS,
        abi: vaultAbi,
        functionName: 'abdicated',
        args: [selector],
      }),
    ]);
    surface.push({
      name: item.name,
      signature: item.signature,
      selector,
      timelockSeconds: Number(timelockSeconds),
      hasTimelock: timelockSeconds > 0n,
      isAbdicated,
      supportedByVeto: !isAbdicated && timelockSeconds > 0n,
    });
  }

  const result = {
    vault: VAULT_ADDRESS,
    name,
    symbol,
    blockNumber: Number(blockNumber),
    observedAt: new Date().toISOString(),
    recipients: {
      managementFeeRecipient: mgmtRecipient,
      performanceFeeRecipient: perfRecipient,
    },
    currentGates: {
      sendSharesGate: currentSendGate,
      receiveAssetsGate: currentRecvGate,
    },
    surface,
  };

  const outDir = resolve(process.cwd(), 'evidence/multi-policy');
  await mkdir(outDir, { recursive: true });
  await writeFile(
    resolve(outDir, 'live-policy-surface.json'),
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log('Saved evidence/multi-policy/live-policy-surface.json');
  return result;
}

if (process.argv[1]?.endsWith('live-policy-surface.mjs')) {
  readPolicySurface().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
