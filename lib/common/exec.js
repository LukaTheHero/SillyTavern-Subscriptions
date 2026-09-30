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
// Launch specs never need a shell; spawn them with `shell: false`.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';

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
        if (!val) continue;
        if (!existsSync(val)) {
            warnOnce(`${v}:${val}`, `[subscriptions] ${v}=${val} does not exist — ignored`);
            continue;
        }
        const spec = launchSpec(val, `env:${v}`);
        if (spec) return spec;
    }
    // explicit install dirs first (native installers), then PATH
    const hit = findOnPath(names, extraDirs);
    if (hit && !(IS_WINDOWS && /\.(cmd|bat)$/i.test(hit))) return launchSpec(hit, 'path');
    // npm global package launcher (avoids .cmd shims on Windows)
    if (npm) {
        const f = findInGlobalPackage(npm.pkg, npm.files);
        if (f) return launchSpec(f, `npm:${npm.pkg}`);
    }
    // Last resort: a Windows .cmd shim, run through the JS launcher it wraps
    // (launchSpec refuses shims it cannot resolve).
    if (hit) return launchSpec(hit, 'path');
    return null;
}

const warned = new Set();
function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(message);
}

/**
 * The JS launcher an npm-generated Windows `.cmd` shim runs, or null. npm
 * (cmd-shim) writes lines like:
 *   "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
 */
export function jsTargetOfCmdShim(path) {
    try {
        const text = readFileSync(path, 'utf8');
        const m = text.match(/"%~?dp0%?\\([^"%]+?\.(?:m?js|cjs))"/i);
        if (!m) return null;
        const target = join(dirname(path), m[1]);
        return isFile(target) ? target : null;
    } catch {
        return null;
    }
}

/**
 * Turn a file path into { command, args } — JS files run under the current
 * Node. Nothing is ever launched through a shell: request data (model ids,
 * prompts) ends up in argv, and cmd.exe would interpret its metacharacters.
 * Windows .cmd/.bat shims are therefore resolved to the JS file they wrap;
 * a shim that cannot be resolved is refused (null).
 */
export function launchSpec(path, source) {
    if (/\.(m?js|cjs)$/i.test(path)) {
        return { command: process.execPath, args: [path], path, source, isScript: true };
    }
    if (IS_WINDOWS && /\.(cmd|bat)$/i.test(path)) {
        const js = jsTargetOfCmdShim(path);
        if (js) return { command: process.execPath, args: [js], path: js, source: `${source} (via ${basename(path)})`, isScript: true };
        console.warn(`[subscriptions] ignoring ${path}: .cmd/.bat launchers cannot be run without a shell — point the *_PATH override at the .exe or the package's .js launcher instead`);
        return null;
    }
    return { command: path, args: [], path, source, isScript: false };
}
