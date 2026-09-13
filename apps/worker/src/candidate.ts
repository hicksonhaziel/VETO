import { financialOperationKey, type ReadyExitIntent } from '@veto/core';
import { keeperHubIdempotencyKey } from '@veto/keeperhub';
import type { ManagementFeeAssessment } from '@veto/morpho-v2';
import type { Address, Hex } from 'viem';

export const exitGuardExecuteAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'mandateId', type: 'uint256' },
      { name: 'proposal', type: 'bytes' },
      { name: 'expectedExecutableAt', type: 'uint256' },
    ],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const;

export function buildReadyExitIntent(options: {
  chainId: number;
  guard: Address;
  mandateId: bigint;
  proposalIdentity: string;
  proposalData: Hex;
  expectedExecutableAt: bigint;
  assessment: ManagementFeeAssessment;
}): ReadyExitIntent {
  if (!options.assessment.eligible || options.assessment.reason !== 'eligible') {
    throw new Error(`PROPOSAL_NOT_ELIGIBLE:${options.assessment.reason}`);
  }
  const operationKey = financialOperationKey({
    chainId: options.chainId,
    guard: options.guard,
    mandateId: options.mandateId,
  });
  return {
    operationKey,
    chainId: options.chainId,
    guard: options.guard,
    mandateId: options.mandateId.toString(),
    proposalIdentity: options.proposalIdentity,
    proposalData: options.proposalData,
    expectedExecutableAt: options.expectedExecutableAt.toString(),
    request: {
      contractAddress: options.guard,
      chainId: options.chainId,
      functionName: 'execute',
      functionArgs: JSON.stringify([
        options.mandateId.toString(),
        options.proposalData,
        options.expectedExecutableAt.toString(),
      ]),
      abi: JSON.stringify(exitGuardExecuteAbi),
      gasLimitMultiplier: '1.3',
    },
    idempotencyKey: keeperHubIdempotencyKey(operationKey),
  };
}
