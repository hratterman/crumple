/**
 * R-RIG tools: ONE module graph for tools/rig-*.mjs. Each vite `runnerImport` call builds its own module
 * instances, so a tool that imported engine.ts and crash.ts separately set the default solver / kernel on a
 * copy the harness never saw; the tools import this file once instead.
 */
export * as crash from '../src/sim/vehicle/crash';
export * as engine from '../src/sim/engine';
export * as messages from '../src/protocol/messages';
export * as builder from '../src/sim/vehicle/builder';
export * as handling from '../src/sim/vehicle/handling';
export * as kernel from '../src/sim/kernel';
export * as wasm from '../src/sim/wasm/kernel';
export * as hdSim from '../src/sim/vehicle/defs/hd/index';
export * as hdVis from '../src/render/vehicle/defs/hd/index';
export * as loft from '../src/render/vehicle/loft';
export * as binder from '../src/render/vehicle/binder';
export * as lods from '../src/render/vehicle/lods';
