export const intentStates = [
  'OBSERVED',
  'CHECKING',
  'NOT_APPLICABLE',
  'BLOCKED',
  'READY',
  'SIMULATED',
  'SUBMITTING',
  'PENDING',
  'CONFIRMING',
  'EXITED',
  'UNKNOWN',
  'RECONCILING',
  'CANCELLED',
  'EXPIRED',
  'DISPUTED',
] as const;

export type IntentState = (typeof intentStates)[number];

const transitions: Readonly<Record<IntentState, readonly IntentState[]>> = {
  OBSERVED: ['CHECKING', 'NOT_APPLICABLE', 'CANCELLED', 'EXPIRED'],
  CHECKING: ['NOT_APPLICABLE', 'BLOCKED', 'READY', 'CANCELLED', 'EXPIRED'],
  NOT_APPLICABLE: [],
  BLOCKED: ['CHECKING', 'CANCELLED', 'EXPIRED'],
  READY: ['SIMULATED', 'BLOCKED', 'CANCELLED', 'EXPIRED'],
  SIMULATED: ['SUBMITTING', 'BLOCKED', 'CANCELLED', 'EXPIRED'],
  SUBMITTING: ['PENDING', 'UNKNOWN', 'BLOCKED'],
  PENDING: ['CONFIRMING', 'UNKNOWN', 'BLOCKED', 'RECONCILING'],
  CONFIRMING: ['EXITED', 'DISPUTED', 'UNKNOWN', 'BLOCKED'],
  EXITED: [],
  UNKNOWN: ['RECONCILING', 'DISPUTED'],
  RECONCILING: ['PENDING', 'CONFIRMING', 'EXITED', 'BLOCKED', 'DISPUTED', 'RECONCILING'],
  CANCELLED: [],
  EXPIRED: [],
  DISPUTED: ['RECONCILING'],
};

export function canTransition(from: IntentState, to: IntentState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: IntentState, to: IntentState): void {
  if (!canTransition(from, to)) throw new Error(`INVALID_INTENT_TRANSITION:${from}->${to}`);
}

export function financialOperationKey(options: {
  chainId: number;
  guard: string;
  mandateId: bigint | string;
  proposalIdentity?: string;
}): string {
  if (!Number.isSafeInteger(options.chainId) || options.chainId <= 0) {
    throw new Error('INVALID_CHAIN_ID');
  }
  const guard = options.guard.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(guard)) throw new Error('INVALID_GUARD_ADDRESS');
  const mandateId = BigInt(options.mandateId);
  if (mandateId < 0n) throw new Error('INVALID_MANDATE_ID');
  const mandateKey = `${options.chainId}:${guard}:${mandateId}`;
  return options.proposalIdentity
    ? `${mandateKey}:${encodeURIComponent(options.proposalIdentity)}`
    : mandateKey;
}

export type ContractCallRequest = {
  contractAddress: `0x${string}`;
  chainId: number;
  functionName: string;
  functionArgs: string;
  abi: string;
  gasLimitMultiplier?: string;
};

export type ReadyExitIntent = {
  operationKey: string;
  chainId: number;
  guard: `0x${string}`;
  mandateId: string;
  proposalIdentity: string;
  proposalData: `0x${string}`;
  expectedExecutableAt: string;
  request: ContractCallRequest;
  idempotencyKey: string;
  executionMode?: 'direct' | 'conditional';
  conditionalRequest?: {
    contractAddress: `0x${string}`;
    chainId: number;
    functionName: string;
    functionArgs: string;
    abi: string;
    condition: { operator: 'eq'; value: string };
    action: ContractCallRequest;
  };
};
