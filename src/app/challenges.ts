/**
 * Challenge host (P8-C; docs/CONTRACTS.md "P8 contracts" → "Main seams"):
 * the lazily loaded challenge layer. Owns the select screen, the in-run HUD
 * and results, the course / ghost visuals, the set-up of a challenge in the
 * world (vehicle, spawn, props, opponents, traffic, assists) and the pure
 * runtime, fed by SimClient's live-snapshot listener (120 Hz, independent of
 * the render loop). main.ts calls `filterInput`, `onCommand`, `frame` and
 * the menu hooks; everything else stays in here.
 */
import { Vector3, type PerspectiveCamera, type Scene } from 'three';

import { Bot, type BotConfig } from '../game/challenges/bot';
import { challengeCatalog } from '../game/challenges/catalog';
import { resolveGate } from '../game/challenges/eval/trackers';
import { decodeGhost, encodeGhost, encodeInputs, ghostDuration, sampleGhost } from '../game/challenges/ghost';
import { formatScore } from '../game/challenges/medals';
import { ChallengeRun } from '../game/challenges/runtime';
import { rigInfo, SampleBuilder } from '../game/challenges/sample';
import { challengeProps, OPPONENT_ID_BASE, spawnTransform } from '../game/challenges/setup';
import { loadStore, recordRun, saveStore } from '../game/challenges/storage';
import type { ChallengeDef, ChallengeEvent, ChallengeResult, ChallengeRunState, GhostTrack } from '../game/challenges/types';
import { getVehicleEntry, type VehicleChoice, type VehicleId } from '../game/catalog';
import type { InputCommand } from '../input/actions';
import type { ActionState, Transform } from '../protocol/messages';
import type { ReplayController } from './replay/types';
import { createCourseRenderer, type CourseRenderer } from '../render/challenges/gates';
import { createGhostCar, type GhostCar } from '../render/challenges/ghost';
import type { FxSystem } from '../render/fx/types';
import type { PropRenderer } from '../render/props/types';
import type { WorldFrame } from '../render/types';
import type { PropInstance } from '../sim/props/types';
import { ChallengeHud } from '../ui/challenges/hud';
import { ChallengeResults } from '../ui/challenges/results';
import { ChallengeSelect } from '../ui/challenges/select';
import { surfaceIndex } from '../world/surface';
import type { ResolvedCollider, TerrainData, TerrainSampler } from '../world/types';
import { loadPlayerAssets, PlayerVehicle, type PlayerVisualDeps } from './player';
import type { SimClient } from './simClient';

export interface ChallengeHostDeps {
  client: SimClient;
  scene: Scene;
  camera: PerspectiveCamera;
  sampler: TerrainSampler;
  terrain: TerrainData;
  colliders: readonly ResolvedCollider[];
  props: PropRenderer;
  fx: FxSystem;
  replay: ReplayController;
  /** The replay session (crash cam, watch replay), null before boot. */
  replayUi: () => { enterReplay(): Promise<boolean>; debug: { triggerCrashCam(): Promise<boolean> } } | null;
  visualDeps: PlayerVisualDeps | null;
  build: string;
  player: () => PlayerVehicle | null;
  /** Swap the player car (showroom path) at the current spot. */
  swapVehicle(choice: VehicleChoice): Promise<void>;
  /** Full repair + place the player at `t` (camera snap, crash-cam quiet). */
  placePlayer(t: Transform): void;
  /** Traffic agents while a challenge runs (null = the player's setting). */
  setTrafficAgents(agents: number | null): void;
  /** Traction control forced for the run (null = back to the player's setting). */
  setTractionControl(on: boolean | null): void;
  toast(title: string, sub: string): void;
  /** The select screen was opened / closed (main pauses the world while it is open). */
  onSelectOpen(open: boolean): void;
}

/** `window.__crumple.challenges`. */
export interface ChallengeDebugApi {
  list(): { id: string; name: string; best: number | null; medal: string }[];
  start(id: string): Promise<void>;
  restart(): void;
  quit(): void;
  openSelect(): void;
  readonly phase: string;
  readonly state: Readonly<ChallengeRunState> | null;
  readonly result: ChallengeResult | null;
  readonly id: string | null;
  /** Playtest bot (pure pursuit along the def's bot line); cfg overrides the defaults. */
  bot(on: boolean, cfg?: Partial<BotConfig>): void;
  /** Ghost of the current challenge's PB loaded (frames), 0 = none. */
  readonly ghostFrames: number;
  readonly resultsOpen: boolean;
  readonly selectOpen: boolean;
  /** Popups shown this run (tests). */
  readonly popups: string[];
}

export interface ChallengeHost {
  readonly active: boolean;
  readonly selectOpen: boolean;
  readonly resultsOpen: boolean;
  openSelect(focusId?: string): void;
  closeSelect(): void;
  /** Gamepad navigation of the select screen (main's menu loop). */
  selectFrame(dt: number): void;
  start(id: string): Promise<void>;
  restart(): void;
  quit(): void;
  /** Name of the running challenge (pause menu), or null. */
  readonly activeName: string | null;
  filterInput(a: ActionState): void;
  /** A driving command while a run is active: true = consumed. */
  onCommand(c: InputCommand): boolean;
  frame(dt: number, wf: WorldFrame): void;
  readonly debug: ChallengeDebugApi;
}

/** Playtest bot defaults per challenge (what the medal tuning ran with). */
const BOT_DEFAULTS: Readonly<Record<string, Partial<BotConfig>>> = {
  'long-jump': { speedKmh: 200, maxThrottle: 0.4, latAcc: 50 },
  'barrel-roll': { speedKmh: 75, latAcc: 50 },
  'wall-of-fame': { speedKmh: 130 },
  bowling: { speedKmh: 90 },
  'drift-king': { speedKmh: 140, latAcc: 8 },
  'truck-topple': { speedKmh: 70, latAcc: 3.5, lookahead: [6, 14] },
  'hill-climb': { speedKmh: 150, latAcc: 6 },
  'precision-park': { speedKmh: 15, stopAtEnd: true, latAcc: 3 },
  'stunt-jam': { speedKmh: 80, latAcc: 50 },
};

/** Countdown starts this long (sim s) after the set-up snapshot: the intro card reads first. */
const INTRO_S = 1.6;
/** Results open this long (real ms) after the finish / fail banner. */
const RESULTS_DELAY_MS = 1500;

interface Opponent {
  id: number;
  vehicle: PlayerVehicle | null;
  transform: Transform;
  aggression: number;
}

export function createChallengeHost(deps: ChallengeHostDeps): ChallengeHost {
  const { client, sampler } = deps;
  const heightAt = (x: number, z: number): number => sampler.heightAt(x, z);
  const surf = surfaceIndex(deps.colliders, heightAt);
  const surfaceAt = (x: number, z: number): number => surf.at(x, z);
  const defs = (): readonly ChallengeDef[] => challengeCatalog(deps.terrain);
  let store = loadStore();

  // ---------------------------------------------------------------- state
  let def: ChallengeDef | null = null;
  let run: ChallengeRun | null = null;
  let builder: SampleBuilder | null = null;
  let phase: 'idle' | 'setup' | 'live' | 'over' = 'idle';
  let resetTick = -1;
  let introUntil = 0;
  let propIds: number[] = [];
  let propInstances: PropInstance[] = [];
  let opponents: Opponent[] = [];
  let opponentsArmed = false;
  let course: CourseRenderer | null = null;
  let ghost: GhostCar | null = null;
  let ghostTrack: GhostTrack | null = null;
  let playerTransform: Transform | null = null;
  let bot: Bot | null = null;
  let botCfg: Partial<BotConfig> | null = null;
  let resultTimer = 0;
  let lastResult: ChallengeResult | null = null;
  let crashCamDone = false;
  let reopenAfterReplay = false;
  let starting: Promise<void> | null = null;
  const popups: string[] = [];
  const time0 = performance.now();

  // ---------------------------------------------------------------- UI
  const hud = new ChallengeHud(document.body);
  const results = new ChallengeResults(document.body, {
    onRetry: () => restart(),
    onNext: () => {
      const list = defs();
      const i = def ? list.findIndex((d) => d.id === def!.id) : -1;
      const next = list[(i + 1) % list.length];
      if (next) void start(next.id);
    },
    onReplay: () => void watchReplay(),
    onList: () => {
      const id = def?.id;
      quit();
      openSelect(id);
    },
    onQuit: () => quit(),
  });
  const select = new ChallengeSelect(document.body, {
    defs,
    record: (id) => store.records[id] ?? null,
    vehicleName: (d) => (d.vehicle.kind === 'forced' ? getVehicleEntry(d.vehicle.id).stats.name : 'Your car'),
    onStart: (id) => {
      closeSelect();
      void start(id);
    },
    onBack: () => {
      closeSelect();
    },
  });

  function openSelect(focusId?: string): void {
    store = loadStore();
    select.open(focusId);
    deps.onSelectOpen(true);
  }
  function closeSelect(): void {
    if (!select.isOpen) return;
    select.close();
    deps.onSelectOpen(false);
  }

  // ---------------------------------------------------------------- snapshot listener
  client.addSnapshotListener((r) => {
    if (!run || !builder || phase === 'idle') return;
    const s = builder.build(r);
    if (!s.valid) return;
    if (phase === 'setup') {
      if (s.tick < resetTick + 200) return;
      if (introUntil === 0) introUntil = s.simTime + INTRO_S;
      if (s.simTime < introUntil) return;
      builder.calibrate();
      builder.build(r); // re-read with the calibrated crush baseline
      run.startCountdown(s.simTime);
      phase = 'live';
    }
    run.onSample(s);
    if (run.running && !opponentsArmed) {
      opponentsArmed = true;
      for (const o of opponents) client.setAutopilot(o.id, { mode: 'ram', targetObjectId: 1, aggression: o.aggression, seed: o.id });
    }
  });

  // ---------------------------------------------------------------- set-up
  async function ensureVehicle(d: ChallengeDef): Promise<void> {
    const p = deps.player();
    if (d.vehicle.kind === 'forced') {
      const want = d.vehicle.id;
      if (!p || p.id !== want || (d.vehicle.palette && p.palette.id !== d.vehicle.palette)) {
        await deps.swapVehicle({ id: want, palette: d.vehicle.palette ?? '' });
      }
    } else if (p && d.vehicle.allowed && !d.vehicle.allowed.includes(p.id as VehicleId)) {
      await deps.swapVehicle({ id: d.vehicle.allowed[0]!, palette: '' });
    }
  }

  function teardownWorld(): void {
    for (const id of propIds) {
      client.despawn(id);
      deps.props.removeInstance(id);
      deps.fx.removeObject(id);
    }
    propIds = [];
    propInstances = [];
    for (const o of opponents) {
      client.setAutopilot(o.id, { mode: 'off' });
      client.despawn(o.id);
      deps.fx.removeObject(o.id);
      o.vehicle?.dispose();
    }
    opponents = [];
    if (def?.colliders?.length) client.setColliders([]);
    course?.dispose();
    course = null;
    ghost?.dispose();
    ghost = null;
    ghostTrack = null;
  }

  async function start(id: string): Promise<void> {
    if (starting) await starting;
    const d = defs().find((x) => x.id === id);
    if (!d) throw new Error(`unknown challenge '${id}'`);
    starting = (async () => {
      closeSelect();
      results.close();
      if (def) teardownWorld();
      hud.hide();
      def = d;
      run = null;
      phase = 'idle';
      await ensureVehicle(d);
      const p = deps.player();
      if (!p) throw new Error('no player vehicle');
      deps.setTrafficAgents(d.traffic ?? null);
      deps.setTractionControl(d.tractionControl ?? null);
      if (d.colliders?.length) client.setColliders(d.colliders.map((c) => ({ ...c })));
      // props
      const ps = challengeProps(d, heightAt);
      if (ps.spawns.length) {
        client.spawnProps(ps.spawns);
        deps.props.addInstances(ps.instances);
        deps.fx.addProps(ps.instances);
      }
      propIds = ps.spawns.map((x) => x.objectId);
      propInstances = ps.instances;
      // opponents
      const opp: Opponent[] = [];
      for (let k = 0; k < (d.opponents ?? []).length; k++) {
        const od = d.opponents![k]!;
        const entry = getVehicleEntry(od.vehicle);
        const assets = await loadPlayerAssets(entry);
        const t = spawnTransform(od.spawn, assets.rest, heightAt);
        const pid = od.palette ?? entry.palettes[(k + 1) % entry.palettes.length]!.id;
        const v = deps.visualDeps ? new PlayerVehicle(assets, pid, deps.visualDeps) : null;
        if (v?.object) deps.scene.add(v.object);
        const id2 = OPPONENT_ID_BASE + k;
        client.spawnVehicle(id2, assets.sim, t, 'auto', od.vehicle);
        deps.fx.addVehicle(id2, assets.compiled);
        opp.push({ id: id2, vehicle: v, transform: t, aggression: od.aggression ?? 0.7 });
      }
      opponents = opp;
      // course
      const gates = d.objectives.find((o) => o.type === 'gates');
      if (gates && gates.type === 'gates') {
        course = createCourseRenderer(gates.gates.map((g) => resolveGate(g, heightAt)));
        deps.scene.add(course.object);
      }
      // ghost of the PB
      const rec = store.records[d.id];
      ghostTrack = rec?.ghost ? decodeGhost(rec.ghost) : null;
      const vis = p.visual;
      if (ghostTrack && vis) {
        try {
          ghost = createGhostCar(p.assets.compiled, vis.lodBindings[0] ?? vis.binding);
          ghost.setVisible(false);
          deps.scene.add(ghost.object);
        } catch (e) {
          console.warn('[challenges] ghost bake failed', e);
          ghost = null;
        }
      }
      playerTransform = spawnTransform(d.spawn, p.assets.rest, heightAt);
      builder = new SampleBuilder({
        playerId: 1,
        player: rigInfo(p.assets.compiled),
        surfaceAt,
        pins: ps.pins,
        opponents: await Promise.all(opp.map(async (o, k) => ({ id: o.id, rig: rigInfo((await loadPlayerAssets(getVehicleEntry(d.opponents![k]!.vehicle))).compiled) }))),
      });
      bot = botCfg ? new Bot({ line: d.botLine ?? [], speedKmh: 60, ...BOT_DEFAULTS[d.id], ...botCfg }) : null;
      beginRun();
      deps.toast(d.name.toUpperCase(), d.where.toUpperCase());
    })();
    try {
      await starting;
    } finally {
      starting = null;
    }
  }

  /** (Re)starts the run on the applied set-up: place everything, new runtime, countdown after the intro. */
  function beginRun(): void {
    const d = def;
    const p = deps.player();
    if (!d || !p || !playerTransform) return;
    window.clearTimeout(resultTimer);
    results.close();
    deps.placePlayer(playerTransform);
    if (propIds.length) client.resetProps(propIds);
    for (const o of opponents) {
      client.setAutopilot(o.id, { mode: 'off' });
      client.reset(o.id, o.transform);
    }
    opponentsArmed = false;
    resetTick = client.latestTick;
    introUntil = 0;
    crashCamDone = false;
    popups.length = 0;
    run = new ChallengeRun(d, { groundAt: heightAt, vehicle: p.id, palette: p.palette.id });
    builder?.reset();
    if (bot) bot = new Bot({ ...bot.cfg });
    course?.setNext(0);
    const rec = store.records[d.id];
    hud.show(d, rec ? formatScore(rec.best, d.scoring) : null, d.vehicle.kind === 'forced' ? getVehicleEntry(d.vehicle.id).stats.name : p.assets.entry.stats.name);
    phase = 'setup';
  }

  function restart(): void {
    if (!def) return;
    if (deps.replay.active) void deps.replay.exit();
    beginRun();
  }

  function quit(): void {
    window.clearTimeout(resultTimer);
    reopenAfterReplay = false;
    results.close();
    hud.hide();
    if (def) teardownWorld();
    def = null;
    run = null;
    builder = null;
    phase = 'idle';
    deps.setTrafficAgents(null);
    deps.setTractionControl(null);
  }

  // ---------------------------------------------------------------- results
  function onFinish(r: ChallengeResult): void {
    const d = def!;
    lastResult = r;
    const ghostStr = r.completed && run ? encodeGhost(run.ghostTrack()) : undefined;
    const { previousBest, isBest } = recordRun(store, {
      id: d.id,
      score: r.score,
      medal: r.medal,
      completed: r.completed,
      better: d.scoring.better,
      vehicle: r.vehicle,
      build: deps.build,
      at: new Date().toISOString(),
      ...(ghostStr ? { ghost: ghostStr } : {}),
    });
    r.previousBest = previousBest;
    r.isBest = isBest;
    saveStore(store, undefined, d.id);
    if (isBest && r.completed) {
      // the PB's input slice from the worker's replay log (validation / export)
      const id = d.id;
      void client
        .requestReplayFile()
        .then((f) => {
          const s = encodeInputs(f.inputs, 1, r.goTick, r.endTick);
          const rec = store.records[id];
          if (s && rec && rec.best === r.score) {
            rec.inputs = s;
            saveStore(store, undefined, id);
          }
        })
        .catch(() => {});
    }
    if (r.completed) hud.finish(r.scoreText);
    else hud.fail(r.failReason ?? 'Failed');
    resultTimer = window.setTimeout(() => showResults(), RESULTS_DELAY_MS);
  }

  function showResults(): void {
    if (!def || !lastResult || deps.replay.active) {
      reopenAfterReplay = !!def;
      return;
    }
    hud.clearBanner();
    const list = defs();
    results.open(def, lastResult, list.length > 1, deps.replay.duration > 1);
  }

  async function watchReplay(): Promise<void> {
    const ui = deps.replayUi();
    if (!ui || !lastResult) return;
    results.close();
    reopenAfterReplay = true;
    if (!(await ui.enterReplay())) {
      reopenAfterReplay = false;
      showResults();
      return;
    }
    const t = Math.max(deps.replay.start, lastResult.goSimTime - 1);
    deps.replay.seek(t);
    deps.replay.play();
  }

  deps.replay.on((e) => {
    if (e.type === 'exit' && reopenAfterReplay && def && lastResult && phase === 'over') {
      reopenAfterReplay = false;
      window.setTimeout(() => showResults(), 300);
    }
  });

  // ---------------------------------------------------------------- per frame
  const camDir = new Vector3();
  const gp = [0, 0, 0];
  const gq = [0, 0, 0, 1];
  function handleEvents(evs: readonly ChallengeEvent[]): void {
    for (const e of evs) {
      switch (e.type) {
        case 'countdown':
          hud.countdown(e.n);
          break;
        case 'popup':
          hud.popup(e.kind, e.text, e.sub);
          popups.push(e.text);
          if (def?.id === 'wall-of-fame' && e.text === 'IMPACT' && !crashCamDone) {
            crashCamDone = true;
            // the crash cam replays the hit (if the player's setting did not already)
            window.setTimeout(() => {
              const ui = deps.replayUi();
              if (ui && deps.replay.phase === 'live' && run && !run.over) void ui.debug.triggerCrashCam();
            }, 900);
          }
          break;
        case 'gate':
          hud.gate(e.index, e.count, e.split, e.delta);
          break;
        case 'finish':
          phase = 'over';
          onFinish(e.result);
          break;
        default:
          break;
      }
    }
  }

  function frame(dt: number, wf: WorldFrame): void {
    for (const o of opponents) {
      let range: { nodeOffset: number; nodeCount: number } | null = null;
      for (const r of wf.objects) if (r.objectId === o.id) range = r;
      o.vehicle?.update(client, o.id, range, wf.nodes, dt, deps.camera);
    }
    if (!run || !def) return;
    handleEvents(run.drainEvents());
    if (!run) return;
    const st = run.state;
    // smooth run clock: the render time (interpolated, a snapshot behind) while running, the frozen clock after
    const clock = st.phase === 'running' && run.goTick >= 0 ? Math.min(st.clock + 0.05, Math.max(0, wf.simTime - run.goSimTime)) : st.clock;
    course?.setNext(st.nextGate);
    course?.update((performance.now() - time0) / 1000);
    // ghost
    if (ghost && ghostTrack) {
      const show = st.phase === 'running' || (st.phase === 'countdown' && true);
      const t = st.phase === 'running' ? clock : 0;
      ghost.setVisible(show && t <= ghostDuration(ghostTrack) + 0.5);
      if (show && sampleGhost(ghostTrack, t, gp, gq)) {
        ghost.setPose(gp, gq);
        // fade out when the camera sits inside it
        const d = Math.hypot(deps.camera.position.x - gp[0]!, deps.camera.position.z - gp[2]!);
        ghost.setOpacity(Math.min(1, Math.max(0.15, (d - 2) / 6)));
      }
      ghost.update((performance.now() - time0) / 1000);
    }
    // direction arrow to the next gate
    let arrow: number | null = null;
    const gates = def.objectives.find((o) => o.type === 'gates');
    if (gates && gates.type === 'gates' && st.nextGate >= 0) {
      const g = gates.gates[st.nextGate]!;
      deps.camera.getWorldDirection(camDir);
      const fl = Math.hypot(camDir.x, camDir.z) || 1;
      const fx = camDir.x / fl;
      const fz = camDir.z / fl;
      const p = deps.player();
      const pos = builder?.sample.valid ? builder.sample.pos : null;
      if (p && pos) {
        const dx = g.pos[0] - pos[0];
        const dz = g.pos[2] - pos[2];
        arrow = Math.atan2(dx * -fz + dz * fx, dx * fx + dz * fz);
      }
    }
    hud.update(st, clock, arrow);
  }

  // ---------------------------------------------------------------- input
  function filterInput(a: ActionState): void {
    if (!run || phase === 'idle') return;
    const st = run.state.phase;
    if (phase === 'setup' || st === 'countdown') {
      a.throttle = 0;
      a.brake = 1;
      a.handbrake = 1;
      a.gearSelect = 1;
      return;
    }
    if (phase === 'over' || st === 'finished' || st === 'failed') {
      a.throttle = 0;
      a.brake = Math.max(a.brake, 0.6);
      return;
    }
    if (bot && builder?.sample.valid) {
      const b = bot.update(builder.sample);
      a.throttle = b.throttle;
      a.brake = b.brake;
      a.steer = b.steer;
      a.handbrake = b.handbrake;
      a.gearSelect = 1;
    }
  }

  function onCommand(c: InputCommand): boolean {
    if (!def || phase === 'idle') return false;
    if (c === 'repair' || c === 'recover') {
      restart();
      return true;
    }
    return false;
  }

  const debug: ChallengeDebugApi = {
    list: () => defs().map((d) => ({ id: d.id, name: d.name, best: store.records[d.id]?.best ?? null, medal: store.records[d.id]?.bestMedal ?? 'none' })),
    start: (id) => start(id),
    restart: () => restart(),
    quit: () => quit(),
    openSelect: () => openSelect(),
    get phase() {
      return phase;
    },
    get state() {
      return run ? run.state : null;
    },
    get result() {
      return lastResult;
    },
    get id() {
      return def ? def.id : null;
    },
    bot(on, cfg) {
      botCfg = on ? { ...(cfg ?? {}) } : null;
      bot = on && def ? new Bot({ line: def.botLine ?? [], speedKmh: 60, ...BOT_DEFAULTS[def.id], ...botCfg }) : null;
    },
    get ghostFrames() {
      return ghostTrack ? ghostTrack.count : 0;
    },
    get resultsOpen() {
      return results.isOpen;
    },
    get selectOpen() {
      return select.isOpen;
    },
    get popups() {
      return popups.slice();
    },
  };

  return {
    get active() {
      return def !== null;
    },
    get selectOpen() {
      return select.isOpen;
    },
    get resultsOpen() {
      return results.isOpen;
    },
    get activeName() {
      return def ? def.name : null;
    },
    openSelect,
    closeSelect,
    selectFrame: (dt) => select.frame(dt),
    start,
    restart,
    quit,
    filterInput,
    onCommand,
    frame,
    debug,
  };
}
