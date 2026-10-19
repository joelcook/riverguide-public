// Rampart Edge's gate, off the main thread. The model and the runtime load from this site's own
// /models/ and /ort/ (no third-party requests), as on America.gov.
import { registerGateWorker } from "@nationaldesignstudio/rampart-edge/worker";
import { env } from "onnxruntime-web";

// The package's trimmed ONNX Runtime engine, with only the kernels the gate uses. Its glue and
// .wasm are a pair built for one onnxruntime-web release; scripts/build.ts checks that release and
// copies both to /ort/.
env.wasm.wasmPaths = { mjs: "/ort/ort-wasm-simd-threaded.mjs", wasm: "/ort/ort-wasm-simd-threaded.wasm" };

registerGateWorker(self as unknown as Parameters<typeof registerGateWorker>[0]);
