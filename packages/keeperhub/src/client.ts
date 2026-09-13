import { createHash } from 'node:crypto';

import type { ContractCallRequest } from '@veto/core';

export type KeeperHubExecutionState = 'pending' | 'completed' | 'failed' | 'unconfirmed';

export type KeeperHubExecution = {
  executionId: string;
  state: KeeperHubExecutionState;
  transactionHash?: `0x${string}`;
  raw: Record<string, unknown>;
};

type Fetch = typeof globalThis.fetch;

type KeeperHubClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: Fetch;
  maxAttempts?: number;
  requestTimeoutMs?: number;
};

export class KeeperHubRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function serializeContractCall(request: ContractCallRequest): string {
  return JSON.stringify({
    contractAddress: request.contractAddress,
    chainId: request.chainId,
    functionName: request.functionName,
    functionArgs: request.functionArgs,
    abi: request.abi,
    ...(request.gasLimitMultiplier ? { gasLimitMultiplier: request.gasLimitMultiplier } : {}),
  });
}

export function keeperHubIdempotencyKey(operationKey: string): string {
  const digest = createHash('sha256').update(operationKey).digest('hex').slice(0, 32);
  return `veto-exit-${digest}`;
}

export function normalizeExecutionStatus(
  executionId: string,
  raw: Record<string, unknown>,
): KeeperHubExecution {
  const status = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
  const state: KeeperHubExecutionState =
    status === 'completed' || status === 'success'
      ? 'completed'
      : status === 'failed' || status === 'reverted'
        ? 'failed'
        : status === 'unconfirmed'
          ? 'unconfirmed'
          : 'pending';
  const transactionHash =
    typeof raw.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(raw.transactionHash)
      ? (raw.transactionHash as `0x${string}`)
      : undefined;
  return { executionId, state, transactionHash, raw };
}

export class KeeperHubClient {
  readonly #apiKey: string;
  readonly #baseUrl: URL;
  readonly #fetch: Fetch;
  readonly #maxAttempts: number;
  readonly #requestTimeoutMs: number;

  constructor(options: KeeperHubClientOptions) {
    if (!options.apiKey.startsWith('kh_')) throw new Error('KEEPERHUB_ORGANIZATION_KEY_REQUIRED');
    this.#apiKey = options.apiKey;
    this.#baseUrl = new URL(options.baseUrl ?? 'https://app.keeperhub.com');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async #request(
    pathname: string,
    options: { method?: string; body?: string; idempotencyKey?: string } = {},
  ): Promise<Record<string, unknown>> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      try {
        const response = await this.#fetch(new URL(pathname, this.#baseUrl), {
          method: options.method ?? 'GET',
          body: options.body,
          signal: AbortSignal.timeout(this.#requestTimeoutMs),
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
            ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
          },
        });
        const responseText = await response.text();
        let responseBody: Record<string, unknown> = {};
        try {
          responseBody = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : {};
        } catch {
          responseBody = { message: 'non_json_response' };
        }

        if (response.ok) return responseBody;
        const retryable = response.status === 429 || response.status >= 500;
        const error = new KeeperHubRequestError(
          `KEEPERHUB_REQUEST_FAILED:${pathname}:${response.status}`,
          response.status,
          retryable,
        );
        if (!retryable) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof KeeperHubRequestError && !error.retryable) throw error;
        lastError = error;
      }

      if (attempt + 1 < this.#maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('KEEPERHUB_REQUEST_FAILED');
  }

  async simulateContractCall(request: ContractCallRequest): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ ...JSON.parse(serializeContractCall(request)), simulate: true });
    const result = await this.#request('/api/execute/contract-call', { method: 'POST', body });
    if (result.success !== true || result.wouldRevert === true) {
      throw new KeeperHubRequestError('KEEPERHUB_SIMULATION_REJECTED');
    }
    return result;
  }

  async submitContractCall(
    serializedRequest: string,
    idempotencyKey: string,
  ): Promise<KeeperHubExecution> {
    const result = await this.#request('/api/execute/contract-call', {
      method: 'POST',
      body: serializedRequest,
      idempotencyKey,
    });
    if (typeof result.executionId !== 'string' || result.executionId.length === 0) {
      throw new KeeperHubRequestError('KEEPERHUB_EXECUTION_ID_MISSING');
    }
    return normalizeExecutionStatus(result.executionId, result);
  }

  async getExecution(executionId: string): Promise<KeeperHubExecution> {
    const result = await this.#request(`/api/execute/${encodeURIComponent(executionId)}/status`);
    return normalizeExecutionStatus(executionId, result);
  }
}
