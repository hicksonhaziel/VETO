import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import solc from 'solc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = path.join(root, 'src');

export function compileContracts() {
  const sources = Object.fromEntries(
    fs
      .readdirSync(sourceDirectory)
      .filter((file) => file.endsWith('.sol'))
      .map((file) => [
        file,
        { content: fs.readFileSync(path.join(sourceDirectory, file), 'utf8') },
      ]),
  );

  const input = {
    language: 'Solidity',
    sources,
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
  return output.contracts;
}

export function compileGuard() {
  return compileContracts()['VetoExitGuard.sol'].VetoExitGuard;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const contracts = compileContracts();
  if (!process.argv.includes('--check')) {
    const outputDirectory = path.join(root, 'dist');
    fs.mkdirSync(outputDirectory, { recursive: true });
    for (const [source, compiled] of Object.entries(contracts)) {
      for (const [name, artifact] of Object.entries(compiled)) {
        if (!artifact.evm?.bytecode?.object) continue;
        fs.writeFileSync(
          path.join(outputDirectory, `${name}.json`),
          `${JSON.stringify({ source, ...artifact }, null, 2)}\n`,
        );
      }
    }
  }
}
