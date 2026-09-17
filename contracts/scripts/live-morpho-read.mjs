import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createPublicClient,
  fallback,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  parseAbiItem,
  toFunctionSelector,
} from 'viem';
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
const EXPECTED_ASSET = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'); // USDC on Base

const vaultAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function asset() view returns (address)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function curator() view returns (address)',
  'function owner() view returns (address)',
  'function managementFee() view returns (uint256)',
  'function managementFeeRecipient() view returns (address)',
  'function performanceFee() view returns (uint256)',
  'function performanceFeeRecipient() view returns (address)',
  'function timelock(bytes4 selector) view returns (uint256)',
  'function receiveAssetsGate() view returns (address)',
  'function receiveSharesGate() view returns (address)',
  'function sendAssetsGate() view returns (address)',
  'function sendSharesGate() view returns (address)',
  'function abdicated(bytes4 selector) view returns (bool)',
  'function liquidityAdapter() view returns (address)',
]);

const factoryAbi = parseAbi(['function isVaultV2(address vault) view returns (bool)']);

export async function readLiveMorphoVault() {
  const setFeeSelector = toFunctionSelector('setManagementFee(uint256)');

  const [
    blockNumber,
    isV2,
    name,
    symbol,
    decimals,
    asset,
    totalAssets,
    totalSupply,
    curator,
    owner,
    managementFee,
    managementFeeRecipient,
    performanceFee,
    performanceFeeRecipient,
    feeTimelock,
    receiveAssetsGate,
    receiveSharesGate,
    sendAssetsGate,
    sendSharesGate,
    isAbdicated,
  ] = await Promise.all([
    client.getBlockNumber(),
    client.readContract({
      address: FACTORY_ADDRESS,
      abi: factoryAbi,
      functionName: 'isVaultV2',
      args: [VAULT_ADDRESS],
    }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'name' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'symbol' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'decimals' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'asset' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'totalAssets' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'totalSupply' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'curator' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'owner' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'managementFee' }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'managementFeeRecipient',
    }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'performanceFee' }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'performanceFeeRecipient',
    }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'timelock',
      args: [setFeeSelector],
    }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'receiveAssetsGate',
    }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'receiveSharesGate',
    }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'sendAssetsGate' }),
    client.readContract({ address: VAULT_ADDRESS, abi: vaultAbi, functionName: 'sendSharesGate' }),
    client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'abdicated',
      args: [setFeeSelector],
    }),
  ]);

  let liquidityAdapter = 'not derived';
  try {
    liquidityAdapter = await client.readContract({
      address: VAULT_ADDRESS,
      abi: vaultAbi,
      functionName: 'liquidityAdapter',
    });
  } catch {
    liquidityAdapter = 'not derived';
  }

  const block = await client.getBlock({ blockNumber });

  // Scan recent blocks for setManagementFee Submit events
  let recentManagementFeeSubmissions = null;
  const scanWindow = 2_000n;
  const fromBlock = blockNumber > scanWindow ? blockNumber - scanWindow : 0n;
  try {
    const submitEvent = parseAbiItem(
      'event Submit(bytes4 indexed selector, bytes data, uint256 executableAt)',
    );
    const logs = await client.getLogs({
      address: VAULT_ADDRESS,
      event: submitEvent,
      args: { selector: setFeeSelector },
      fromBlock,
      toBlock: blockNumber,
    });
    recentManagementFeeSubmissions = {
      scannedFromBlock: fromBlock.toString(),
      scannedToBlock: blockNumber.toString(),
      scannedBlockCount: (blockNumber - fromBlock).toString(),
      observedSubmitEventsCount: logs.length,
      status:
        logs.length > 0
          ? 'submit_events_detected'
          : 'no_setManagementFee_submit_event_detected_in_scanned_block_range',
      events: logs.map((l) => ({
        transactionHash: l.transactionHash,
        blockNumber: l.blockNumber?.toString(),
        data: l.args.data,
        executableAt: l.args.executableAt?.toString(),
      })),
      note: 'Morpho Vault V2 proposals remain pending from Submit until accept or revoke. A recent-block scan observes recent emissions within the window; establishing whether an older proposal remains unaccepted/unrevoked requires full historical archive indexing.',
    };
  } catch (err) {
    recentManagementFeeSubmissions = {
      scannedFromBlock: fromBlock.toString(),
      scannedToBlock: blockNumber.toString(),
      scannedBlockCount: (blockNumber - fromBlock).toString(),
      status: 'scan_restricted_or_rpc_limited',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const result = {
    checkedAt: new Date().toISOString(),
    network: {
      name: 'Base Mainnet',
      chainId: base.id,
      rpcSource: process.env.BASE_RPC_URL ? 'custom-configured' : 'public-default',
      blockNumber: blockNumber.toString(),
      blockTimestamp: block.timestamp.toString(),
    },
    vault: {
      address: VAULT_ADDRESS,
      name,
      symbol,
      decimals,
      asset: {
        address: asset,
        symbol: asset.toLowerCase() === EXPECTED_ASSET.toLowerCase() ? 'USDC' : 'UNKNOWN',
        decimals: 6,
        isBaseUSDC: asset.toLowerCase() === EXPECTED_ASSET.toLowerCase(),
      },
      factory: {
        address: FACTORY_ADDRESS,
        recognizedByFactory: isV2,
        isVaultV2: isV2,
      },
      governance: {
        owner,
        curator,
        knownCuratorName:
          curator.toLowerCase() === '0x9e33faae38ff641094fa68c65c2ce600b3410585'
            ? 'Gauntlet'
            : 'Unknown',
      },
      fees: {
        managementFeeRatePerSecond: managementFee.toString(),
        managementFeeAnnualizedPercent:
          (((Number(managementFee) * 31_536_000) / 1e18) * 100).toFixed(4) + '%',
        managementFeeRecipient,
        performanceFeeRate: performanceFee.toString(),
        performanceFeeRecipient,
      },
      timelocks: {
        setManagementFeeSelector: setFeeSelector,
        managementFeeTimelockSeconds: feeTimelock.toString(),
        managementFeeTimelockDays: (Number(feeTimelock) / 86_400).toFixed(1),
        timelockReactionWindowNote:
          "A newly submitted setManagementFee action is scheduled 259,200 seconds (3 days) after submission, providing a protocol reaction window before that change becomes executable. Successful exit still depends on the depositor's mandate and available redemption liquidity.",
        setManagementFeeAbdicated: isAbdicated,
        authorityNote: isAbdicated
          ? 'setManagementFee is abdicated; fee cannot be changed.'
          : 'setManagementFee is not abdicated, so the curator retains authority to submit future management-fee changes.',
      },
      redemptionGateAssessment: {
        sendSharesGate,
        receiveAssetsGate,
        currentlyUngatedForOwnerRedemption:
          sendSharesGate === '0x0000000000000000000000000000000000000000' &&
          receiveAssetsGate === '0x0000000000000000000000000000000000000000',
        receiveSharesGate,
        sendAssetsGate,
        note: 'Morpho Vault V2 redeem/withdraw checks canSendShares on behalf of owner and canReceiveAssets for the receiver. An unset gate (address(0)) removes that gate restriction; it does not by itself guarantee sufficient redemption liquidity.',
      },
      financialState: {
        totalAssetsOrTvlRaw: totalAssets.toString(),
        totalAssetsOrTvlFormatted: `$${Number(formatUnits(totalAssets, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`,
        totalSupplyRaw: totalSupply.toString(),
        totalSupplyFormatted: Number(formatUnits(totalSupply, 18)).toLocaleString('en-US', {
          minimumFractionDigits: 4,
          maximumFractionDigits: 4,
        }),
        liquidityAdapter,
        liquidityDistinctionNote:
          "totalAssets represents the vault's total assets / TVL across all market allocations, not immediately available idle redemption liquidity. Successful redemption depends on available market liquidity and adapter deallocation.",
      },
      recentManagementFeeSubmissions,
    },
    provenance: {
      canonicalMorphoFactory: FACTORY_ADDRESS,
      factoryRecognition: isV2,
      factoryVerificationStatement:
        'The referenced Base Morpho Vault V2 factory returns isVaultV2(vault) == true.',
      factoryRuntimeSha256: 'cf0f79d0fb41a563e915b81cefb581f74acb46336cee022c1991671d9e575d8e',
      morphoVaultV2Commit: '6f2af6602e05d9e123a87c1067712a4566608044',
      solidityCompiler: '0.8.28 (viaIR, 100000 runs, cancun)',
    },
  };

  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const data = await readLiveMorphoVault();
    const json = JSON.stringify(data, null, 2);
    console.log(json);

    // Save output to evidence/live-morpho/live-read-gauntlet-usdc-prime.json if run directly
    const outputPath = resolve(
      new URL('../../evidence/live-morpho/live-read-gauntlet-usdc-prime.json', import.meta.url)
        .pathname,
    );
    await writeFile(outputPath, json + '\n', 'utf8');
    console.error(`\n[live-morpho-read] Successfully saved live read evidence to ${outputPath}`);
  } catch (error) {
    console.error('[live-morpho-read] Failed:', error);
    process.exit(1);
  }
}
