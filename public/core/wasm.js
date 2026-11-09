// Loading WebAssembly under the page's CSP.
//
// The CSP allows compiling wasm ('wasm-unsafe-eval') but keeps
// connect-src 'none', so fetch('./x.wasm') is blocked. Instead each .wasm
// ships as a JS module whose default export is the bytes as base64, made by
// `python3 tools/wasm2js.py x.wasm` (writes x.wasm.js). Plain `import` loads
// it like any other script, so it works on GitHub Pages with only the
// <meta> CSP. See docs/ref/formats.md, "WebAssembly".
//
// Use from an op, only when it's needed (so the bytes download on demand):
//   const { exports } = await loadWasm(new URL('./codec.wasm.js', import.meta.url));

const compiled = new Map(); // module URL -> Promise<WebAssembly.Module>

/** Decode base64 to bytes (native Uint8Array.fromBase64 where it exists). */
export function base64ToBytes(s) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Compile the wasm in a base64 module (made by tools/wasm2js.py) once per page
 * and return the WebAssembly.Module. `url` is a URL or a string absolute URL.
 */
export function compileWasm(url) {
  const key = String(url);
  let p = compiled.get(key);
  if (!p) {
    p = import(key).then((m) => WebAssembly.compile(base64ToBytes(m.default)));
    p.catch(() => compiled.delete(key)); // let a later call try again
    compiled.set(key, p);
  }
  return p;
}

/** Compile (cached) and instantiate. Returns the WebAssembly.Instance. */
export async function loadWasm(url, imports = {}) {
  return WebAssembly.instantiate(await compileWasm(url), imports);
}
