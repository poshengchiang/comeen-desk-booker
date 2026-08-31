/**
 * Learn mode, extension side. The recorder runs in the page world and cannot
 * touch chrome.* APIs, so it shouts into `window.postMessage` and this isolated
 * content script is what listens and persists.
 *
 * Captures are only kept while learn mode is on, and only ever in
 * chrome.storage.local on this machine.
 */

import { CAPTURE_MARKER } from './core/marker.js';

const MAX_CAPTURES = 40;

interface CaptureMessage {
    [key: string]: unknown;
    capture?: unknown;
}

/**
 * Learn mode is cached rather than read per request.
 *
 * The recorder posts every interesting request it sees, because it runs in the
 * page world and has no way to ask whether anyone is listening. Reading
 * chrome.storage on each of those meant a storage round trip per API call
 * during normal use, purely to discover the answer was "no".
 */
let learnMode = false;

void chrome.storage.local.get('learnMode')
    .then((stored) => { learnMode = stored.learnMode === true; })
    // Reloading the extension while this first read is in flight rejects it.
    // Nothing to recover, and an unhandled rejection is the noise being fixed.
    .catch(() => { learnMode = false; });

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.learnMode) learnMode = changes.learnMode.newValue === true;
});

/**
 * Reloading the extension orphans this script: the page keeps running it, but
 * its chrome.* handles are dead and every call throws "Extension context
 * invalidated". `chrome.runtime.id` goes undefined at exactly that moment, so
 * it is the cheap way to notice and go quiet instead of filling the console
 * with one rejection per request until the tab is reloaded.
 */
function contextAlive(): boolean {
    try {
        return chrome.runtime?.id !== undefined;
    } catch {
        return false;
    }
}

window.addEventListener('message', (event: MessageEvent<CaptureMessage>) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (!event.data || event.data[CAPTURE_MARKER] !== true) return;
    if (!learnMode || !contextAlive()) return;

    const { capture } = event.data;
    if (!capture) return;

    void (async () => {
        try {
            const { captures = [] } = await chrome.storage.local.get('captures') as {
                captures?: unknown[];
            };
            await chrome.storage.local.set({
                captures: [capture, ...captures].slice(0, MAX_CAPTURES),
            });
        } catch {
            // The extension was reloaded mid-flight. Nothing to salvage, and a
            // dropped capture is not worth an unhandled rejection.
        }
    })();
});
