import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedModule: any = null;

export async function getModule() {
  if (cachedModule) return cachedModule;
  const createMeshFixCore = require(path.resolve(__dirname, '../../dist/meshfix-core.js'));
  cachedModule = await createMeshFixCore();
  return cachedModule;
}
