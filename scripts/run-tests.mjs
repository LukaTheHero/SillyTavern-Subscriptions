#!/usr/bin/env node
// `npm test` — run every test/*.test.js with node:test.
// Lists the files itself instead of relying on shell globbing, which cmd.exe
// does not do and `node --test` only understands from Node 21 on.

import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The plugin runs on Node 18+, but the test suite uses node:test features
// (top-level after() hooks) that arrived in 18.8.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 8)) {
    console.error(`npm test needs Node 18.8 or newer (this is ${process.versions.node}); the plugin itself runs on 18.0+.`);
    process.exit(1);
}

const testDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test');
const files = readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort().map((f) => join(testDir, f));
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
