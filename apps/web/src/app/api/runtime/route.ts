import { NextResponse } from 'next/server';

import { database, databaseConfigured, ensureManagedRulesSchema } from '@/lib/veto-database';
import { publicClient, runtimeConfig } from '@/lib/veto-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  try {
    const config = runtimeConfig();
    const client = publicClient();
    const [blockNumber, databaseStatus] = await Promise.all([
      client.getBlockNumber(),
      databaseConfigured()
        ? ensureManagedRulesSchema()
            .then(() => database().query('SELECT 1 FROM managed_rules LIMIT 1'))
            .then(() => 'ready' as const)
            .catch(() => 'unavailable' as const)
        : Promise.resolve('unconfigured' as const),
    ]);
    return NextResponse.json({
      chainId: config.chainId,
      chainName: config.chainName,
      factory: config.factory,
      vault: config.vault,
      guard: config.guard,
      guardVersion: config.guardVersion,
      explorerUrl: config.explorerUrl,
      latestBlock: blockNumber.toString(),
      database: databaseStatus,
      monitoringReady: databaseStatus === 'ready',
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'RUNTIME_UNAVAILABLE' },
      { status: 503 },
    );
  }
}
