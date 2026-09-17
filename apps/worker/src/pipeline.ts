import type { KeeperHubClient, KeeperHubExecution } from '@veto/keeperhub';

import { PostgresIntentStore, type StoredExitIntent } from './store.js';

export type ReconciliationResult = {
  ok: boolean;
  pending?: boolean;
  reverted?: boolean;
  noAttributableEvent?: boolean;
  detail: Record<string, unknown>;
};

export type ExitReconciler = (
  intent: StoredExitIntent,
  transactionHash?: `0x${string}`,
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
    private readonly options?: { reconciliationGraceMs?: number },
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

        if (
          intent.state === 'SUBMITTING' ||
          (intent.state === 'RECONCILING' && !intent.executionId)
        ) {
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

        if (intent.state === 'RECONCILING' && intent.executionId) {
          // 1. Check if an attributable Exited log has appeared onchain.
          const recovered = await this.reconcile(intent);
          if (recovered.ok && recovered.detail.transactionHash) {
            intent = await this.store.transition(intent.operationKey, workerId, 'CONFIRMING', {
              transactionHash: recovered.detail.transactionHash as `0x${string}`,
              reconciliation: {
                ...(intent.reconciliation ?? {}),
                ...recovered.detail,
                recoveredFromGuardEvent: true,
                platformDisagreement: true,
                keeperHubReported: 'failed',
                chainConfirmed: 'EXITED',
              },
              detail: {
                recoveredFromGuardEvent: true,
                platformDisagreement: true,
              },
            });
            continue;
          }

          if (recovered.pending) {
            // A failed chain query is NOT a successful query that found zero events.
            // Even if grace expired, remain in RECONCILING, preserve error evidence, yield current tick.
            const attempts =
              typeof intent.reconciliation?.reconciliationAttempts === 'number'
                ? (intent.reconciliation.reconciliationAttempts as number) + 1
                : 2;
            return await this.store.transition(intent.operationKey, workerId, 'RECONCILING', {
              reconciliation: {
                ...(intent.reconciliation ?? {}),
                reconciliationAttempts: attempts,
                lastChainCheckFailed: true,
                lastChainCheckError: recovered.detail?.reason ?? 'CHAIN_QUERY_PENDING',
                lastCheckedAt: new Date().toISOString(),
              },
              detail: {
                stage: 'reconciliation_chain_query_pending',
                reason: recovered.detail?.reason ?? 'CHAIN_QUERY_PENDING',
                error: recovered.detail?.error,
              },
            });
          }

          // 2. Check if KeeperHub execution has updated with a transaction hash.
          const execution = await this.keeperHub.getExecution(intent.executionId);
          const hash = execution.transactionHash ?? intent.transactionHash;
          if (hash) {
            intent = await this.store.transition(intent.operationKey, workerId, 'CONFIRMING', {
              transactionHash: hash,
              reconciliation: {
                ...(intent.reconciliation ?? {}),
                keeperHubState: execution.state,
                ...(execution.state === 'failed'
                  ? { platformDisagreement: true, keeperHubReported: 'failed' }
                  : {}),
              },
              detail: {
                keeperHubState: execution.state,
                ...(execution.state === 'failed' ? { platformDisagreement: true } : {}),
              },
            });
            continue;
          }

          // 3. Neither event nor hash found yet. Check durable grace window.
          const graceMs = this.options?.reconciliationGraceMs ?? 60_000;
          const now = Date.now();
          const existingDeadline = intent.reconciliation?.graceDeadline
            ? new Date(intent.reconciliation.graceDeadline as string).getTime()
            : now + graceMs;

          if (now < existingDeadline) {
            const attempts =
              typeof intent.reconciliation?.reconciliationAttempts === 'number'
                ? (intent.reconciliation.reconciliationAttempts as number) + 1
                : 2;
            return await this.store.transition(intent.operationKey, workerId, 'RECONCILING', {
              reconciliation: {
                ...(intent.reconciliation ?? {}),
                reconciliationAttempts: attempts,
                lastCheckedAt: new Date(now).toISOString(),
              },
              detail: {
                stage: 'reconciliation_grace_waiting',
                attempts,
                graceDeadline: intent.reconciliation?.graceDeadline,
              },
            });
          }

          // Automatic recovery window expired without an attributable event or hash.
          // Because KeeperHub failed + null hash does NOT normatively guarantee no broadcast,
          // we must NOT assume economicEffect: none or BLOCKED.
          // We transition to DISPUTED to quarantine the operation for operator review.
          return await this.store.transition(intent.operationKey, workerId, 'DISPUTED', {
            lastError: 'BROADCAST_OUTCOME_UNPROVEN',
            reconciliation: {
              ...(intent.reconciliation ?? {}),
              uncertainBroadcast: true,
              keeperHubReported: execution.state ?? 'failed',
              transactionHash: null,
              attributableEventFound: false,
              automaticRecoveryWindowExpired: true,
              economicEffect: 'unknown',
              graceExpiredAt: new Date(now).toISOString(),
            },
            detail: {
              stage: 'reconciliation_grace_expired',
              keeperHubState: execution.state,
              broadcast: 'unknown',
              economicEffect: 'unknown',
              noAttributableEvent: true,
              graceWindowElapsed: true,
              reason: 'BROADCAST_OUTCOME_UNPROVEN',
            },
          });
        }

        if (intent.state === 'UNKNOWN') {
          if (intent.transactionHash) {
            intent = await this.store.transition(intent.operationKey, workerId, 'CONFIRMING');
            continue;
          }
          if (intent.executionId) {
            const recovered = await this.reconcile(intent);
            if (recovered.ok && recovered.detail.transactionHash) {
              intent = await this.store.transition(intent.operationKey, workerId, 'CONFIRMING', {
                transactionHash: recovered.detail.transactionHash as `0x${string}`,
                detail: { recoveredFromGuardEvent: true },
              });
              continue;
            }
            intent = await this.store.transition(intent.operationKey, workerId, 'RECONCILING');
            intent = await this.store.transition(intent.operationKey, workerId, 'PENDING');
            continue;
          }
          intent = await this.store.transition(intent.operationKey, workerId, 'RECONCILING', {
            detail: { sameRequest: true, sameIdempotencyKey: true },
          });
          continue;
        }

        if (intent.state === 'DISPUTED') {
          // DISPUTED is an operator-quarantined state.
          // Automation must not auto-churn, resubmit, or flip back to CONFIRMING/RECONCILING.
          return intent;
        }

        if (intent.state === 'PENDING') {
          if (!intent.executionId) {
            return await this.store.transition(intent.operationKey, workerId, 'UNKNOWN', {
              lastError: 'MISSING_EXECUTION_ID',
            });
          }
          const execution = await this.keeperHub.getExecution(intent.executionId);
          const hash = execution.transactionHash ?? intent.transactionHash;
          if (!hash) {
            if (execution.state === 'pending') return intent;
            const recovered = await this.reconcile(intent);
            if (recovered.ok && recovered.detail.transactionHash) {
              intent = await this.store.transition(intent.operationKey, workerId, 'CONFIRMING', {
                transactionHash: recovered.detail.transactionHash as `0x${string}`,
                reconciliation: {
                  ...recovered.detail,
                  recoveredFromGuardEvent: true,
                  keeperHubState: execution.state,
                  ...(execution.state === 'failed'
                    ? {
                        platformDisagreement: true,
                        keeperHubReported: 'failed',
                        chainConfirmed: 'EXITED',
                      }
                    : {}),
                },
                detail: {
                  keeperHubState: execution.state,
                  recoveredFromGuardEvent: true,
                  ...(execution.state === 'failed'
                    ? {
                        platformDisagreement: true,
                        keeperHubReported: 'failed',
                        chainConfirmed: 'EXITED',
                      }
                    : {}),
                },
              });
              continue;
            }
            if (recovered.pending) {
              // A failed chain query is NOT a successful query that found zero events.
              if (execution.state === 'failed') {
                const graceMs = this.options?.reconciliationGraceMs ?? 60_000;
                const now = Date.now();
                const deadline = intent.reconciliation?.graceDeadline
                  ? (intent.reconciliation?.graceDeadline as string)
                  : new Date(now + graceMs).toISOString();
                return await this.store.transition(intent.operationKey, workerId, 'RECONCILING', {
                  reconciliation: {
                    ...(intent.reconciliation ?? {}),
                    keeperHubState: 'failed',
                    uncertainBroadcast: true,
                    graceStartedAt:
                      intent.reconciliation?.graceStartedAt ?? new Date(now).toISOString(),
                    graceDeadline: deadline,
                    lastChainCheckFailed: true,
                    lastChainCheckError: recovered.detail?.reason ?? 'CHAIN_QUERY_PENDING',
                    lastCheckedAt: new Date(now).toISOString(),
                  },
                  detail: {
                    stage: 'reconciliation_chain_query_pending',
                    reason: recovered.detail?.reason ?? 'CHAIN_QUERY_PENDING',
                    error: recovered.detail?.error,
                  },
                });
              }
              return intent;
            }
            if (execution.state === 'failed') {
              const graceMs = this.options?.reconciliationGraceMs ?? 60_000;
              const now = Date.now();
              const existingDeadline = intent.reconciliation?.graceDeadline
                ? new Date(intent.reconciliation.graceDeadline as string).getTime()
                : undefined;

              if (!existingDeadline) {
                // First observation of failed with no hash and no onchain log.
                // Start bounded reconciliation grace window in RECONCILING.
                const deadline = new Date(now + graceMs).toISOString();
                return await this.store.transition(intent.operationKey, workerId, 'RECONCILING', {
                  reconciliation: {
                    ...(intent.reconciliation ?? {}),
                    keeperHubState: 'failed',
                    uncertainBroadcast: true,
                    graceStartedAt: new Date(now).toISOString(),
                    graceDeadline: deadline,
                    reconciliationAttempts: 1,
                  },
                  detail: {
                    stage: 'reconciliation_grace_started',
                    graceDeadline: deadline,
                    noAttributableEvent: true,
                  },
                });
              }

              if (now < existingDeadline) {
                // Grace window still active.
                return await this.store.transition(intent.operationKey, workerId, 'RECONCILING', {
                  reconciliation: {
                    ...(intent.reconciliation ?? {}),
                    lastCheckedAt: new Date(now).toISOString(),
                  },
                  detail: {
                    stage: 'reconciliation_grace_waiting',
                    graceDeadline: intent.reconciliation?.graceDeadline,
                  },
                });
              }

              // Automatic recovery window expired without an attributable event or hash.
              return await this.store.transition(intent.operationKey, workerId, 'DISPUTED', {
                lastError: 'BROADCAST_OUTCOME_UNPROVEN',
                reconciliation: {
                  ...(intent.reconciliation ?? {}),
                  uncertainBroadcast: true,
                  keeperHubReported: execution.state ?? 'failed',
                  transactionHash: null,
                  attributableEventFound: false,
                  automaticRecoveryWindowExpired: true,
                  economicEffect: 'unknown',
                  graceExpiredAt: new Date(now).toISOString(),
                },
                detail: {
                  stage: 'reconciliation_grace_expired',
                  keeperHubState: execution.state,
                  broadcast: 'unknown',
                  economicEffect: 'unknown',
                  noAttributableEvent: true,
                  graceWindowElapsed: true,
                  reason: 'BROADCAST_OUTCOME_UNPROVEN',
                },
              });
            }
            return await this.store.transition(intent.operationKey, workerId, 'UNKNOWN', {
              lastError: 'KEEPERHUB_OUTCOME_UNRESOLVED',
              detail: { keeperHubState: execution.state },
            });
          }
          intent = await this.store.transition(intent.operationKey, workerId, 'CONFIRMING', {
            transactionHash: hash,
            reconciliation: {
              ...(intent.reconciliation ?? {}),
              keeperHubState: execution.state,
              ...(execution.state === 'failed'
                ? { platformDisagreement: true, keeperHubReported: 'failed' }
                : {}),
            },
            detail: {
              keeperHubState: execution.state,
              ...(execution.state === 'failed' ? { platformDisagreement: true } : {}),
            },
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
          if (result.pending) {
            // Receipt temporarily unavailable (CASE D). Remain in CONFIRMING, do not fail.
            return intent;
          }
          const hadPlatformDisagreement =
            intent.reconciliation?.keeperHubState === 'failed' ||
            intent.reconciliation?.platformDisagreement === true;
          if (result.reverted) {
            // Confirmed revert onchain (CASE C). Settles to BLOCKED with zero economic effect.
            return await this.store.transition(intent.operationKey, workerId, 'BLOCKED', {
              reconciliation: {
                ...(intent.reconciliation ?? {}),
                ...result.detail,
                economicEffect: 'none',
                reverted: true,
              },
              lastError: 'CHAIN_TRANSACTION_REVERTED',
              detail: {
                chainEffectVerified: false,
                reverted: true,
                economicEffect: 'none',
                ...(hadPlatformDisagreement
                  ? { keeperHubReported: 'failed', chainConfirmed: 'reverted' }
                  : {}),
              },
            });
          }
          if (result.ok) {
            // Confirmed exact expected exit (CASE A).
            return await this.store.transition(intent.operationKey, workerId, 'EXITED', {
              reconciliation: {
                ...(intent.reconciliation ?? {}),
                ...result.detail,
                ...(hadPlatformDisagreement
                  ? {
                      platformDisagreement: true,
                      keeperHubReported: 'failed',
                      chainConfirmed: 'EXITED',
                    }
                  : {}),
              },
              lastError: null,
              detail: {
                chainEffectVerified: true,
                ...(hadPlatformDisagreement
                  ? {
                      platformDisagreement: true,
                      keeperHubReported: 'failed',
                      chainConfirmed: 'EXITED',
                    }
                  : {}),
              },
            });
          }
          // Succeeded receipt onchain but wrong/unexpected economic effect (CASE B).
          return await this.store.transition(intent.operationKey, workerId, 'DISPUTED', {
            reconciliation: {
              ...(intent.reconciliation ?? {}),
              ...result.detail,
              chainEffectVerified: false,
            },
            lastError: 'CHAIN_EFFECT_MISMATCH',
            detail: {
              chainEffectVerified: false,
              reconciliation: result.detail,
              ...(hadPlatformDisagreement ? { keeperHubReported: 'failed' } : {}),
            },
          });
        }

        return intent;
      }
      throw new Error('PIPELINE_STEP_LIMIT_EXCEEDED');
    } finally {
      await this.store.release(intent.operationKey, workerId);
    }
  }
}
