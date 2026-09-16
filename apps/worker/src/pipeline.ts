import type { KeeperHubClient, KeeperHubExecution } from '@veto/keeperhub';

import { PostgresIntentStore, type StoredExitIntent } from './store.js';

export type ReconciliationResult = {
  ok: boolean;
  detail: Record<string, unknown>;
};

export type ExitReconciler = (
  intent: StoredExitIntent,
  transactionHash: `0x${string}`,
) => Promise<ReconciliationResult>;

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN_ERROR';
  return error.message.replace(/[\r\n]/g, ' ').slice(0, 500);
}

export class ExitPipeline {
  constructor(
    private readonly store: PostgresIntentStore,
    private readonly keeperHub: Pick<
      KeeperHubClient,
      'simulateContractCall' | 'submitContractCall' | 'checkAndExecute' | 'getExecution'
    >,
    private readonly reconcile: ExitReconciler,
  ) {}

  async runOnce(workerId: string): Promise<StoredExitIntent | undefined> {
    let intent = await this.store.claimNext(workerId);
    if (!intent) return undefined;

    try {
      for (let step = 0; step < 10; step += 1) {
        if (intent.state === 'READY') {
          if (intent.executionMode === 'conditional') {
            intent = await this.store.transition(intent.operationKey, workerId, 'SIMULATED', {
              detail: {
                simulation: 'deferred_to_keeperhub_check_and_execute',
                reason: 'conditional endpoint performs the authoritative read and action preflight',
              },
              lastError: null,
            });
            continue;
          }
          try {
            await this.keeperHub.simulateContractCall(intent.request);
            intent = await this.store.transition(intent.operationKey, workerId, 'SIMULATED', {
              detail: { simulation: 'passed' },
              lastError: null,
            });
            continue;
          } catch (error) {
            return await this.store.transition(intent.operationKey, workerId, 'BLOCKED', {
              lastError: errorCode(error),
              detail: { stage: 'simulation' },
            });
          }
        }

        if (intent.state === 'SIMULATED') {
          intent = await this.store.transition(intent.operationKey, workerId, 'SUBMITTING', {
            detail: { requestPersisted: true, idempotencyKeyPersisted: true },
          });
          continue;
        }

        if (intent.state === 'SUBMITTING' || intent.state === 'RECONCILING') {
          try {
            const wasRecovering = intent.state === 'RECONCILING';
            const conditional = intent.executionMode === 'conditional';
            if (conditional && !intent.serializedConditionalRequest) {
              return await this.store.transition(intent.operationKey, workerId, 'DISPUTED', {
                lastError: 'MISSING_CONDITIONAL_REQUEST',
                detail: { stage: 'conditional_submission' },
              });
            }
            let execution: KeeperHubExecution;
            let conditionResult: Record<string, unknown> | undefined;
            if (conditional) {
              const result = await this.keeperHub.checkAndExecute(
                intent.serializedConditionalRequest!,
                intent.idempotencyKey,
              );
              conditionResult = result.conditionResult;
              if (!result.executed) {
                return await this.store.transition(intent.operationKey, workerId, 'BLOCKED', {
                  lastError: 'PROPOSAL_NOT_PENDING_AT_EXECUTION',
                  reconciliation: {
                    economicEffect: 'none',
                    transactionHash: null,
                    conditionResult,
                  },
                  detail: {
                    stage: 'keeperhub_conditional',
                    broadcast: false,
                    conditionResult,
                  },
                });
              }
              execution = result;
            } else {
              execution = await this.keeperHub.submitContractCall(
                intent.serializedRequest,
                intent.idempotencyKey,
              );
            }
            intent = await this.store.transition(intent.operationKey, workerId, 'PENDING', {
              executionId: execution.executionId,
              transactionHash: execution.transactionHash,
              lastError: null,
              detail: {
                recovered: wasRecovering,
                executionMode: intent.executionMode,
                keeperHubState: execution.state,
                ...(conditionResult ? { conditionResult } : {}),
              },
            });
            continue;
          } catch (error) {
            if (intent.state === 'RECONCILING') {
              return await this.store.transition(intent.operationKey, workerId, 'DISPUTED', {
                lastError: errorCode(error),
                detail: { stage: 'idempotent_recovery' },
              });
            }
            return await this.store.transition(intent.operationKey, workerId, 'UNKNOWN', {
              lastError: errorCode(error),
              detail: { stage: 'submission', outcome: 'unknown' },
            });
          }
        }

        if (intent.state === 'UNKNOWN' || intent.state === 'DISPUTED') {
          intent = await this.store.transition(intent.operationKey, workerId, 'RECONCILING', {
            detail: { sameRequest: true, sameIdempotencyKey: true },
          });
          continue;
        }

        if (intent.state === 'PENDING') {
          if (!intent.executionId) {
            return await this.store.transition(intent.operationKey, workerId, 'UNKNOWN', {
              lastError: 'MISSING_EXECUTION_ID',
            });
          }
          const execution = await this.keeperHub.getExecution(intent.executionId);
          if (execution.state === 'pending') return intent;
          if (execution.state === 'failed') {
            return await this.store.transition(intent.operationKey, workerId, 'BLOCKED', {
              lastError: 'KEEPERHUB_EXECUTION_FAILED',
              detail: { keeperHubState: execution.state },
            });
          }
          if (execution.state === 'unconfirmed' || !execution.transactionHash) {
            return await this.store.transition(intent.operationKey, workerId, 'UNKNOWN', {
              lastError: 'KEEPERHUB_EXECUTION_UNCONFIRMED',
              detail: { keeperHubState: execution.state },
            });
          }
          intent = await this.store.transition(intent.operationKey, workerId, 'CONFIRMING', {
            transactionHash: execution.transactionHash,
            detail: { keeperHubState: execution.state },
          });
          continue;
        }

        if (intent.state === 'CONFIRMING') {
          if (!intent.transactionHash) {
            return await this.store.transition(intent.operationKey, workerId, 'UNKNOWN', {
              lastError: 'MISSING_TRANSACTION_HASH',
            });
          }
          const result = await this.reconcile(intent, intent.transactionHash);
          return await this.store.transition(
            intent.operationKey,
            workerId,
            result.ok ? 'EXITED' : 'DISPUTED',
            {
              reconciliation: result.detail,
              lastError: result.ok ? null : 'CHAIN_EFFECT_MISMATCH',
              detail: { chainEffectVerified: result.ok },
            },
          );
        }

        return intent;
      }
      throw new Error('PIPELINE_STEP_LIMIT_EXCEEDED');
    } finally {
      await this.store.release(intent.operationKey, workerId);
    }
  }
}
