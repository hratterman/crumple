/**
 * Parking-brake hold after a spawn / teleport / repair (pure; no DOM).
 *
 * Armed when main places the player car; while armed every input frame goes
 * out with the handbrake fully on, so a car set down on a slope (Hollow Creek
 * trailhead ≈ 10°) stays put instead of rolling away (+ SPAWN_HOLD_BRAKE). The first throttle,
 * brake (auto mode: also arcade reverse), steer, handbrake or gear change from
 * the player releases it. It only rewrites the actions main sends, so the
 * hold travels through the normal `input` command log and replay /
 * resimulate reproduce it exactly.
 */
import type { ActionState } from '../protocol/messages';

/** Pedal / steer magnitude that counts as player input. */
export const SPAWN_HOLD_INPUT_EPS = 0.02;
/**
 * Service brake applied with the handbrake while holding: the handbrake acts
 * on the rear axle only, which leaves the 7.5 t box truck creeping ≈ 1 cm/s
 * down the 10° trailhead; the foot brake on every wheel stops it.
 */
export const SPAWN_HOLD_BRAKE = 0.5;

export class SpawnHold {
  private armed = false;
  /** gearSelect the player had when the hold started (NaN = take the next frame's). */
  private gear = NaN;
  private readonly out: ActionState = { throttle: 0, brake: 0, steer: 0, handbrake: 0, clutch: 0, gearSelect: 1, horn: 0 };

  get active(): boolean {
    return this.armed;
  }

  arm(): void {
    this.armed = true;
    this.gear = NaN;
  }

  release(): void {
    this.armed = false;
  }

  /**
   * The actions to send for the player's `input` this frame: `input` itself
   * once released (or on the frame that releases), else a copy with the
   * handbrake at 1 and the brake at SPAWN_HOLD_BRAKE. `input` is never modified.
   */
  apply(input: ActionState): ActionState {
    if (!this.armed) return input;
    if (this.gear !== this.gear) this.gear = input.gearSelect;
    const e = SPAWN_HOLD_INPUT_EPS;
    if (input.throttle > e || input.brake > e || input.steer > e || input.steer < -e || input.handbrake > e || input.gearSelect !== this.gear) {
      this.armed = false;
      return input;
    }
    Object.assign(this.out, input);
    this.out.handbrake = 1;
    this.out.brake = SPAWN_HOLD_BRAKE;
    return this.out;
  }
}
