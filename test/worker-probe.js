// Started by test/wasm-csp.js through lib/offload.js startWorker (a blob: URL
// worker), inside /csp-check.html. Shows what the page's CSP allows in it.
import { TASKS } from '../public/lib/tasks.js';

postMessage({ hello: true });
const r = { tasks: Object.keys(TASKS).length };
try { await fetch(new URL('/fixtures/manifest.json', import.meta.url)); r.fetch = 'allowed'; } catch { r.fetch = 'blocked'; }
try { new Function('return 1')(); r.eval = 'allowed'; } catch { r.eval = 'blocked'; }
try { await import(new URL('../public/lib/crc32.js', import.meta.url)); r.dynamicImport = 'allowed'; } catch { r.dynamicImport = 'blocked'; }
postMessage(r);
