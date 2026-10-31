/**
 * Engine version, read from the package manifest.
 *
 * `dist/version.js` resolves `../package.json` (the manifest published next
 * to `dist/`). Vitest runs this file from `src/` and resolves the same
 * manifest. A release bump in `package.json` is the value `ENGINE_VERSION`
 * exports — it is not a second copy of the string.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function readEngineVersion(): string {
  const pkg = require('../package.json') as { name?: string; version?: string };
  if (pkg.name !== '@monkeytestai/monkeytester' || !pkg.version) {
    throw new Error('ENGINE_VERSION could not be read from package.json');
  }
  return pkg.version;
}

/** Package version, for example `0.7.0-beta.1`. */
export const ENGINE_VERSION: string = readEngineVersion();
