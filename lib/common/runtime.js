// ──────────────────────────────────────────────
// Plugin-owned runtime directory
// ──────────────────────────────────────────────
//
// Scratch working directories for CLI subprocesses and the isolated config
// dir used for Claude's API-key mode all live under <plugin>/.runtime/ —
// git-ignored, recreated on demand, safe to delete.

import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function pluginRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function runtimeDir(sub = '') {
    const dir = resolve(pluginRoot(), '.runtime', sub);
    mkdirSync(dir, { recursive: true });
    return dir;
}
