// Runs inside /csp-check.html, which run_tests.py serves with the exact <meta> CSP
// from public/index.html (as on GitHub Pages). Reports to the parent with postMessage,
// because the CSP blocks fetch/POST.
import { loadWasm } from '../public/core/wasm.js';

const r = {};
try {
  const { exports } = await loadWasm(new URL('/fixtures/add.wasm.js', location.href));
  r.add = exports.add(2, 3);
} catch (e) { r.wasmError = String(e); }
try { await fetch('/fixtures/manifest.json'); r.fetch = 'allowed'; } catch { r.fetch = 'blocked'; }
try { new Function('return 1')(); r.eval = 'allowed'; } catch { r.eval = 'blocked'; }
parent.postMessage(r, '*');
