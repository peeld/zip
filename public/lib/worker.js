// Worker side of lib/offload.js. Started from a blob: URL that imports this
// file, so it runs under the page's own CSP (connect-src 'none' included).
// One job at a time: { id, task, blob, args } starts it, { id, pull } asks
// for the next chunk (the one after it is decoded meanwhile). Replies:
// { id, chunk } | { id, done } | { id, error } | { id, bytes } (progress);
// { hello } once loaded. To cancel a job, the page terminates the worker.

import { TASKS } from './tasks.js';

let job = null; // { id, reader, next }
let queue = Promise.resolve();

const failure = (e) => ({ message: String(e?.message ?? e), name: e?.name || 'Error' });

/** The next read, started now; its rejection is handled when it's awaited. */
function readAhead(reader) {
  const p = reader.read();
  p.catch(() => {});
  return p;
}

async function handle(m) {
  if (m.task) {
    const id = m.id;
    try {
      if (!Object.hasOwn(TASKS, m.task)) throw new Error(`unknown task: ${m.task}`);
      const stream = await TASKS[m.task](m.blob, m.args, (n) => postMessage({ id, bytes: n }));
      const reader = stream.getReader();
      job = { id, reader, next: readAhead(reader) };
    } catch (e) {
      job = { id, error: failure(e) };
    }
    return;
  }
  if (!job || job.id !== m.id) return;
  if (job.error) { postMessage({ id: job.id, error: job.error }); job = null; return; }
  try {
    const { value, done } = await job.next;
    if (done) { postMessage({ id: job.id, done: true }); job = null; return; }
    job.next = readAhead(job.reader);
    // Decoders yield fresh arrays; only copy a view into a bigger buffer before transferring it.
    const chunk = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value : value.slice();
    postMessage({ id: job.id, chunk }, [chunk.buffer]);
  } catch (e) {
    postMessage({ id: job.id, error: failure(e) });
    job = null;
  }
}

// In order: a pull must not overtake the start of its job.
onmessage = ({ data }) => { queue = queue.then(() => handle(data)); };
postMessage({ hello: true });
