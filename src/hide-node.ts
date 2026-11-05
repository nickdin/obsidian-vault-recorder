/**
 * Must be the worker's first import. Obsidian exposes Node's `process` object
 * inside Web Workers, and transformers.js decides it is running in Node.js when
 * it sees `process.release.name === "node"`: it then offers only the Node
 * devices and fails on the missing native runtime. Hiding `process` before the
 * library's module body runs makes it take the browser path.
 *
 * (The same check inside ONNX Runtime's own loader is switched off in the
 * loader's text by `esbuild.config.mjs`, because the threads it starts each see
 * `process` afresh.)
 */
// `self` is the worker's global object, the one the library reads `process` from.
(self as { process?: unknown }).process = undefined;
