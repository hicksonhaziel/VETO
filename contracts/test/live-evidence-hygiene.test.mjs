import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

test('live Morpho read evidence does not leak RPC credentials or endpoints', async () => {
  const evidencePath = resolve(
    new URL('../../evidence/live-morpho/live-read-gauntlet-usdc-prime.json', import.meta.url)
      .pathname,
  );
  const raw = await readFile(evidencePath, 'utf8');
  const data = JSON.parse(raw);

  // Requirement 9: Never persist the raw RPC URL / endpoint
  assert.equal(
    data.network.rpcEndpoint,
    undefined,
    'network.rpcEndpoint must not exist in committed evidence',
  );
  assert.ok(
    data.network.rpcSource === 'public-default' || data.network.rpcSource === 'custom-configured',
    'network.rpcSource must be sanitized enum',
  );

  // Check that no secret or full RPC endpoint with keys was committed
  assert.doesNotMatch(raw, /https?:\/\/[^\s"]*(api[_-]?key|secret|token)[^\s"]*/i);

  // Requirement 5: Gate assessment includes sendSharesGate and receiveAssetsGate
  assert.ok(data.vault.redemptionGateAssessment, 'redemptionGateAssessment must be present');
  assert.equal(typeof data.vault.redemptionGateAssessment.sendSharesGate, 'string');
  assert.equal(typeof data.vault.redemptionGateAssessment.receiveAssetsGate, 'string');
  assert.equal(
    typeof data.vault.redemptionGateAssessment.currentlyUngatedForOwnerRedemption,
    'boolean',
  );

  // Requirement 4: Recent submissions window instead of claiming no pending proposal exists
  assert.ok(
    data.vault.recentManagementFeeSubmissions,
    'recentManagementFeeSubmissions must be present',
  );
  assert.ok(
    data.vault.recentManagementFeeSubmissions.scannedBlockCount,
    'scannedBlockCount must be recorded',
  );
  assert.equal(data.vault.pendingFeeProposal, undefined, 'pendingFeeProposal must be renamed');
});
