import { formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex } from 'viem';

export const POLICY_MANAGEMENT_FEE = 1n << 0n; // 1
export const POLICY_PERFORMANCE_FEE = 1n << 1n; // 2
export const POLICY_RELATIVE_CAP = 1n << 2n; // 4
export const POLICY_ADAPTER_ALLOWLIST = 1n << 3n; // 8
export const POLICY_REDEMPTION_GATE_ALLOWLIST = 1n << 4n; // 16

export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 31_536_000n; // 365 days
export const MAX_MANAGEMENT_FEE_WAD_PROTOCOL = 5n * 10n ** 16n; // 0.05e18 = 5.00% annualized
export const MAX_MANAGEMENT_FEE = MAX_MANAGEMENT_FEE_WAD_PROTOCOL / SECONDS_PER_YEAR; // 1_585_489_599n
export const MAX_PERFORMANCE_FEE = 50n * 10n ** 16n; // 50% WAD = 0.50e18
export const MAX_RELATIVE_CAP_WAD_PROTOCOL = WAD; // 1.0e18 = 100%

export type RelativeCapDraftRow = {
  riskId: string;
  maxRelativeCapPercent: string;
};

export type RuleDraftV2 = {
  shares: string;
  minimumReturn: string;
  expiresHours: string;
  safetyMinutes: string;

  managementFeeEnabled?: boolean;
  feePercent?: string;

  performanceFeeEnabled?: boolean;
  performanceFeePercent?: string;

  relativeCapEnabled?: boolean;
  relativeCaps?: RelativeCapDraftRow[];

  adapterAllowlistEnabled?: boolean;
  approvedAdapters?: string[];

  redemptionGateAllowlistEnabled?: boolean;
  approvedSendSharesGates?: string[];
  approvedReceiveAssetsGates?: string[];
};

export type RelativeCapLimit = {
  riskId: Hex;
  maxRelativeCap: bigint;
};

export type PolicyConfig = {
  policyFlags: bigint;
  maxManagementFee: bigint;
  maxPerformanceFee: bigint;
  relativeCaps: RelativeCapLimit[];
  approvedAdapters: Address[];
  approvedSendSharesGates: Address[];
  approvedReceiveAssetsGates: Address[];
};

export function assertV1DraftCompatible(draft: RuleDraftV2): void {
  const hasPerf =
    draft.performanceFeeEnabled === true ||
    (draft.performanceFeePercent !== undefined && draft.performanceFeePercent.trim() !== '');

  const hasCap =
    draft.relativeCapEnabled === true ||
    (draft.relativeCaps !== undefined && draft.relativeCaps.length > 0);

  const hasAdapter =
    draft.adapterAllowlistEnabled === true ||
    (draft.approvedAdapters !== undefined && draft.approvedAdapters.length > 0);

  const hasGates =
    draft.redemptionGateAllowlistEnabled === true ||
    (draft.approvedSendSharesGates !== undefined && draft.approvedSendSharesGates.length > 0) ||
    (draft.approvedReceiveAssetsGates !== undefined && draft.approvedReceiveAssetsGates.length > 0);

  if (hasPerf || hasCap || hasAdapter || hasGates) {
    throw new Error(
      'V2 multi-policy boundaries are configured, but the runtime is set to V1 (Management Fee only). Switch runtime to V2 or clear V2 fields.',
    );
  }
}

export function parseDraftSharesAndAssets(params: {
  draftShares: string;
  draftMinimumReturn: string;
  shareDecimals: number;
  assetDecimals: number;
}): {
  shares: bigint;
  minAssets: bigint;
} {
  const shares = parseUnits(params.draftShares.trim(), params.shareDecimals);
  const minAssets = parseUnits(params.draftMinimumReturn.trim(), params.assetDecimals);
  return { shares, minAssets };
}

export function formatSharesAndAssets(params: {
  shares: bigint;
  assets: bigint;
  shareDecimals: number;
  assetDecimals: number;
}): {
  sharesFormatted: string;
  assetsFormatted: string;
} {
  return {
    sharesFormatted: formatUnits(params.shares, params.shareDecimals),
    assetsFormatted: formatUnits(params.assets, params.assetDecimals),
  };
}

export function formatAnnualizedFee(ratePerSecond: bigint): string {
  if (ratePerSecond === 0n) return '0.00%';
  const annualizedWad = ratePerSecond * SECONDS_PER_YEAR;
  const bps = (annualizedWad * 10000n + WAD / 2n) / WAD;
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}%`;
}

export function formatWadPercent(wad: bigint): string {
  if (wad === 0n) return '0.00%';
  const bps = (wad * 10000n) / WAD;
  const whole = bps / 100n;
  const frac = (bps % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}%`;
}

export function buildV2PolicyConfig(draft: RuleDraftV2): PolicyConfig {
  let policyFlags = 0n;
  let maxManagementFee = 0n;
  let maxPerformanceFee = 0n;
  const relativeCaps: RelativeCapLimit[] = [];
  const approvedAdapters: Address[] = [];
  const approvedSendSharesGates: Address[] = [];
  const approvedReceiveAssetsGates: Address[] = [];

  // 1. Management Fee Policy (Explicit toggle required)
  if (draft.managementFeeEnabled === true) {
    if (!draft.feePercent || draft.feePercent.trim() === '') {
      throw new Error('Management fee percent is required when management fee policy is enabled.');
    }
    const percentNum = Number(draft.feePercent.trim());
    if (Number.isNaN(percentNum) || percentNum <= 0) {
      throw new Error('Management fee percent must be a positive number.');
    }
    const feeWad = parseUnits(draft.feePercent.trim(), 18) / 100n;
    if (feeWad >= MAX_MANAGEMENT_FEE_WAD_PROTOCOL) {
      throw new Error(
        'Management fee ceiling must be less than the protocol maximum (5.00% annualized).',
      );
    }
    maxManagementFee = feeWad / SECONDS_PER_YEAR;
    if (maxManagementFee <= 0n) {
      throw new Error('Management fee rate per second must be greater than zero.');
    }
    if (maxManagementFee >= MAX_MANAGEMENT_FEE) {
      throw new Error(
        'Management fee ceiling must be less than the protocol maximum (5.00% annualized).',
      );
    }
    policyFlags |= POLICY_MANAGEMENT_FEE;
  }

  // 2. Performance Fee Policy (Explicit toggle required)
  if (draft.performanceFeeEnabled === true) {
    if (!draft.performanceFeePercent || draft.performanceFeePercent.trim() === '') {
      throw new Error(
        'Performance fee percent is required when performance fee policy is enabled.',
      );
    }
    const percentNum = Number(draft.performanceFeePercent.trim());
    if (Number.isNaN(percentNum) || percentNum < 0 || percentNum >= 50) {
      throw new Error(
        'Performance fee percent must be in range [0, 50) % (less than protocol 50% maximum).',
      );
    }
    maxPerformanceFee = parseUnits(draft.performanceFeePercent.trim(), 18) / 100n;
    if (maxPerformanceFee >= MAX_PERFORMANCE_FEE) {
      throw new Error('Performance fee must be less than protocol 50% maximum.');
    }
    policyFlags |= POLICY_PERFORMANCE_FEE;
  }

  // 3. Relative Cap Policy (Explicit toggle required)
  if (draft.relativeCapEnabled === true) {
    if (!draft.relativeCaps || draft.relativeCaps.length === 0) {
      throw new Error(
        'At least one risk ID and relative cap row must be configured when relative cap policy is enabled.',
      );
    }
    const seenRiskIds = new Set<string>();
    for (let i = 0; i < draft.relativeCaps.length; i++) {
      const row = draft.relativeCaps[i];
      const riskIdRaw = row.riskId.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(riskIdRaw)) {
        throw new Error(
          `Row ${i + 1}: Invalid risk ID "${riskIdRaw}". Must be 32 bytes (0x followed by 64 hexadecimal characters).`,
        );
      }
      const normalizedRiskId = riskIdRaw.toLowerCase() as Hex;
      if (seenRiskIds.has(normalizedRiskId)) {
        throw new Error(
          `Row ${i + 1}: Duplicate risk ID "${riskIdRaw}". Each risk ID may only be configured once.`,
        );
      }
      seenRiskIds.add(normalizedRiskId);

      const capPercentNum = Number(row.maxRelativeCapPercent.trim());
      if (Number.isNaN(capPercentNum) || capPercentNum < 0 || capPercentNum > 100) {
        throw new Error(`Row ${i + 1}: Maximum relative cap percent must be between 0 and 100.`);
      }
      const maxRelativeCap = parseUnits(row.maxRelativeCapPercent.trim(), 18) / 100n;
      if (maxRelativeCap > WAD) {
        throw new Error(`Row ${i + 1}: Relative cap cannot exceed 100% (1 WAD).`);
      }
      relativeCaps.push({ riskId: normalizedRiskId, maxRelativeCap });
    }
    policyFlags |= POLICY_RELATIVE_CAP;
  }

  // 4. Adapter Allowlist Policy (Explicit toggle required)
  if (draft.adapterAllowlistEnabled === true) {
    const rawAdapters = draft.approvedAdapters ?? [];
    const seenAdapters = new Set<string>();
    for (let i = 0; i < rawAdapters.length; i++) {
      const item = rawAdapters[i].trim();
      if (!item) continue;
      if (!isAddress(item)) {
        throw new Error(`Adapter ${i + 1}: "${item}" is not a valid Ethereum address.`);
      }
      const checksummed = getAddress(item);
      if (checksummed === '0x0000000000000000000000000000000000000000') {
        throw new Error(`Adapter ${i + 1}: Address cannot be the zero address.`);
      }
      if (seenAdapters.has(checksummed.toLowerCase())) {
        throw new Error(`Adapter ${i + 1}: Duplicate adapter address "${checksummed}".`);
      }
      seenAdapters.add(checksummed.toLowerCase());
      approvedAdapters.push(checksummed);
    }
    // Strict empty allowlist supported: approvedAdapters can be [] meaning NO newly added adapter is approved
    policyFlags |= POLICY_ADAPTER_ALLOWLIST;
  }

  // 5. Redemption Gate Allowlist Policy (Explicit toggle required)
  if (draft.redemptionGateAllowlistEnabled === true) {
    const rawSendGates = draft.approvedSendSharesGates ?? [];
    const seenSendGates = new Set<string>();
    for (let i = 0; i < rawSendGates.length; i++) {
      const item = rawSendGates[i].trim();
      if (!item) continue;
      if (!isAddress(item)) {
        throw new Error(`Send-shares gate ${i + 1}: "${item}" is not a valid Ethereum address.`);
      }
      const checksummed = getAddress(item);
      if (checksummed === '0x0000000000000000000000000000000000000000') {
        throw new Error(
          'Send-shares gate cannot be the zero address (zero address is already permitted onchain).',
        );
      }
      if (seenSendGates.has(checksummed.toLowerCase())) {
        throw new Error(`Send-shares gate ${i + 1}: Duplicate gate address "${checksummed}".`);
      }
      seenSendGates.add(checksummed.toLowerCase());
      approvedSendSharesGates.push(checksummed);
    }

    const rawReceiveGates = draft.approvedReceiveAssetsGates ?? [];
    const seenReceiveGates = new practicalSet();
    for (let i = 0; i < rawReceiveGates.length; i++) {
      const item = rawReceiveGates[i].trim();
      if (!item) continue;
      if (!isAddress(item)) {
        throw new Error(`Receive-assets gate ${i + 1}: "${item}" is not a valid Ethereum address.`);
      }
      const checksummed = getAddress(item);
      if (checksummed === '0x0000000000000000000000000000000000000000') {
        throw new Error(
          'Receive-assets gate cannot be the zero address (zero address is already permitted onchain).',
        );
      }
      if (seenReceiveGates.has(checksummed.toLowerCase())) {
        throw new Error(`Receive-assets gate ${i + 1}: Duplicate gate address "${checksummed}".`);
      }
      seenReceiveGates.add(checksummed.toLowerCase());
      approvedReceiveAssetsGates.push(checksummed);
    }
    // Strict empty allowlist supported: gates can be [] meaning NO non-zero gate is approved
    policyFlags |= POLICY_REDEMPTION_GATE_ALLOWLIST;
  }

  if (policyFlags === 0n) {
    throw new Error('At least one policy family must be enabled for a V2 mandate.');
  }

  if ((policyFlags & ~31n) !== 0n) {
    throw new Error('Unknown policy flag bit detected.');
  }

  return {
    policyFlags,
    maxManagementFee,
    maxPerformanceFee,
    relativeCaps,
    approvedAdapters,
    approvedSendSharesGates,
    approvedReceiveAssetsGates,
  };
}

class practicalSet extends Set<string> {}
