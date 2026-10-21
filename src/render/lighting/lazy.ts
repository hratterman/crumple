/**
 * The lazily loaded half of the lighting (sky + atmosphere, clouds, CSM
 * stack, night lights, rain): one chunk off the app bundle. main imports
 * this module dynamically at boot and only types statically.
 */
export { createLightingStack, setNearCasters } from '../lighting';
export { createNightLights } from './nightLights';
export { lampMountsFor } from './headlights';
export { createRain } from '../fx/rain';
