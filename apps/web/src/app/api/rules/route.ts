import { NextRequest, NextResponse } from 'next/server';
import { decodeEventLog, getAddress, isAddress, isHash } from 'viem';

import { database, ensureManagedRulesSchema } from '@/lib/veto-database';
import { guardAbi, publicClient, runtimeConfig } from '@/lib/veto-runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RegisterBody = {
  action?: 'register' | 'cancel';
  owner?: string;
  transactionHash?: string;
};

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status });
}

async function receiptFor(hash: `0x${string}`) {
  const receipt = await publicClient().getTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error('TRANSACTION_REVERTED');
  return receipt;
}

export async function GET(request: NextRequest) {
  const value = request.nextUrl.searchParams.get('owner') ?? '';
  if (!isAddress(value)) return jsonError('INVALID_OWNER', 400);
  try {
    await ensureManagedRulesSchema();
    const result = await database().query(
      `SELECT r.*,
              latest_intent.state AS execution_state,
              latest_intent.execution_id,
              latest_intent.transaction_hash AS exit_transaction_hash
       FROM managed_rules r
       LEFT JOIN LATERAL (
         SELECT i.state, i.execution_id, i.transaction_hash
         FROM exit_intents i
         WHERE i.chain_id = r.chain_id
           AND i.guard_address = r.guard_address
           AND i.mandate_id = r.mandate_id
         ORDER BY (CASE WHEN i.state = 'EXITED' THEN 0 ELSE 1 END), i.created_at DESC
         LIMIT 1
       ) latest_intent ON true
       WHERE r.owner_address = $1
       ORDER BY r.created_at DESC`,
      [value.toLowerCase()],
    );
    return NextResponse.json({ source: 'postgres', rules: result.rows });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'RULE_READ_FAILED', 503);
  }
}

export async function POST(request: NextRequest) {
  let body: RegisterBody;
  try {
    body = (await request.json()) as RegisterBody;
  } catch {
    return jsonError('INVALID_JSON', 400);
  }
  if (!isAddress(body.owner ?? '') || !isHash(body.transactionHash ?? '')) {
    return jsonError('INVALID_REGISTRATION', 400);
  }

  try {
    const owner = getAddress(body.owner!);
    const transactionHash = body.transactionHash as `0x${string}`;
    const config = runtimeConfig();
    const receipt = await receiptFor(transactionHash);
    if (receipt.to?.toLowerCase() !== config.guard.toLowerCase()) {
      return jsonError('TRANSACTION_TARGET_IS_NOT_CONFIGURED_GUARD', 409);
    }

    if (body.action === 'cancel') {
      const cancellation = receipt.logs
        .filter((log) => log.address.toLowerCase() === config.guard.toLowerCase())
        .flatMap((log) => {
          try {
            const decoded = decodeEventLog({ abi: guardAbi, data: log.data, topics: log.topics });
            return decoded.eventName === 'MandateCancelled' ? [decoded.args] : [];
          } catch {
            return [];
          }
        })[0];
      if (!cancellation || getAddress(cancellation.owner) !== owner) {
        return jsonError('CANCELLATION_EVENT_NOT_FOUND', 409);
      }
      await ensureManagedRulesSchema();
      await database().query(
        `UPDATE managed_rules
         SET state = 'CANCELLED', cancel_transaction_hash = $4, updated_at = now()
         WHERE chain_id = $1 AND guard_address = $2 AND mandate_id = $3 AND owner_address = $5`,
        [
          config.chainId,
          config.guard.toLowerCase(),
          cancellation.mandateId.toString(),
          transactionHash.toLowerCase(),
          owner.toLowerCase(),
        ],
      );
      return NextResponse.json({
        state: 'CANCELLED',
        mandateId: cancellation.mandateId.toString(),
      });
    }

    const armed = receipt.logs
      .filter((log) => log.address.toLowerCase() === config.guard.toLowerCase())
      .flatMap((log) => {
        try {
          const decoded = decodeEventLog({ abi: guardAbi, data: log.data, topics: log.topics });
          return decoded.eventName === 'MandateArmed' ? [decoded.args] : [];
        } catch {
          return [];
        }
      })[0];
    if (!armed || getAddress(armed.owner) !== owner) {
      return jsonError('MANDATE_ARMED_EVENT_NOT_FOUND', 409);
    }
    if (getAddress(armed.vault) !== config.vault) {
      return jsonError('UNSUPPORTED_VAULT', 409);
    }

    await ensureManagedRulesSchema();
    const connection = await database().connect();
    try {
      await connection.query('BEGIN');
      await connection.query(
        `UPDATE managed_rules SET state = 'CANCELLED', updated_at = now()
         WHERE chain_id = $1 AND owner_address = $2 AND vault_address = $3 AND state = 'ACTIVE'`,
        [config.chainId, owner.toLowerCase(), config.vault.toLowerCase()],
      );
      await connection.query(
        `INSERT INTO managed_rules (
          chain_id, factory_address, guard_address, mandate_id, owner_address, vault_address,
          shares, max_fee_per_second, min_assets, expires_at, safety_seconds,
          arm_transaction_hash, arm_block, state
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ACTIVE')
        ON CONFLICT (chain_id, guard_address, mandate_id) DO UPDATE SET
          arm_transaction_hash = EXCLUDED.arm_transaction_hash,
          state = 'ACTIVE', updated_at = now()`,
        [
          config.chainId,
          config.factory.toLowerCase(),
          config.guard.toLowerCase(),
          armed.mandateId.toString(),
          owner.toLowerCase(),
          config.vault.toLowerCase(),
          armed.shares.toString(),
          armed.maxFeePerSecond.toString(),
          armed.minAssets.toString(),
          armed.expiresAt.toString(),
          armed.safetySeconds.toString(),
          transactionHash.toLowerCase(),
          receipt.blockNumber.toString(),
        ],
      );
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
    return NextResponse.json({
      state: 'ACTIVE',
      mandateId: armed.mandateId.toString(),
      transactionHash,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'RULE_WRITE_FAILED', 503);
  }
}
