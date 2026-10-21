/**
 * Sun, moon and star-field positions for a time of day (pure, no three).
 *
 * World frame: Y up, north = −Z, east = +X (WorldLayout convention). Times
 * are LOCAL SOLAR hours (12 = the sun on the meridian). One fixed date and
 * latitude for the valley: latitude 42° N, solar declination +18° (late
 * spring), so sunrise ≈ 04:52, sunset ≈ 19:08, noon elevation 66°.
 *
 * Positions use the textbook equatorial → horizontal rotation: a body at
 * hour angle H and declination δ sits at
 *   −cosδ·sinH·E + cosδ·cosH·M + sinδ·P
 * with E = east, M = the celestial equator on the meridian (south and up),
 * P = the celestial pole (north and up).
 */

export const ASTRO_LATITUDE_DEG = 42;
export const ASTRO_SUN_DECLINATION_DEG = 18;
/** Moon age in days (0 new, 14.77 full): a waxing gibbous moon high in the evening sky. */
export const ASTRO_MOON_AGE_DAYS = 10.5;
export const ASTRO_MOON_DECLINATION_DEG = 4;
const SYNODIC_DAYS = 29.53;
const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

/** Unit vector (world) for hour angle `ha` (rad, + = west of the meridian) and declination `dec` (rad). */
export function equatorialToWorld(ha: number, dec: number, latitudeDeg = ASTRO_LATITUDE_DEG, out: Vec3 = [0, 0, 0]): Vec3 {
  const phi = latitudeDeg * DEG;
  const cd = Math.cos(dec);
  const sd = Math.sin(dec);
  const east = -cd * Math.sin(ha);
  const m = cd * Math.cos(ha);
  // M = (0, cosφ, −sinφ) and P = (0, sinφ, cosφ) in (east, up, north)
  const up = m * Math.cos(phi) + sd * Math.sin(phi);
  const north = -m * Math.sin(phi) + sd * Math.cos(phi);
  out[0] = east;
  out[1] = up;
  out[2] = -north;
  return out;
}

/** Wraps any hour value into [0, 24). */
export function wrapHours(h: number): number {
  const r = h % 24;
  return r < 0 ? r + 24 : r;
}

/** Direction toward the sun at local solar time `hours`. */
export function sunDirectionAt(hours: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const ha = ((wrapHours(hours) - 12) / 24) * 2 * Math.PI;
  return equatorialToWorld(ha, ASTRO_SUN_DECLINATION_DEG * DEG, ASTRO_LATITUDE_DEG, out);
}

/** Moon elongation east of the sun, rad. */
export function moonElongation(ageDays = ASTRO_MOON_AGE_DAYS): number {
  return (ageDays / SYNODIC_DAYS) * 2 * Math.PI;
}

/** Direction toward the moon (it trails the sun by its elongation in hour angle). */
export function moonDirectionAt(hours: number, out: Vec3 = [0, 0, 0], ageDays = ASTRO_MOON_AGE_DAYS): Vec3 {
  const ha = ((wrapHours(hours) - 12) / 24) * 2 * Math.PI - moonElongation(ageDays);
  return equatorialToWorld(ha, ASTRO_MOON_DECLINATION_DEG * DEG, ASTRO_LATITUDE_DEG, out);
}

/** Illuminated fraction of the moon's disc, 0..1. */
export function moonIllumination(ageDays = ASTRO_MOON_AGE_DAYS): number {
  return 0.5 * (1 - Math.cos(moonElongation(ageDays)));
}

/** Elevation of a unit direction, deg. */
export function elevationDeg(d: readonly number[]): number {
  return Math.asin(Math.max(-1, Math.min(1, d[1]!))) / DEG;
}

/**
 * Column-major mat3 (three's Matrix3.elements order) taking a star's
 * equatorial unit vector (x toward hour angle 0 at sidereal angle 0, z toward
 * the pole) to world space at `hours`. The sky turns once per 24 h with the sun
 * (the sidereal offset of a single date is irrelevant here).
 */
export function starRotation(hours: number, out: number[] = new Array(9).fill(0)): number[] {
  const theta = ((wrapHours(hours) - 12) / 24) * 2 * Math.PI;
  // basis of the equatorial frame in world space: the image of the equator point at H = θ,
  // the point 90° east of it (H = θ − π/2), and the pole
  const a = equatorialToWorld(theta, 0);
  const b = equatorialToWorld(theta - Math.PI / 2, 0);
  const p = equatorialToWorld(0, Math.PI / 2);
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
  out[3] = b[0];
  out[4] = b[1];
  out[5] = b[2];
  out[6] = p[0];
  out[7] = p[1];
  out[8] = p[2];
  return out;
}

/** Local solar hour at which the sun reaches `elevationDeg` (rising: morning branch). Null if never. */
export function hourForSunElevation(elevationDegTarget: number, rising: boolean): number | null {
  const phi = ASTRO_LATITUDE_DEG * DEG;
  const dec = ASTRO_SUN_DECLINATION_DEG * DEG;
  const c = (Math.sin(elevationDegTarget * DEG) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (c < -1 || c > 1) return null;
  const ha = Math.acos(c);
  const h = (ha / (2 * Math.PI)) * 24;
  return rising ? 12 - h : 12 + h;
}
