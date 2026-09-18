import { NextRequest, NextResponse } from 'next/server';
import { formatUnits, getAddress, isAddress } from 'viem';

import {
  erc20Abi,
  factoryAbi,
  guardAbi,
  guardV2Abi,
  publicClient,
  runtimeConfig,
  vaultAbi,
} from '@/lib/veto-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const value = request.nextUrl.searchParams.get('owner') ?? '';
  if (!isAddress(value)) return NextResponse.json({ error: 'INVALID_OWNER' }, { status: 400 });

  try {
    const owner = getAddress(value);
    const config = runtimeConfig();
    const client = publicClient();
    const [supported, shares, asset, encodedMandateId, latestBlock] = await Promise.all([
      client.readContract({
        address: config.factory,
        abi: factoryAbi,
        functionName: 'isVaultV2',
        args: [config.vault],
      }),
      client.readContract({
        address: config.vault,
        abi: vaultAbi,
        functionName: 'balanceOf',
        args: [owner],
      }),
      client.readContract({ address: config.vault, abi: vaultAbi, functionName: 'asset' }),
      client.readContract({
        address: config.guard,
        abi: guardAbi,
        functionName: 'activeMandateByOwnerVault',
        args: [owner, config.vault],
      }),
      client.getBlockNumber(),
    ]);
    const [assetDecimals, symbol, allowance, assets] = await Promise.all([
      client.readContract({ address: asset, abi: erc20Abi, functionName: 'decimals' }),
      client.readContract({ address: asset, abi: erc20Abi, functionName: 'symbol' }),
      client.readContract({
        address: config.vault,
        abi: vaultAbi,
        functionName: 'allowance',
        args: [owner, config.guard],
      }),
      client.readContract({
        address: config.vault,
        abi: vaultAbi,
        functionName: 'previewRedeem',
        args: [shares],
      }),
    ]);
    const mandateId = encodedMandateId > 0n ? encodedMandateId - 1n : undefined;
    const isV2 = config.guardVersion === 'v2';
    const mandate =
      mandateId === undefined
        ? undefined
        : isV2
          ? await client.readContract({
              address: config.guard,
              abi: guardV2Abi,
              functionName: 'mandates',
              args: [mandateId],
            })
          : await client.readContract({
              address: config.guard,
              abi: guardAbi,
              functionName: 'mandates',
              args: [mandateId],
            });

    let formattedMandate: Record<string, unknown> | null = null;
    if (mandate) {
      if (isV2) {
        const m = mandate as readonly [
          string,
          string,
          bigint,
          bigint,
          bigint,
          bigint,
          boolean,
          bigint,
          bigint,
          bigint,
        ];
        formattedMandate = {
          version: 'v2',
          mandateId: mandateId?.toString(),
          owner: m[0],
          vault: m[1],
          shares: m[2].toString(),
          minAssets: m[3].toString(),
          expiresAt: m[4].toString(),
          safetySeconds: m[5].toString(),
          active: m[6],
          policyFlags: m[7].toString(),
          maxManagementFee: m[8].toString(),
          maxPerformanceFee: m[9].toString(),
        };
      } else {
        const m = mandate as readonly [
          string,
          string,
          bigint,
          bigint,
          bigint,
          bigint,
          bigint,
          boolean,
        ];
        formattedMandate = {
          version: 'v1',
          mandateId: mandateId?.toString(),
          owner: m[0],
          vault: m[1],
          shares: m[2].toString(),
          maxFeePerSecond: m[3].toString(),
          minAssets: m[4].toString(),
          expiresAt: m[5].toString(),
          safetySeconds: m[6].toString(),
          active: m[7],
        };
      }
    }

    return NextResponse.json({
      observedAtBlock: latestBlock.toString(),
      position: {
        owner,
        vault: config.vault,
        asset,
        symbol,
        decimals: assetDecimals,
        supported,
        shares: shares.toString(),
        sharesFormatted: formatUnits(shares, assetDecimals),
        assets: assets.toString(),
        assetsFormatted: formatUnits(assets, assetDecimals),
        allowance: allowance.toString(),
      },
      mandate: formattedMandate,
      contracts: {
        factory: config.factory,
        guard: config.guard,
        chainId: config.chainId,
        explorerUrl: config.explorerUrl,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'POSITION_READ_FAILED' },
      { status: 502 },
    );
  }
}
