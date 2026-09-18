import { NextRequest, NextResponse } from 'next/server';
import { decodeEventLog, decodeFunctionData, getAddress, isAddress, isHash } from 'viem';

import { database, ensureManagedRulesSchema } from '@/lib/veto-database';
import { guardAbi, guardV2Abi, publicClient, runtimeConfig } from '@/lib/veto-runtime';

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
          ORDER BY (
            CASE
              WHEN i.state = 'DISPUTED' THEN 0
              WHEN i.state = 'EXITED' THEN 1
              WHEN i.state = 'UNKNOWN' THEN 2
              WHEN i.state = 'RECONCILING' THEN 3
              WHEN i.state = 'CONFIRMING' THEN 4
              WHEN i.state = 'PENDING' THEN 5
              WHEN i.state = 'SUBMITTING' THEN 6
              WHEN i.state = 'SIMULATED' THEN 7
              WHEN i.state = 'READY' THEN 8
              ELSE 9
            END
          ), i.created_at DESC
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

    let armedMandateId: bigint;
    let armedShares: bigint;
    let armedMaxFee: bigint;
    let armedMinAssets: bigint;
    let armedExpiresAt: bigint;
    let armedSafetySeconds: bigint;
    let guardVersion = 'v1';
    let policyVersion = 1;
    let policyConfigJson: Record<string, unknown> | null = null;

    const armedV2 = receipt.logs
      .filter((log) => log.address.toLowerCase() === config.guard.toLowerCase())
      .flatMap((log) => {
        try {
          const decoded = decodeEventLog({ abi: guardV2Abi, data: log.data, topics: log.topics });
          return decoded.eventName === 'PolicyMandateArmed' ? [decoded.args] : [];
        } catch {
          return [];
        }
      })[0];

    if (armedV2) {
      if (getAddress(armedV2.owner) !== owner) return jsonError('MANDATE_OWNER_MISMATCH', 409);
      if (getAddress(armedV2.vault) !== config.vault) return jsonError('UNSUPPORTED_VAULT', 409);

      // Verify directly from onchain guard contract state
      const onchainMandate = await publicClient().readContract({
        address: config.guard,
        abi: guardV2Abi,
        functionName: 'mandates',
        args: [armedV2.mandateId],
      });
      const [
        onchainOwner,
        onchainVault,
        onchainShares,
        onchainMinAssets,
        onchainExpiresAt,
        onchainSafetySeconds,
        onchainActive,
        onchainPolicyFlags,
        onchainMaxMgmtFee,
        onchainMaxPerfFee,
      ] = onchainMandate;

      if (
        !onchainActive ||
        getAddress(onchainOwner) !== owner ||
        getAddress(onchainVault) !== config.vault
      ) {
        return jsonError('ONCHAIN_MANDATE_INVALID', 409);
      }

      guardVersion = 'v2';
      policyVersion = 2;
      armedMandateId = armedV2.mandateId;
      armedShares = onchainShares;
      armedMaxFee = onchainMaxMgmtFee;
      armedMinAssets = onchainMinAssets;
      armedExpiresAt = onchainExpiresAt;
      armedSafetySeconds = onchainSafetySeconds;

      // 1. Fetch transaction input
      const tx = await publicClient().getTransaction({ hash: transactionHash });
      let decodedCalldata: ReturnType<typeof decodeFunctionData<typeof guardV2Abi>>;
      try {
        decodedCalldata = decodeFunctionData({ abi: guardV2Abi, data: tx.input });
      } catch {
        return jsonError('INVALID_TRANSACTION_CALLDATA', 409);
      }
      if (decodedCalldata.functionName !== 'armPolicyMandate') {
        return jsonError('UNEXPECTED_TRANSACTION_FUNCTION', 409);
      }
      const [txVault, txShares, txMinAssets, txExpiresAt, txSafetySeconds, txConfig] =
        decodedCalldata.args as [
          string,
          bigint,
          bigint,
          bigint,
          bigint,
          {
            policyFlags: bigint;
            maxManagementFee: bigint;
            maxPerformanceFee: bigint;
            relativeCaps: readonly { riskId: `0x${string}`; maxRelativeCap: bigint }[];
            approvedAdapters: readonly `0x${string}`[];
            approvedSendSharesGates: readonly `0x${string}`[];
            approvedReceiveAssetsGates: readonly `0x${string}`[];
          },
        ];

      if (
        getAddress(txVault) !== config.vault ||
        txShares !== onchainShares ||
        txMinAssets !== onchainMinAssets ||
        txExpiresAt !== onchainExpiresAt ||
        txSafetySeconds !== onchainSafetySeconds ||
        txConfig.policyFlags !== onchainPolicyFlags ||
        txConfig.maxManagementFee !== onchainMaxMgmtFee ||
        txConfig.maxPerformanceFee !== onchainMaxPerfFee
      ) {
        return jsonError('TRANSACTION_INPUT_MANDATE_MISMATCH', 409);
      }

      // Verify each relative cap onchain
      const verifiedRelativeCaps: Array<{ riskId: string; maxRelativeCap: string }> = [];
      if ((onchainPolicyFlags & 4n) !== 0n) {
        for (const cap of txConfig.relativeCaps) {
          const [hasCap, maxCap] = await Promise.all([
            publicClient().readContract({
              address: config.guard,
              abi: guardV2Abi,
              functionName: 'hasRelativeCapByMandateRisk',
              args: [armedV2.mandateId, cap.riskId],
            }),
            publicClient().readContract({
              address: config.guard,
              abi: guardV2Abi,
              functionName: 'maxRelativeCapByMandateRisk',
              args: [armedV2.mandateId, cap.riskId],
            }),
          ]);
          if (!hasCap || maxCap !== cap.maxRelativeCap) {
            return jsonError('ONCHAIN_RELATIVE_CAP_VERIFICATION_FAILED', 409);
          }
          verifiedRelativeCaps.push({
            riskId: cap.riskId,
            maxRelativeCap: cap.maxRelativeCap.toString(),
          });
        }
      }

      // Verify each adapter onchain
      const verifiedAdapters: string[] = [];
      if ((onchainPolicyFlags & 8n) !== 0n) {
        for (const adapter of txConfig.approvedAdapters) {
          const isApproved = await publicClient().readContract({
            address: config.guard,
            abi: guardV2Abi,
            functionName: 'approvedAdapterByMandate',
            args: [armedV2.mandateId, adapter],
          });
          if (!isApproved) {
            return jsonError('ONCHAIN_ADAPTER_VERIFICATION_FAILED', 409);
          }
          verifiedAdapters.push(getAddress(adapter));
        }
      }

      // Verify each send gate and receive gate onchain
      const verifiedSendGates: string[] = [];
      const verifiedReceiveGates: string[] = [];
      if ((onchainPolicyFlags & 16n) !== 0n) {
        for (const gate of txConfig.approvedSendSharesGates) {
          const isApproved = await publicClient().readContract({
            address: config.guard,
            abi: guardV2Abi,
            functionName: 'approvedSendSharesGateByMandate',
            args: [armedV2.mandateId, gate],
          });
          if (!isApproved) {
            return jsonError('ONCHAIN_SEND_GATE_VERIFICATION_FAILED', 409);
          }
          verifiedSendGates.push(getAddress(gate));
        }

        for (const gate of txConfig.approvedReceiveAssetsGates) {
          const isApproved = await publicClient().readContract({
            address: config.guard,
            abi: guardV2Abi,
            functionName: 'approvedReceiveAssetsGateByMandate',
            args: [armedV2.mandateId, gate],
          });
          if (!isApproved) {
            return jsonError('ONCHAIN_RECEIVE_GATE_VERIFICATION_FAILED', 409);
          }
          verifiedReceiveGates.push(getAddress(gate));
        }
      }

      policyConfigJson = {
        policyFlags: onchainPolicyFlags.toString(),
        maxManagementFee: onchainMaxMgmtFee.toString(),
        maxPerformanceFee: onchainMaxPerfFee.toString(),
        relativeCaps: verifiedRelativeCaps,
        approvedAdapters: verifiedAdapters,
        approvedSendSharesGates: verifiedSendGates,
        approvedReceiveAssetsGates: verifiedReceiveGates,
      };
    } else {
      const armedV1 = receipt.logs
        .filter((log) => log.address.toLowerCase() === config.guard.toLowerCase())
        .flatMap((log) => {
          try {
            const decoded = decodeEventLog({ abi: guardAbi, data: log.data, topics: log.topics });
            return decoded.eventName === 'MandateArmed' ? [decoded.args] : [];
          } catch {
            return [];
          }
        })[0];
      if (!armedV1 || getAddress(armedV1.owner) !== owner) {
        return jsonError('MANDATE_ARMED_EVENT_NOT_FOUND', 409);
      }
      if (getAddress(armedV1.vault) !== config.vault) {
        return jsonError('UNSUPPORTED_VAULT', 409);
      }
      armedMandateId = armedV1.mandateId;
      armedShares = armedV1.shares;
      armedMaxFee = armedV1.maxFeePerSecond;
      armedMinAssets = armedV1.minAssets;
      armedExpiresAt = armedV1.expiresAt;
      armedSafetySeconds = armedV1.safetySeconds;
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
          arm_transaction_hash, arm_block, state, guard_version, policy_version, policy_config_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ACTIVE',$14,$15,$16)
        ON CONFLICT (chain_id, guard_address, mandate_id) DO UPDATE SET
          arm_transaction_hash = EXCLUDED.arm_transaction_hash,
          state = 'ACTIVE', guard_version = EXCLUDED.guard_version,
          policy_version = EXCLUDED.policy_version,
          policy_config_json = EXCLUDED.policy_config_json,
          updated_at = now()`,
        [
          config.chainId,
          config.factory.toLowerCase(),
          config.guard.toLowerCase(),
          armedMandateId.toString(),
          owner.toLowerCase(),
          config.vault.toLowerCase(),
          armedShares.toString(),
          armedMaxFee.toString(),
          armedMinAssets.toString(),
          armedExpiresAt.toString(),
          armedSafetySeconds.toString(),
          transactionHash.toLowerCase(),
          receipt.blockNumber.toString(),
          guardVersion,
          policyVersion,
          policyConfigJson ? JSON.stringify(policyConfigJson) : null,
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
      mandateId: armedMandateId.toString(),
      guardVersion,
      transactionHash,
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'RULE_WRITE_FAILED', 503);
  }
}
