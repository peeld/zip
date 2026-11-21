// Run a decoder from lib/tasks.js in a Web Worker, so a big .xz / .zst / .bz2,
// zip entry or 7z folder doesn't freeze the page. No DOM.
//
//   const stream = offload('unxz', file, null, { onBytes });
//
// The worker starts from a blob: URL whose only line imports lib/worker.js. A
// worker from a blob: URL takes the page's CSP (the <meta> one on GitHub
// Pages), so it can't fetch either; a worker from a normal URL would take the
// CSP of its own HTTP response, which GitHub Pages doesn't send. Needs
// `worker-src 'self' blob:` (Firefox checks a module worker's imports against
// worker-src). See docs/ref/formats.md, "Web Workers".
//
// Small inputs are decoded on the page (starting a worker isn't free), and so
// is everything once a worker has failed to start (an older browser, a stricter CSP).

import { TASKS } from './tasks.js';

const MIN_SIZE = 128 << 10; // input bytes; below this, decode on the page
const IDLE_MAX = 2;          // finished workers kept for the next job
const START_TIMEOUT = 20000;

let minSize = MIN_SIZE;
let broken = false; // a worker failed to start: decode on the page from now on
let nextId = 1;
const idle = [];

/** Counters for the tests: workers started, jobs run in one, jobs run on the page. */
export const offloadStats = { workers: 0, jobs: 0, local: 0, broken: () => broken };

/** For the tests: the input size from which jobs go to a worker (0: all of them). */
export function setOffloadThreshold(n = MIN_SIZE) { minSize = n; }

const inWorker = typeof WorkerGlobalScope !== 'undefined';

/**
 * Start a module worker from a blob: URL that imports `entry` (an absolute URL),
 * so it runs under the page's CSP. Resolves once the worker posts { hello }.
 */
export function startWorker(entry) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([`import ${JSON.stringify(String(entry))};`], { type: 'text/javascript' }));
    let w;
    const end = (ok, e) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      if (!w) return reject(e);
      w.onmessage = w.onerror = null;
      if (ok) resolve(w);
      else { w.terminate(); reject(e); }
    };
    const timer = setTimeout(() => end(false, new Error('the worker did not start')), START_TIMEOUT);
    try {
      w = new Worker(url, { type: 'module' });
    } catch (e) {
      end(false, e);
      return;
    }
    w.onmessage = ({ data }) => { if (data?.hello) end(true); };
    w.onerror = (e) => { e.preventDefault(); end(false, new Error(e.message || 'the worker failed to start')); };
  });
}

async function getWorker() {
  if (idle.length) return idle.pop();
  const w = await startWorker(new URL('./worker.js', import.meta.url));
  offloadStats.workers++;
  return w;
}

function release(w) {
  w.onmessage = w.onerror = null;
  if (idle.length < IDLE_MAX) idle.push(w); else w.terminate();
}

const errorFrom = ({ message, name }) => Object.assign(new Error(message), { name });

/** A { read, cancel } source for one job in a worker. Rejects with startFailed set if no worker could start. */
async function remote(task, blob, args, onBytes) {
  let w;
  try {
    w = await getWorker();
  } catch (e) {
    throw Object.assign(e, { startFailed: true });
  }
  offloadStats.jobs++;
  const id = nextId++;
  let pending = null; // the read waiting for a reply
  let live = true;    // false once the job ended and the worker was released or terminated
  const settle = (fn, x) => { const p = pending; pending = null; p?.[fn](x); };
  w.onmessage = ({ data: m }) => {
    if (m.id !== id) return;
    if (m.bytes) onBytes(m.bytes);
    else if (m.chunk) settle('resolve', { value: m.chunk, done: false });
    else if (m.done) { live = false; release(w); settle('resolve', { value: undefined, done: true }); }
    else if (m.error) { live = false; release(w); settle('reject', errorFrom(m.error)); }
  };
  w.onerror = (e) => {
    e.preventDefault();
    live = false;
    w.terminate();
    settle('reject', new Error(`the decoder stopped: ${e.message || 'worker error'}`));
  };
  w.postMessage({ id, task, blob, args });
  return {
    read() {
      if (!live) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        w.postMessage({ id, pull: true });
      });
    },
    // Stopping the worker is the quickest way to stop it decoding.
    cancel() {
      if (!live) return;
      live = false;
      w.terminate();
      settle('resolve', { value: undefined, done: true });
    },
  };
}

/** A { read, cancel } source for one job on the page. */
async function local(task, blob, args, onBytes) {
  offloadStats.local++;
  const reader = (await TASKS[task](blob, args, onBytes)).getReader();
  return { read: () => reader.read(), cancel: (why) => reader.cancel(why) };
}

/**
 * The output of TASKS[task](blob, args) as a ReadableStream, decoded in a
 * worker when the input is big enough (`size`, default blob.size). Nothing
 * starts until the stream is first read. onBytes(n) reports progress through
 * the input, as the decoders do.
 */
export function offload(task, blob, args = null, { onBytes = () => {}, size = blob.size } = {}) {
  if (!Object.hasOwn(TASKS, task)) throw new Error(`unknown task: ${task}`);
  const here = inWorker || broken || typeof Worker === 'undefined' || size < minSize;
  let src = null;
  const open = () => (src ??= here ? local(task, blob, args, onBytes)
    : remote(task, blob, args, onBytes).catch((e) => {
      if (!e.startFailed) throw e;
      broken = true;
      return local(task, blob, args, onBytes);
    }));
  return new ReadableStream({
    async pull(ctl) {
      const { value, done } = await (await open()).read();
      if (done) ctl.close(); else ctl.enqueue(value);
    },
    async cancel(why) {
      if (!src) return;
      try { (await src).cancel(why); } catch { /* it never started */ }
    },
  }, { highWaterMark: 0 });
}
