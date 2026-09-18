import { parseAbi } from 'viem';

export const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const vaultAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function asset() view returns (address)',
  'function previewRedeem(uint256 shares) view returns (uint256 assets)',
]);

export const factoryAbi = parseAbi(['function isVaultV2(address account) view returns (bool)']);

export const guardAbi = parseAbi([
  'function activeMandateByOwnerVault(address owner, address vault) view returns (uint256)',
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 maxFeePerSecond, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active)',
  'function arm(address vault, uint256 shares, uint256 maxFeePerSecond, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds) returns (uint256 mandateId)',
  'function cancel(uint256 mandateId)',
  'event MandateArmed(uint256 indexed mandateId, address indexed owner, address indexed vault, uint256 shares, uint256 maxFeePerSecond, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds)',
  'event MandateCancelled(uint256 indexed mandateId, address indexed owner)',
]);

export const POLICY_MANAGEMENT_FEE = 1n << 0n;
export const POLICY_PERFORMANCE_FEE = 1n << 1n;
export const POLICY_RELATIVE_CAP = 1n << 2n;
export const POLICY_ADAPTER_ALLOWLIST = 1n << 3n;
export const POLICY_REDEMPTION_GATE_ALLOWLIST = 1n << 4n;

export const guardV2Abi = parseAbi([
  'struct RelativeCapLimit { bytes32 riskId; uint256 maxRelativeCap; }',
  'struct PolicyConfig { uint256 policyFlags; uint256 maxManagementFee; uint256 maxPerformanceFee; RelativeCapLimit[] relativeCaps; address[] approvedAdapters; address[] approvedSendSharesGates; address[] approvedReceiveAssetsGates; }',
  'function activeMandateByOwnerVault(address owner, address vault) view returns (uint256)',
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active, uint256 policyFlags, uint256 maxManagementFee, uint256 maxPerformanceFee)',
  'function maxRelativeCapByMandateRisk(uint256 mandateId, bytes32 riskId) view returns (uint256)',
  'function hasRelativeCapByMandateRisk(uint256 mandateId, bytes32 riskId) view returns (bool)',
  'function approvedAdapterByMandate(uint256 mandateId, address adapter) view returns (bool)',
  'function approvedSendSharesGateByMandate(uint256 mandateId, address gate) view returns (bool)',
  'function approvedReceiveAssetsGateByMandate(uint256 mandateId, address gate) view returns (bool)',
  'function armPolicyMandate(address vault, uint256 shares, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, PolicyConfig config) returns (uint256 mandateId)',
  'function cancel(uint256 mandateId)',
  'event PolicyMandateArmed(uint256 indexed mandateId, address indexed owner, address indexed vault, uint256 shares, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, uint256 policyFlags)',
  'event MandateCancelled(uint256 indexed mandateId, address indexed owner)',
]);
