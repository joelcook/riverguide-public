// Build the chat page into dist/, which the Worker serves as static assets:
//   main.js, pii-worker.js       the page and Rampart Edge's worker
//   chunk-*.js                   Rampart Edge's client (app/pii.ts), loaded after the page
//   college-contacts.json        the College's phone numbers and addresses, which Rampart Edge lets pass
//   questions.json               the typeahead's dictionary
//                                (both from the College's pages: scripts/college.ts)
//   photos/…                     the College's photos (app/public, copied as-is)
//   fonts/…                      Aleo and Instrument Sans (SIL OFL) from their pinned Fontsource packages
//   models/rampart-edge/…        Rampart Edge's model and vocabulary from its pinned package; the .onnx
//                                is stored gzipped and the Worker serves it compressed (src/worker.ts)
//   ort/…                        Rampart Edge's trimmed ONNX Runtime engine
import { $, type BunPlugin } from "bun";
import { BUNDLED_RUNTIME_ORT_VERSION, compileAllowlist, MODEL_FILES, verifyPinned } from "@nationaldesignstudio/rampart-edge";
import { collegeContacts, collegeQuestions } from "./college";

const EDGE = "node_modules/@nationaldesignstudio/rampart-edge";
const ORT_ENGINE = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]; // pinned in app/pii-worker.ts
const FONTS = {
  "@fontsource-variable/aleo": ["aleo-latin-wght-normal.woff2", "aleo-latin-ext-wght-normal.woff2"],
  "@fontsource-variable/instrument-sans": [
    "instrument-sans-latin-wght-normal.woff2",
    "instrument-sans-latin-ext-wght-normal.woff2",
    "instrument-sans-latin-wght-italic.woff2",
    "instrument-sans-latin-ext-wght-italic.woff2",
  ],
};

// The engine's glue and .wasm work only with the onnxruntime-web release they were built from.
const ort = (await Bun.file("node_modules/onnxruntime-web/package.json").json()).version;
if (ort !== BUNDLED_RUNTIME_ORT_VERSION) {
  throw new Error(`onnxruntime-web is ${ort}; Rampart Edge's engine needs ${BUNDLED_RUNTIME_ORT_VERSION}`);
}

// Rampart Edge imports onnxruntime-web, whose default build is the WebGPU one (410 KB, and it
// expects a WebGPU engine). The trimmed engine is a CPU engine, so bundle the CPU build (70 KB).
const ortCpuOnly: BunPlugin = {
  name: "onnxruntime-web CPU build",
  setup(build) {
    build.onResolve({ filter: /^onnxruntime-web$/ }, () => ({ path: Bun.resolveSync("onnxruntime-web/wasm", process.cwd()) }));
  },
};

await $`rm -rf dist && mkdir -p dist`;
const outputs: Bun.BuildArtifact[] = [];
for (const options of [
  // The page, with Rampart Edge's client (app/pii.ts) split off to load after it.
  { entrypoints: ["app/main.ts"], splitting: true },
  // The worker on its own, so it shares no chunks with the page.
  { entrypoints: ["app/pii-worker.ts"], plugins: [ortCpuOnly] },
]) {
  const result = await Bun.build({ outdir: "dist", target: "browser", format: "esm", minify: true, sourcemap: "linked", ...options });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  outputs.push(...result.outputs);
}
await $`cp app/index.html app/styles.css dist/ && cp -r app/public/. dist/`;

// Fonts: the Latin subsets styles.css declares, with each family's license.
await $`mkdir -p dist/fonts`;
for (const [pkg, files] of Object.entries(FONTS)) {
  for (const file of files) await $`cp node_modules/${pkg}/files/${file} dist/fonts/`;
  await $`cp node_modules/${pkg}/LICENSE dist/fonts/${pkg.split("/")[1]}-OFL.txt`;
}

// From the College's pages: its contacts (compiled here as the browser will, so a bad entry fails the
// build) and the typeahead's questions.
const contacts = await collegeContacts();
compileAllowlist(contacts);
await Bun.write("dist/college-contacts.json", JSON.stringify(contacts));
const questions = await collegeQuestions();
await Bun.write("dist/questions.json", JSON.stringify({ entries: questions }));

// Rampart Edge's model and vocabulary, checked against the package's pins (the browser checks them
// again). Cloudflare doesn't compress .onnx files, so the model ships gzipped (1.45 MB → 1.2 MB).
let gzipped = 0;
for (const [file, pin] of Object.entries(MODEL_FILES)) {
  const bytes = await Bun.file(`${EDGE}/model/${file}`).bytes();
  await verifyPinned(file, bytes, pin);
  if (file.endsWith(".onnx")) {
    const gz = Bun.gzipSync(bytes); // the default level; 9 comes out larger
    gzipped = gz.length;
    await Bun.write(`dist/models/rampart-edge/${file}.gz`, gz);
  } else {
    await Bun.write(`dist/models/rampart-edge/${file}`, bytes);
  }
}

// The engine (Cloudflare compresses .mjs and .wasm itself).
await $`mkdir -p dist/ort`;
for (const file of ORT_ENGINE) await $`cp ${EDGE}/runtime/${file} dist/ort/`;

for (const output of outputs) console.log(`${output.path.replace(`${process.cwd()}/`, "")}  ${(output.size / 1024).toFixed(0)} KB`);
console.log(`dist/models/rampart-edge  model_q4.onnx.gz ${(gzipped / 1e6).toFixed(2)} MB  dist/ort/  engine for onnxruntime-web ${ort}`);
console.log(`dist/college-contacts.json  ${contacts.phones.length} phones, ${contacts.addresses.length} addresses`);
console.log(`dist/questions.json  ${questions.length} questions`);
