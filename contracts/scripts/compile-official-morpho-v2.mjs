import { createHash } from 'node:crypto';

import solc from 'solc';

export const morphoVaultV2Release = '2025-09-15';
export const morphoVaultV2Commit = '6f2af6602e05d9e123a87c1067712a4566608044';
export const canonicalFactoryRuntimeSha256 =
  'cf0f79d0fb41a563e915b81cefb581f74acb46336cee022c1991671d9e575d8e';
export const canonicalVaultRuntimeSha256 =
  'e90af065199ce07206bed42cd65b6ecc959bc6cfd7d5889df190d4790af5795b';

const upstreamFiles = {
  'src/VaultV2Factory.sol': '67aae6c395b13b09e4b5af0aa08738af7ea4b4210377417c8f5cf5b8cc1d1246',
  'src/VaultV2.sol': '027839cf5246abd67db755454109a751fa0683aac70f49056d271068b79201f6',
  'src/interfaces/IAdapter.sol': '30e47594e7a91d177c63b68b63c661353c20b92bb0fc48e605893d7d2c13478e',
  'src/interfaces/IAdapterRegistry.sol':
    'dbc8981d1f8cb231a6c3f85e67e1c770145747df1686d86191ff12f3ea408939',
  'src/interfaces/IERC20.sol': '1d9682ff2ea29e80e60e748b88cf47a01b7606a845ed9323b0f303be767051df',
  'src/interfaces/IERC2612.sol': '2b4f6d51f3965e4a8b1d85caaee959f8a4fe8bf6c97ad33c4da1a717f91868cb',
  'src/interfaces/IERC4626.sol': '5a293f3c3fd995c3338ce56468c9197d15e9f0f8d767942aeafb5c3baef5f1ef',
  'src/interfaces/IGate.sol': '9d80c8dc873cce3b66261a02619c5079a4cbbb39936a0f00a532eaed354bfbd9',
  'src/interfaces/IVaultV2.sol': 'e8cacc45b0bab475326b91996ab74492ffa114bc1105177742f62ac5b28f485b',
  'src/interfaces/IVaultV2Factory.sol':
    '9c12686dcfbd3ed4ac2ba3cc45e9e657a6b0365f71233569ab5fa02e5dfbe04f',
  'src/libraries/ConstantsLib.sol':
    '6c64bc1617dc34ea04933f9192c88f1d67163b5800e82c15cba8d3ca80f001b7',
  'src/libraries/ErrorsLib.sol': '58ea626978468e67f57f356bd2ec89276cd3c677d5c4156b12831627467a9e8b',
  'src/libraries/EventsLib.sol': 'cab5c240822fd51c4ed8d1aee6a3469dc71a1d62f429de301fb01ba70849bb5a',
  'src/libraries/MathLib.sol': '9a72949f4fe0317fc9aac3bced953c8e6f32b0015b5e3ac37184dc291eda530b',
  'src/libraries/SafeERC20Lib.sol':
    '1d41dfba079af0490bdecfa235a1b172bd6f7a93980b94ef2e56081d4501fdaa',
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function loadSource(file) {
  const url = new URL(
    `${morphoVaultV2Commit}/${file}`,
    'https://raw.githubusercontent.com/morpho-org/vault-v2/',
  );
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`MORPHO_SOURCE_FETCH_FAILED:${file}:${response.status}`);
  const content = await response.text();
  if (sha256(content) !== upstreamFiles[file]) {
    throw new Error(`MORPHO_SOURCE_HASH_MISMATCH:${file}`);
  }
  return [`lib/vault-v2/${file}`, { content }];
}

export async function compileOfficialMorphoVaultV2() {
  const sources = Object.fromEntries(await Promise.all(Object.keys(upstreamFiles).map(loadSource)));
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 100_000 },
      viaIR: true,
      evmVersion: 'cancun',
      metadata: { appendCBOR: true, bytecodeHash: 'none', useLiteralContent: false },
      outputSelection: {
        '*': {
          '*': [
            'abi',
            'evm.bytecode.object',
            'evm.deployedBytecode.object',
            'evm.deployedBytecode.immutableReferences',
          ],
        },
      },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter(({ severity }) => severity === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  }

  const factory = output.contracts['lib/vault-v2/src/VaultV2Factory.sol'].VaultV2Factory;
  const vault = output.contracts['lib/vault-v2/src/VaultV2.sol'].VaultV2;
  const factoryRuntimeHash = sha256(Buffer.from(factory.evm.deployedBytecode.object, 'hex'));
  const vaultRuntimeHash = sha256(Buffer.from(vault.evm.deployedBytecode.object, 'hex'));
  if (factoryRuntimeHash !== canonicalFactoryRuntimeSha256) {
    throw new Error('MORPHO_FACTORY_RUNTIME_HASH_MISMATCH');
  }
  if (vaultRuntimeHash !== canonicalVaultRuntimeSha256) {
    throw new Error('MORPHO_VAULT_RUNTIME_HASH_MISMATCH');
  }

  return { factory, vault, factoryRuntimeHash, vaultRuntimeHash };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const result = await compileOfficialMorphoVaultV2();
  console.log(
    JSON.stringify({
      release: morphoVaultV2Release,
      commit: morphoVaultV2Commit,
      factoryCreationBytes: result.factory.evm.bytecode.object.length / 2,
      factoryRuntimeBytes: result.factory.evm.deployedBytecode.object.length / 2,
      factoryRuntimeSha256: result.factoryRuntimeHash,
      vaultRuntimeBytes: result.vault.evm.deployedBytecode.object.length / 2,
      vaultRuntimeSha256: result.vaultRuntimeHash,
    }),
  );
}
