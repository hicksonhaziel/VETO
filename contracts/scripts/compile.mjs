import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import solc from 'solc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'src', 'VetoExitGuard.sol');

export function compileGuard() {
  const input = {
    language: 'Solidity',
    sources: {
      'VetoExitGuard.sol': { content: fs.readFileSync(sourcePath, 'utf8') },
    },
    settings: {
      optimizer: { enabled: true, runs: 100_000 },
      evmVersion: 'cancun',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter(({ severity }) => severity === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map(({ formattedMessage }) => formattedMessage).join('\n'));
  }
  return output.contracts['VetoExitGuard.sol'].VetoExitGuard;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const artifact = compileGuard();
  if (!process.argv.includes('--check')) {
    const outputDirectory = path.join(root, 'dist');
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(outputDirectory, 'VetoExitGuard.json'),
      `${JSON.stringify(artifact, null, 2)}\n`,
    );
  }
}
