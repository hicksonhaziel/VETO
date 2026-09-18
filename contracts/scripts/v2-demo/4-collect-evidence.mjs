import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { baseSepolia } from 'viem/chains';

const rpcUrl =
  process.env.BASE_SEPOLIA_RPC_URL || process.env.VETO_RPC_URL || 'https://sepolia.base.org';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const outDir = path.join(root, '.local-data', 'v2-demo');

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(rpcUrl),
});

const guardAbi = parseAbi([
  'function mandates(uint256 mandateId) view returns (address owner, address vault, uint256 shares, uint256 minAssets, uint256 expiresAt, uint256 safetySeconds, bool active, uint256 policyFlags, uint256 maxManagementFee, uint256 maxPerformanceFee)',
  'function factory() view returns (address)',
]);

const vaultAbi = parseAbi([
  'function executableAt(bytes data) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]);

async function main() {
  const deploymentFile = path.join(outDir, 'deployment.json');
  const mandateFile = path.join(outDir, 'mandate.json');
  const proposalFile = path.join(outDir, 'proposal.json');

  const deployment = fs.existsSync(deploymentFile)
    ? JSON.parse(fs.readFileSync(deploymentFile, 'utf8'))
    : null;
  const mandate = fs.existsSync(mandateFile)
    ? JSON.parse(fs.readFileSync(mandateFile, 'utf8'))
    : null;
  const proposal = fs.existsSync(proposalFile)
    ? JSON.parse(fs.readFileSync(proposalFile, 'utf8'))
    : null;

  const currentBlock = await publicClient.getBlockNumber();

  const report = {
    network: 'base-sepolia',
    chainId: baseSepolia.id,
    observedBlockNumber: currentBlock.toString(),
    deployment: deployment ?? 'PENDING_BROADCAST',
    mandate: mandate ?? 'PENDING_ARM',
    proposal: proposal ?? 'PENDING_SUBMISSION',
    verifiedOnchain: false,
  };

  if (deployment?.guardAddress) {
    const code = await publicClient.getBytecode({ address: getAddress(deployment.guardAddress) });
    report.guardBytecodeLength = code ? code.length : 0;
  }

  if (mandate && deployment?.guardAddress) {
    try {
      const onchainMandate = await publicClient.readContract({
        address: getAddress(deployment.guardAddress),
        abi: guardAbi,
        functionName: 'mandates',
        args: [0n],
      });
      report.onchainMandate = {
        owner: onchainMandate[0],
        vault: onchainMandate[1],
        shares: onchainMandate[2].toString(),
        minAssets: onchainMandate[3].toString(),
        active: onchainMandate[6],
        policyFlags: onchainMandate[7].toString(),
        maxPerformanceFee: onchainMandate[9].toString(),
      };
      report.verifiedOnchain = true;
    } catch (e) {
      report.mandateReadError = e.message;
    }
  }

  const evidenceFile = path.join(outDir, 'evidence-summary.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`Evidence summary written to ${evidenceFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
