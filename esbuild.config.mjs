import esbuild from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import process from "node:process";
import { gzipSync } from "node:zlib";

const production = process.argv[2] === "production";
const require = createRequire(import.meta.url);
// Node's own modules, each also under its node: prefix. Some exist only with
// the prefix (node:test, node:sea); those are listed once, as they are.
const builtins = builtinModules.flatMap((m) => (m.startsWith("node:") ? [m] : [m, `node:${m}`]));

// The on-device transcriber's speech-model code runs in a Web Worker, and the
// worker has to travel inside main.js as text: a community plugin is installed
// as main.js, manifest.json and styles.css alone. So the build has three steps
// before main.js, all into build/:
//
//   1. ONNX Runtime's loader for its WebAssembly binary, with its Node check
//      switched off (below), as engine-loader.txt.
//   2. The WebAssembly binary itself, compressed, as engine.wasm.gz. It is
//      27 MB raw and about a third of that compressed; the plugin unpacks it
//      only when a recording is being transcribed.
//   3. The worker (src/model-runner-worker.ts, transformers.js, ONNX Runtime's
//      JavaScript) as worker.bundle.txt.
//
// main.js then imports the last two as a string each.

// The loader starts one more worker per thread, and each of those sees Node's
// `process` afresh inside Obsidian, takes the Node.js path and dies. Its check
// is therefore switched off in the text itself, which is what transformers.js
// does to the copy it downloads from a CDN. Fail loud if the check ever
// disappears: the thread fix would then need rewriting.
const NODE_CHECK = "globalThis.process?.versions?.node";

await mkdir("build", { recursive: true });

const loader = await readFile(require.resolve("onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs"), "utf8");
if (!loader.includes(NODE_CHECK)) {
  throw new Error(`ONNX Runtime's loader no longer contains "${NODE_CHECK}"; the thread fix needs rewriting.`);
}
await writeFile("build/engine-loader.txt", loader.replaceAll(NODE_CHECK, "false"));
await writeFile(
  "build/engine.wasm.gz",
  gzipSync(await readFile(require.resolve("onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm")), { level: 9 }),
);

await esbuild.build({
  entryPoints: ["src/model-runner-worker.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  loader: { ".txt": "text" },
  minify: true,
  logLevel: "info",
  outfile: "build/worker.bundle.txt",
});

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    // Obsidian supplies the editor libraries at run time; a bundled second
    // copy breaks an editor extension.
    "@codemirror/*",
    "@lezer/*",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  minify: production,
  loader: { ".txt": "text", ".gz": "base64" },
  outfile: "main.js",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
