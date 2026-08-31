/**
 * Build the thing you actually send to a colleague.
 *
 *   npm run bundle
 *
 * Produces comeen-desk-booker-<version>.zip containing exactly two things:
 * the README, which is the setup guide, and dist/, which is what Chrome loads.
 *
 * Not the whole repository: src/, test/, tools/ and the lockfile are noise to
 * someone who will never build this, and their presence suggests a build step
 * that does not exist for them.
 *
 * Not dist/ alone either: that arrives as eleven unexplained files with no
 * instructions anywhere.
 *
 * ─── Why it bumps the version ────────────────────────────────────────────────
 * Copies of a zip are dead the moment they are sent. Without a version, every
 * copy in circulation reports the same 0.1.0 in chrome://extensions, and
 * "mine is behaving oddly" cannot be told apart from "mine is four builds old".
 * Bumping here rather than by hand means it cannot be forgotten, because
 * producing a bundle is the only way a build reaches anyone.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'comeen-desk-booker';

function bumpPatch(version) {
    const [major = '0', minor = '0', patch = '0'] = version.split('.');
    return `${major}.${minor}.${Number(patch) + 1}`;
}

/** manifest.json is the one Chrome shows; package.json is kept in step with it. */
function bumpVersion() {
    const manifestPath = join(ROOT, 'public', 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const next = bumpPatch(manifest.version);

    manifest.version = next;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);

    const packagePath = join(ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    pkg.version = next;
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 4)}\n`);

    return next;
}

const version = bumpVersion();
console.log(`version → ${version}`);

// Rebuild after the bump, so the manifest inside dist/ carries the new number.
execFileSync('node', [join(ROOT, 'build.mjs')], { stdio: 'inherit' });

// Staged under a folder of its own, so unzipping produces one tidy directory
// rather than scattering README.md and dist/ into wherever they were opened.
const staging = mkdtempSync(join(tmpdir(), 'comeen-bundle-'));
const folder = join(staging, NAME);
mkdirSync(folder, { recursive: true });
cpSync(join(ROOT, 'README.md'), join(folder, 'README.md'));
cpSync(join(ROOT, 'dist'), join(folder, 'dist'), { recursive: true });

const zipPath = join(ROOT, `${NAME}-${version}.zip`);
rmSync(zipPath, { force: true });
// -r recurse, -q quiet, -X drop the macOS resource forks that otherwise ride along.
execFileSync('zip', ['-rqX', zipPath, NAME], { cwd: staging });
rmSync(staging, { recursive: true, force: true });

console.log(`\nbundle → ${zipPath}`);
console.log('Send that file. Unzipping gives a folder with the README and dist/ inside.');
console.log(`Ask anyone reporting a problem what chrome://extensions shows: it will say ${version}.`);
