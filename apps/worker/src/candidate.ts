import { financialOperationKey, type ReadyExitIntent } from '@veto/core';
import { keeperHubIdempotencyKey } from '@veto/keeperhub';
import type {
  AdapterAssessment,
  ManagementFeeAssessment,
  PerformanceFeeAssessment,
  RelativeCapAssessment,
} from '@veto/morpho-v2';
import type { Address, Hex } from 'viem';

export type ProposalAssessment =
  | ManagementFeeAssessment
  | PerformanceFeeAssessment
  | RelativeCapAssessment
  | AdapterAssessment
  | {
      eligible: boolean;
      reason: string;
    };

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
  vault: Address;
  guard: Address;
  mandateId: bigint;
  proposalIdentity: string;
  proposalData: Hex;
  expectedExecutableAt: bigint;
  assessment: ProposalAssessment;
  executionMode?: 'direct' | 'conditional';
}): ReadyExitIntent {
  if (!options.assessment.eligible || options.assessment.reason !== 'eligible') {
    throw new Error(`PROPOSAL_NOT_ELIGIBLE:${options.assessment.reason}`);
  }
  const operationKey = financialOperationKey({
    chainId: options.chainId,
    guard: options.guard,
    mandateId: options.mandateId,
    proposalIdentity: options.proposalIdentity,
  });
  const request = {
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
  } as const;
  return {
    operationKey,
    chainId: options.chainId,
    guard: options.guard,
    mandateId: options.mandateId.toString(),
    proposalIdentity: options.proposalIdentity,
    proposalData: options.proposalData,
    expectedExecutableAt: options.expectedExecutableAt.toString(),
    request,
    idempotencyKey: keeperHubIdempotencyKey(operationKey),
    executionMode: options.executionMode ?? 'direct',
    conditionalRequest: {
      contractAddress: options.vault,
      chainId: options.chainId,
      functionName: 'executableAt',
      functionArgs: JSON.stringify([options.proposalData]),
      abi: JSON.stringify([
        {
          type: 'function',
          name: 'executableAt',
          stateMutability: 'view',
          inputs: [{ name: 'data', type: 'bytes' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ]),
      condition: { operator: 'eq', value: options.expectedExecutableAt.toString() },
      action: request,
    },
  };
}
