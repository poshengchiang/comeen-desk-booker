import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const shared = {
    outdir: 'dist',
    bundle: true,
    target: 'chrome120',
    platform: 'browser',
    sourcemap: 'inline',
    logLevel: 'info',
};

// The service worker and the popup are declared as modules, so ESM is correct.
const moduleBuild = {
    ...shared,
    entryPoints: { background: 'src/background.ts', popup: 'src/popup.ts' },
    format: 'esm',
};

// Content scripts are always classic scripts, whatever world they run in.
// Emitting ESM here would break them at load time, so they get their own pass.
const contentBuild = {
    ...shared,
    entryPoints: {
        'content-recorder': 'src/content-recorder.ts',
        'content-bridge': 'src/content-bridge.ts',
    },
    format: 'iife',
};

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('public', 'dist', { recursive: true });

if (watch) {
    for (const options of [moduleBuild, contentBuild]) {
        const ctx = await context(options);
        await ctx.watch();
    }
    console.log('watching…  (changes under public/ need a re-run)');
} else {
    await Promise.all([build(moduleBuild), build(contentBuild)]);
    console.log('built → dist/  (load that folder in chrome://extensions)');
}
