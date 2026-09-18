import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionData, getAddress, parseUnits } from 'viem';

import {
  assertV1DraftCompatible,
  buildV2PolicyConfig,
  MAX_MANAGEMENT_FEE,
  MAX_PERFORMANCE_FEE,
  POLICY_ADAPTER_ALLOWLIST,
  POLICY_MANAGEMENT_FEE,
  POLICY_PERFORMANCE_FEE,
  POLICY_REDEMPTION_GATE_ALLOWLIST,
  POLICY_RELATIVE_CAP,
  WAD,
  type RuleDraftV2,
} from '../src/lib/policy-builder.js';
import { guardV2Abi } from '../src/lib/veto-contracts.js';

test('buildV2PolicyConfig exact conversions for all 5 policies', () => {
  const draft: RuleDraftV2 = {
    shares: '1000',
    minimumReturn: '1000',
    expiresHours: '24',
    safetyMinutes: '5',
    managementFeeEnabled: true,
    feePercent: '1.5', // 1.5%
    performanceFeeEnabled: true,
    performanceFeePercent: '15', // 15%
    relativeCapEnabled: true,
    relativeCaps: [
      {
        riskId: '0x1111111111111111111111111111111111111111111111111111111111111111',
        maxRelativeCapPercent: '25',
      },
    ],
    adapterAllowlistEnabled: true,
    approvedAdapters: ['0x2222222222222222222222222222222222222222'],
    redemptionGateAllowlistEnabled: true,
    approvedSendSharesGates: ['0x3333333333333333333333333333333333333333'],
    approvedReceiveAssetsGates: ['0x4444444444444444444444444444444444444444'],
  };

  const config = buildV2PolicyConfig(draft);

  // All 5 bits enabled: 1 | 2 | 4 | 8 | 16 = 31n
  assert.equal(
    config.policyFlags,
    POLICY_MANAGEMENT_FEE |
      POLICY_PERFORMANCE_FEE |
      POLICY_RELATIVE_CAP |
      POLICY_ADAPTER_ALLOWLIST |
      POLICY_REDEMPTION_GATE_ALLOWLIST,
  );
  assert.equal(config.policyFlags, 31n);

  // Exact conversions:
  // 1.5% annual -> (0.015e18) / 31536000
  const expectedMgmtRate = parseUnits('1.5', 18) / 100n / 31_536_000n;
  assert.equal(config.maxManagementFee, expectedMgmtRate);

  // 15% WAD -> 0.15e18
  assert.equal(config.maxPerformanceFee, 150_000_000_000_000_000n);

  // 25% WAD -> 0.25e18
  assert.equal(config.relativeCaps.length, 1);
  assert.equal(
    config.relativeCaps[0]?.riskId,
    '0x1111111111111111111111111111111111111111111111111111111111111111',
  );
  assert.equal(config.relativeCaps[0]?.maxRelativeCap, 250_000_000_000_000_000n);

  // Adapters
  assert.deepEqual(config.approvedAdapters, [
    getAddress('0x2222222222222222222222222222222222222222'),
  ]);

  // Separate Gates
  assert.deepEqual(config.approvedSendSharesGates, [
    getAddress('0x3333333333333333333333333333333333333333'),
  ]);
  assert.deepEqual(config.approvedReceiveAssetsGates, [
    getAddress('0x4444444444444444444444444444444444444444'),
  ]);
});

test('invalid performance percentages rejected', () => {
  const baseDraft: RuleDraftV2 = {
    shares: '100',
    minimumReturn: '100',
    expiresHours: '24',
    safetyMinutes: '5',
    performanceFeeEnabled: true,
  };

  assert.throws(
    () => buildV2PolicyConfig({ ...baseDraft, performanceFeePercent: '-1' }),
    /Performance fee percent must be in range/,
  );
  assert.throws(
    () => buildV2PolicyConfig({ ...baseDraft, performanceFeePercent: '50' }),
    /Performance fee percent must be in range/,
  );
  assert.throws(
    () => buildV2PolicyConfig({ ...baseDraft, performanceFeePercent: '60' }),
    /Performance fee percent must be in range/,
  );
  assert.throws(
    () => buildV2PolicyConfig({ ...baseDraft, performanceFeePercent: 'not-a-number' }),
    /Performance fee percent must be in range/,
  );
});

test('invalid and duplicate bytes32 risk IDs rejected', () => {
  const baseDraft: RuleDraftV2 = {
    shares: '100',
    minimumReturn: '100',
    expiresHours: '24',
    safetyMinutes: '5',
    relativeCapEnabled: true,
  };

  // Empty list
  assert.throws(
    () => buildV2PolicyConfig({ ...baseDraft, relativeCaps: [] }),
    /At least one risk ID and relative cap row must be configured/,
  );

  // Invalid bytes32 length
  assert.throws(
    () =>
      buildV2PolicyConfig({
        ...baseDraft,
        relativeCaps: [{ riskId: '0x1234', maxRelativeCapPercent: '10' }],
      }),
    /Invalid risk ID/,
  );

  // Invalid characters
  assert.throws(
    () =>
      buildV2PolicyConfig({
        ...baseDraft,
        relativeCaps: [
          {
            riskId: '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
            maxRelativeCapPercent: '10',
          },
        ],
      }),
    /Invalid risk ID/,
  );

  // Duplicate risk ID
  assert.throws(
    () =>
      buildV2PolicyConfig({
        ...baseDraft,
        relativeCaps: [
          {
            riskId: '0x1111111111111111111111111111111111111111111111111111111111111111',
            maxRelativeCapPercent: '10',
          },
          {
            riskId: '0x1111111111111111111111111111111111111111111111111111111111111111',
            maxRelativeCapPercent: '20',
          },
        ],
      }),
    /Duplicate risk ID/,
  );

  // Cap percent > 100
  assert.throws(
    () =>
      buildV2PolicyConfig({
        ...baseDraft,
        relativeCaps: [
          {
            riskId: '0x1111111111111111111111111111111111111111111111111111111111111111',
            maxRelativeCapPercent: '101',
          },
        ],
      }),
    /Maximum relative cap percent must be between 0 and 100/,
  );
});

test('duplicate, zero, and invalid adapters rejected', () => {
  const baseDraft: RuleDraftV2 = {
    shares: '100',
    minimumReturn: '100',
    expiresHours: '24',
    safetyMinutes: '5',
    adapterAllowlistEnabled: true,
  };

  // Invalid address
  assert.throws(
    () => buildV2PolicyConfig({ ...baseDraft, approvedAdapters: ['0xinvalid'] }),
    /not a valid Ethereum address/,
  );

  // Zero address
  assert.throws(
    () =>
      buildV2PolicyConfig({
        ...baseDraft,
        approvedAdapters: ['0x0000000000000000000000000000000000000000'],
      }),
    /cannot be the zero address/,
  );

  // Duplicate address
  assert.throws(
    () =>
      buildV2PolicyConfig({
        ...baseDraft,
        approvedAdapters: [
          '0x1111111111111111111111111111111111111111',
          '0x1111111111111111111111111111111111111111',
        ],
      }),
    /Duplicate adapter address/,
  );

  // Empty allowlist is valid (means strict no new adapters approved)
  const emptyConfig = buildV2PolicyConfig({ ...baseDraft, approvedAdapters: [] });
  assert.equal(emptyConfig.approvedAdapters.length, 0);
  assert.equal(emptyConfig.policyFlags, POLICY_ADAPTER_ALLOWLIST);
});

test('separate send/receive gate lists with zero and duplicate rejection', () => {
  const baseDraft: RuleDraftV2 = {
    shares: '100',
    minimumReturn: '100',
    expiresHours: '24',
    safetyMinutes: '5',
    redemptionGateAllowlistEnabled: true,
  };

  // Zero address in send gate
  assert.throws(
    () =>
      buildV2PolicyConfig({
        ...baseDraft,
        approvedSendSharesGates: ['0x0000000000000000000000000000000000000000'],
      }),
    /Send-shares gate cannot be the zero address/,
  );

  // Zero address in receive gate
  assert.throws(
    () =>
      buildV2PolicyConfig({
        ...baseDraft,
        approvedReceiveAssetsGates: ['0x0000000000000000000000000000000000000000'],
      }),
    /Receive-assets gate cannot be the zero address/,
  );

  // Preserves separate send and receive lists
  const sendGate = '0x1111111111111111111111111111111111111111';
  const receiveGate = '0x2222222222222222222222222222222222222222';
  const config = buildV2PolicyConfig({
    ...baseDraft,
    approvedSendSharesGates: [sendGate],
    approvedReceiveAssetsGates: [receiveGate],
  });
  assert.deepEqual(config.approvedSendSharesGates, [getAddress(sendGate)]);
  assert.deepEqual(config.approvedReceiveAssetsGates, [getAddress(receiveGate)]);
});

test('V1 draft cannot enable V2-only fields', () => {
  const v1Draft: RuleDraftV2 = {
    shares: '100',
    minimumReturn: '100',
    expiresHours: '24',
    safetyMinutes: '5',
    feePercent: '1.5',
  };

  // Pure V1 passes
  assert.doesNotThrow(() => assertV1DraftCompatible(v1Draft));

  // V2 fields throw
  assert.throws(
    () => assertV1DraftCompatible({ ...v1Draft, performanceFeePercent: '10' }),
    /V2 multi-policy boundaries are configured, but the runtime is set to V1/,
  );
  assert.throws(
    () =>
      assertV1DraftCompatible({
        ...v1Draft,
        relativeCaps: [{ riskId: '0x123', maxRelativeCapPercent: '5' }],
      }),
    /V2 multi-policy boundaries are configured, but the runtime is set to V1/,
  );
  assert.throws(
    () =>
      assertV1DraftCompatible({
        ...v1Draft,
        approvedAdapters: ['0x1111111111111111111111111111111111111111'],
      }),
    /V2 multi-policy boundaries are configured, but the runtime is set to V1/,
  );
  assert.throws(
    () =>
      assertV1DraftCompatible({
        ...v1Draft,
        approvedSendSharesGates: ['0x1111111111111111111111111111111111111111'],
      }),
    /V2 multi-policy boundaries are configured, but the runtime is set to V1/,
  );
});

test('browser-independent integration: encode armPolicyMandate -> decode signed calldata -> verify config equality', () => {
  const draft: RuleDraftV2 = {
    shares: '5000000',
    minimumReturn: '4900000',
    expiresHours: '48',
    safetyMinutes: '10',
    managementFeeEnabled: true,
    feePercent: '1.25',
    performanceFeeEnabled: true,
    performanceFeePercent: '12',
    relativeCapEnabled: true,
    relativeCaps: [
      {
        riskId: '0xaaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff1111111122222222',
        maxRelativeCapPercent: '30',
      },
    ],
    adapterAllowlistEnabled: true,
    approvedAdapters: ['0x5555555555555555555555555555555555555555'],
    redemptionGateAllowlistEnabled: true,
    approvedSendSharesGates: ['0x6666666666666666666666666666666666666666'],
    approvedReceiveAssetsGates: ['0x7777777777777777777777777777777777777777'],
  };

  const config = buildV2PolicyConfig(draft);
  const testVault = getAddress('0x9019B1e26795E90825c567aD08c945C603e7F9B9');
  const testShares = 5_000_000n;
  const testMinAssets = 4_900_000n;
  const testExpiresAt = 1_800_000_000n;
  const testSafetySeconds = 600n;

  // 1. Encode transaction data using guardV2Abi
  const encodedCalldata = encodeFunctionData({
    abi: guardV2Abi,
    functionName: 'armPolicyMandate',
    args: [testVault, testShares, testMinAssets, testExpiresAt, testSafetySeconds, config],
  });

  // 2. Decode transaction data using guardV2Abi
  const decoded = decodeFunctionData({
    abi: guardV2Abi,
    data: encodedCalldata,
  });

  assert.equal(decoded.functionName, 'armPolicyMandate');
  const [
    decodedVault,
    decodedShares,
    decodedMinAssets,
    decodedExpiresAt,
    decodedSafetySeconds,
    decodedConfig,
  ] = decoded.args as [string, bigint, bigint, bigint, bigint, typeof config];

  assert.equal(decodedVault, testVault);
  assert.equal(decodedShares, testShares);
  assert.equal(decodedMinAssets, testMinAssets);
  assert.equal(decodedExpiresAt, testExpiresAt);
  assert.equal(decodedSafetySeconds, testSafetySeconds);

  // Verify decoded config matches original normalized config
  assert.equal(decodedConfig.policyFlags, config.policyFlags);
  assert.equal(decodedConfig.maxManagementFee, config.maxManagementFee);
  assert.equal(decodedConfig.maxPerformanceFee, config.maxPerformanceFee);
  assert.equal(decodedConfig.relativeCaps.length, config.relativeCaps.length);
  assert.equal(decodedConfig.relativeCaps[0]?.riskId, config.relativeCaps[0]?.riskId);
  assert.equal(
    decodedConfig.relativeCaps[0]?.maxRelativeCap,
    config.relativeCaps[0]?.maxRelativeCap,
  );
  assert.deepEqual(decodedConfig.approvedAdapters, config.approvedAdapters);
  assert.deepEqual(decodedConfig.approvedSendSharesGates, config.approvedSendSharesGates);
  assert.deepEqual(decodedConfig.approvedReceiveAssetsGates, config.approvedReceiveAssetsGates);
});
