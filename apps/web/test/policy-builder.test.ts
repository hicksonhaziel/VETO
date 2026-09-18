import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, encodeFunctionData, getAddress, parseUnits } from 'viem';

import {
  assertV1DraftCompatible,
  buildV2PolicyConfig,
  formatAnnualizedFee,
  formatSharesAndAssets,
  formatWadPercent,
  MAX_MANAGEMENT_FEE,
  MAX_MANAGEMENT_FEE_WAD_PROTOCOL,
  MAX_PERFORMANCE_FEE,
  parseDraftSharesAndAssets,
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

test('regression: vault share decimals (18) != underlying asset decimals (6) correctly parsed, armed, and formatted', () => {
  const shareDecimals = 18;
  const assetDecimals = 6;
  const draftShares = '10';
  const draftMinReturn = '9.5';

  // 1. Pure parse
  const { shares, minAssets } = parseDraftSharesAndAssets({
    draftShares,
    draftMinimumReturn: draftMinReturn,
    shareDecimals,
    assetDecimals,
  });

  // Expected raw values:
  // shares: 10 * 10^18 = 10_000_000_000_000_000_000
  // minAssets: 9.5 * 10^6 = 9_500_000
  assert.equal(shares, 10_000_000_000_000_000_000n);
  assert.equal(minAssets, 9_500_000n);

  // 2. Format back
  const { sharesFormatted, assetsFormatted } = formatSharesAndAssets({
    shares,
    assets: minAssets,
    shareDecimals,
    assetDecimals,
  });
  assert.equal(sharesFormatted, '10');
  assert.equal(assetsFormatted, '9.5');

  // 3. Prove armPolicyMandate calldata encodes and decodes exact raw values
  const draft: RuleDraftV2 = {
    shares: draftShares,
    minimumReturn: draftMinReturn,
    expiresHours: '24',
    safetyMinutes: '5',
    performanceFeeEnabled: true,
    performanceFeePercent: '10',
  };
  const config = buildV2PolicyConfig(draft);
  const testVault = getAddress('0x050cE30b927Da55177A4914EC73480238BAD56f0');
  const testExpiresAt = 1_800_000_000n;
  const testSafetySeconds = 300n;

  const encoded = encodeFunctionData({
    abi: guardV2Abi,
    functionName: 'armPolicyMandate',
    args: [testVault, shares, minAssets, testExpiresAt, testSafetySeconds, config],
  });

  const decoded = decodeFunctionData({
    abi: guardV2Abi,
    data: encoded,
  });
  assert.equal(decoded.functionName, 'armPolicyMandate');
  const decodedShares = decoded.args[1];
  const decodedMinAssets = decoded.args[2];
  assert.equal(decodedShares, 10_000_000_000_000_000_000n);
  assert.equal(decodedMinAssets, 9_500_000n);
});

test('management max frontend/contract parity and boundary testing (4.99% / 5.00% / 5.01%)', () => {
  // Pinned Morpho Vault V2: MAX_MANAGEMENT_FEE = 0.05e18 / 365 days = 1_585_489_599n
  assert.equal(MAX_MANAGEMENT_FEE, 50_000_000_000_000_000n / 31_536_000n);
  assert.equal(MAX_MANAGEMENT_FEE, 1_585_489_599n);

  const baseDraft: RuleDraftV2 = {
    shares: '100',
    minimumReturn: '100',
    expiresHours: '24',
    safetyMinutes: '5',
    managementFeeEnabled: true,
  };

  // 4.99% annualized: accepted
  const acceptedConfig = buildV2PolicyConfig({ ...baseDraft, feePercent: '4.99' });
  assert.equal(acceptedConfig.policyFlags, POLICY_MANAGEMENT_FEE);
  // (0.0499e18) / 31536000 = 1582318619n < MAX_MANAGEMENT_FEE (1585489599n)
  assert.equal(acceptedConfig.maxManagementFee, 1_582_318_619n);
  assert(acceptedConfig.maxManagementFee < MAX_MANAGEMENT_FEE);

  // 5.00% annualized: rejected (>= protocol max 5.00%)
  assert.throws(
    () => buildV2PolicyConfig({ ...baseDraft, feePercent: '5.00' }),
    /Management fee ceiling must be less than the protocol maximum \(5\.00% annualized\)/,
  );

  // 5.01% annualized: rejected
  assert.throws(
    () => buildV2PolicyConfig({ ...baseDraft, feePercent: '5.01' }),
    /Management fee ceiling must be less than the protocol maximum \(5\.00% annualized\)/,
  );
});

test('performance-only mandate from UI without management fee', () => {
  const perfOnlyDraft: RuleDraftV2 = {
    shares: '1000',
    minimumReturn: '950',
    expiresHours: '24',
    safetyMinutes: '5',
    managementFeeEnabled: false,
    performanceFeeEnabled: true,
    performanceFeePercent: '10', // 10%
  };

  const config = buildV2PolicyConfig(perfOnlyDraft);
  assert.equal(config.policyFlags, POLICY_PERFORMANCE_FEE); // exactly 2n, bit 0 is 0
  assert.equal(config.maxManagementFee, 0n);
  assert.equal(config.maxPerformanceFee, 100_000_000_000_000_000n); // 0.10e18
});

test('disable-after-entering-value removes policy flag and zero/clears fields', () => {
  const draftWithDisabledValues: RuleDraftV2 = {
    shares: '1000',
    minimumReturn: '950',
    expiresHours: '24',
    safetyMinutes: '5',
    // Management disabled despite having a value
    managementFeeEnabled: false,
    feePercent: '2.50',
    // Performance enabled
    performanceFeeEnabled: true,
    performanceFeePercent: '15.0',
    // Cap disabled despite having rows
    relativeCapEnabled: false,
    relativeCaps: [
      {
        riskId: '0x1111111111111111111111111111111111111111111111111111111111111111',
        maxRelativeCapPercent: '50',
      },
    ],
    // Adapter disabled despite having array
    adapterAllowlistEnabled: false,
    approvedAdapters: ['0x2222222222222222222222222222222222222222'],
    // Gate disabled despite having array
    redemptionGateAllowlistEnabled: false,
    approvedSendSharesGates: ['0x3333333333333333333333333333333333333333'],
  };

  const config = buildV2PolicyConfig(draftWithDisabledValues);
  // ONLY performance fee flag set
  assert.equal(config.policyFlags, POLICY_PERFORMANCE_FEE);
  assert.equal(config.maxManagementFee, 0n);
  assert.equal(config.maxPerformanceFee, 150_000_000_000_000_000n);
  assert.equal(config.relativeCaps.length, 0);
  assert.equal(config.approvedAdapters.length, 0);
  assert.equal(config.approvedSendSharesGates.length, 0);
  assert.equal(config.approvedReceiveAssetsGates.length, 0);
});

test('strict empty allowlists for adapter and redemption gates', () => {
  const strictEmptyDraft: RuleDraftV2 = {
    shares: '100',
    minimumReturn: '100',
    expiresHours: '24',
    safetyMinutes: '5',
    adapterAllowlistEnabled: true,
    approvedAdapters: [],
    redemptionGateAllowlistEnabled: true,
    approvedSendSharesGates: [],
    approvedReceiveAssetsGates: [],
  };

  const config = buildV2PolicyConfig(strictEmptyDraft);
  assert.equal(config.policyFlags, POLICY_ADAPTER_ALLOWLIST | POLICY_REDEMPTION_GATE_ALLOWLIST);
  assert.deepEqual(config.approvedAdapters, []);
  assert.deepEqual(config.approvedSendSharesGates, []);
  assert.deepEqual(config.approvedReceiveAssetsGates, []);
});

test('active-rule policy value formatting back to annualized percent and WAD percent', () => {
  // 4.99% annualized rate: 1_582_318_619n
  assert.equal(formatAnnualizedFee(1_582_318_619n), '4.99%');
  // 1.00% annualized rate: 317_097_919n
  assert.equal(formatAnnualizedFee(317_097_919n), '1.00%');
  // 0 rate
  assert.equal(formatAnnualizedFee(0n), '0.00%');

  // WAD percentages
  assert.equal(formatWadPercent(100_000_000_000_000_000n), '10.00%');
  assert.equal(formatWadPercent(600_000_000_000_000_000n), '60.00%');
  assert.equal(formatWadPercent(0n), '0.00%');
});
