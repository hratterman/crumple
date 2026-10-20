import { it } from 'vitest';
import { buildCoupeVisual } from '../render/vehicle/defs/coupe';
it('cv', () => {
  for (const lod of [0, 1, 2] as const) { try { buildCoupeVisual({ lod } as never); console.log('OK', lod); } catch (e) { console.log('ERR', lod, (e as Error).message); } }
});
