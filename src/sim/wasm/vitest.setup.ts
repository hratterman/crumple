/**
 * Vitest setup (both projects): installs the solver kernel new engines use.
 * CRUMPLE_KERNEL = simd (default) | wasm | js. The kernels are bit-identical
 * (kernelParity.test.ts), so every suite result is kernel-independent; the
 * default runs the suite on the kernel the worker ships.
 */
import { JS_KERNEL, setDefaultKernel } from '../kernel';
import { bestWasmKernel, wasmKernelOf } from './kernel';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const want = env.CRUMPLE_KERNEL ?? 'simd';
if (want === 'js') setDefaultKernel(JS_KERNEL);
else if (want === 'wasm' || want === 'simd') setDefaultKernel(wasmKernelOf(want) ?? bestWasmKernel() ?? JS_KERNEL);
else throw new Error(`CRUMPLE_KERNEL must be js | wasm | simd, got ${want}`);
