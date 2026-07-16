# CRUMPLE

A BeamNG-style soft-body physics driving sandbox for the browser. Vehicles are real node-and-beam spring networks simulated at 2000 Hz in a web worker — they flex, crumple plastically, and tear apart. Bespoke physics engine, procedural vehicle bodies with GPU flexbody skinning, a multi-zone island map, AI traffic, deterministic replays, and stunt challenges. Built on three.js + TypeScript + Vite, deployed to GitHub Pages.

## Development

```sh
npm install
npm run dev        # dev server
npm run build      # typecheck + production build
npm run typecheck  # tsc --noEmit
npm run test       # vitest unit tests
npm run e2e        # playwright e2e tests
npm run bench      # beam-kernel microbenchmark
```

Work in progress — currently a placeholder scene while the physics core lands.
