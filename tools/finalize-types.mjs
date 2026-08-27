import { copyFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(process.argv[2] ?? process.cwd());
const commonJsTypes = resolve(packageRoot, 'dist/index.d.ts');
const moduleTypes = resolve(packageRoot, 'dist/index.d.mts');

await copyFile(commonJsTypes, moduleTypes);
await rm(resolve(packageRoot, '.types'), { force: true, recursive: true });
