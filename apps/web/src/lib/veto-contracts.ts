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
