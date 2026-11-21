// Runs inside /csp-check.html, which run_tests.py serves with the exact <meta> CSP
// from public/index.html (as on GitHub Pages). Reports to the parent with postMessage,
// because the CSP blocks fetch/POST. The parent posts { xz, want } (an .xz Blob and
// its bytes) for the Web Worker checks.
import { loadWasm } from '../public/core/wasm.js';
import { offload, offloadStats, setOffloadThreshold, startWorker } from '../public/lib/offload.js';

const input = new Promise((res) => addEventListener('message', (e) => res(e.data), { once: true }));
const r = {};
try {
  const { exports } = await loadWasm(new URL('/fixtures/add.wasm.js', location.href));
  r.add = exports.add(2, 3);
} catch (e) { r.wasmError = String(e); }
try { await fetch('/fixtures/manifest.json'); r.fetch = 'allowed'; } catch { r.fetch = 'blocked'; }
try { new Function('return 1')(); r.eval = 'allowed'; } catch { r.eval = 'blocked'; }

// lib/offload.js: decodes in a blob: worker (or on the page if none can start).
const { xz, want } = await input;
try {
  setOffloadThreshold(0);
  const out = new Uint8Array(await new Response(offload('unxz', xz)).arrayBuffer());
  r.unxz = out.length === want.length && out.every((x, i) => x === want[i]) ? 'same' : `differs (${out.length} bytes)`;
} catch (e) { r.unxz = `error: ${e.message}`; }
r.offload = { workers: offloadStats.workers, jobs: offloadStats.jobs, local: offloadStats.local, broken: offloadStats.broken() };
// What a worker started that way may do (worker-probe.js reports it).
try {
  const w = await startWorker(new URL('/test/worker-probe.js', location.href));
  r.probe = await new Promise((res) => { w.onmessage = (e) => res(e.data); });
  w.terminate();
} catch (e) { r.probe = { error: String(e.message || e) }; }
parent.postMessage(r, '*');
