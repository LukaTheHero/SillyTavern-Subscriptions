// ──────────────────────────────────────────────
// Cross-platform executable resolution
// ──────────────────────────────────────────────
//
// The three CLIs this plugin drives are installed in wildly different ways:
//   • npm -g (Codex, Claude Code): on Windows the PATH entry is a `.cmd` shim
//     which Node's spawn() refuses without shell:true — so we resolve the
//     package's JS launcher inside the global node_modules and run it with
//     the current Node instead. On Linux/macOS/Termux the bin symlink is fine.
//   • Native installers (claude, agy, codex): ~/.local/bin, ~/.agy/bin,
//     ~/.codex/bin, %LOCALAPPDATA%\agy\bin, %USERPROFILE%\.local\bin …
//   • Termux: $PREFIX/bin and $PREFIX/lib/node_modules.
//
// resolveExecutable() returns a *launch spec* — { command, args, path, source }
// — so callers never have to think about .cmd shims or JS launchers again.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { IS_WINDOWS, IS_TERMUX, termuxPrefix, home } from './platform.js';

const WINDOWS_EXE_EXTS = ['.exe', '.cmd', '.bat'];

function isFile(p) {
    try { return statSync(p).isFile(); } catch { return false; }
}

/** Directories that may hold a global npm `node_modules`. */
export function globalNodeModulesRoots() {
    const roots = [];
    const h = home();
    if (IS_WINDOWS) {
        roots.push(join(process.env.APPDATA || join(h, 'AppData', 'Roaming'), 'npm', 'node_modules'));
        roots.push(join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules'));
    } else {
        if (IS_TERMUX) roots.push(join(termuxPrefix(), 'lib', 'node_modules'));
        roots.push(join(h, '.npm-global', 'lib', 'node_modules'));
        roots.push(join(h, '.local', 'lib', 'node_modules'));
        roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules', '/opt/homebrew/lib/node_modules');
        // nvm / fnm / volta layouts
        for (const base of [join(h, '.nvm', 'versions', 'node'), join(h, '.local', 'share', 'fnm', 'node-versions'), join(h, '.fnm', 'node-versions')]) {
            try {
                for (const v of readdirSync(base)) {
                    roots.push(join(base, v, 'lib', 'node_modules'));
                    roots.push(join(base, v, 'installation', 'lib', 'node_modules'));
                }
            } catch { /* not present */ }
        }
        roots.push(join(h, '.volta', 'tools', 'image', 'packages'));
    }
    // Node's own prefix (works for custom prefixes / portable installs)
    try {
        const execDir = join(process.execPath, '..');
        roots.push(IS_WINDOWS ? join(execDir, 'node_modules') : join(execDir, '..', 'lib', 'node_modules'));
    } catch { /* ignore */ }
    return [...new Set(roots)];
}

/** Common "user bin" directories that installers drop binaries into. */
export function commonBinDirs() {
    const h = home();
    const dirs = [];
    if (IS_WINDOWS) {
        dirs.push(join(h, '.local', 'bin'));
        dirs.push(join(process.env.LOCALAPPDATA || join(h, 'AppData', 'Local'), 'Programs'));
        dirs.push(join(process.env.APPDATA || join(h, 'AppData', 'Roaming'), 'npm'));
    } else {
        if (IS_TERMUX) dirs.push(join(termuxPrefix(), 'bin'));
        dirs.push(join(h, '.local', 'bin'), join(h, 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
    }
    return dirs;
}

/**
 * Search PATH (+ extra dirs) for a bare command name.
 * Windows: .exe first; .cmd/.bat shims are returned only when nothing better
 * exists (extensionless POSIX shell shims from npm are never runnable there).
 */
export function findOnPath(names, extraDirs = []) {
    const list = Array.isArray(names) ? names : [names];
    const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(delimiter).filter(Boolean)];
    let shim = null;
    for (const dir of dirs) {
        for (const name of list) {
            if (IS_WINDOWS) {
                const exe = join(dir, name + '.exe');
                if (isFile(exe)) return exe;
                for (const ext of WINDOWS_EXE_EXTS.slice(1)) {
                    const p = join(dir, name + ext);
                    if (!shim && isFile(p)) shim = p;
                }
            } else {
                const p = join(dir, name);
                if (isFile(p)) return p;
            }
        }
    }
    return shim;
}

/** Locate a file inside a globally installed npm package, if any root has it. */
export function findInGlobalPackage(pkg, relPaths) {
    const rels = Array.isArray(relPaths) ? relPaths : [relPaths];
    for (const root of globalNodeModulesRoots()) {
        for (const rel of rels) {
            const p = join(root, pkg, rel);
            if (isFile(p)) return p;
        }
    }
    return null;
}

/**
 * Build a launch spec for a CLI.
 * @param {object} spec
 * @param {string[]} spec.envVars   explicit override env vars (first set wins; may point at an exe or a .js)
 * @param {string[]} spec.names     bare command names to look up on PATH
 * @param {string[]} spec.extraDirs extra directories to check before PATH
 * @param {{ pkg: string, files: string[] }} [spec.npm] global npm package + candidate launcher files
 * @returns {{ command: string, args: string[], path: string, source: string } | null}
 */
export function resolveExecutable({ envVars = [], names = [], extraDirs = [], npm = null }) {
    for (const v of envVars) {
        const val = process.env[v];
        if (val && existsSync(val)) return launchSpec(val, `env:${v}`);
    }
    // explicit install dirs first (native installers), then PATH
    const hit = findOnPath(names, extraDirs);
    if (hit && !(IS_WINDOWS && /\.(cmd|bat)$/i.test(hit))) return launchSpec(hit, 'path');
    // npm global package launcher (avoids .cmd shims on Windows)
    if (npm) {
        const f = findInGlobalPackage(npm.pkg, npm.files);
        if (f) return launchSpec(f, `npm:${npm.pkg}`);
    }
    // last resort: the .cmd shim via the JS it points at is unknown — give up on
    // it, but on POSIX a bare name on PATH is always runnable.
    if (hit) return launchSpec(hit, 'path');
    return null;
}

/** Turn a file path into { command, args } — JS files run under the current Node. */
export function launchSpec(path, source) {
    if (/\.(m?js|cjs)$/i.test(path)) {
        return { command: process.execPath, args: [path], path, source, isScript: true };
    }
    if (IS_WINDOWS && /\.(cmd|bat)$/i.test(path)) {
        // Node ≥ 18.20/20.12 blocks .cmd without shell:true (CVE-2024-27980).
        return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${path}"`], path, source, isScript: false, shell: true };
    }
    return { command: path, args: [], path, source, isScript: false };
}
