/**
 * Semi-implicit (symplectic) Euler node integrator.
 * HOT LOOP: only + - * /, no allocation, ascending node order.
 * R-CORE: mirrored bit-identically by `integrate` in src/sim/wasm/kernel.c.
 */
import type { IntegrateNodes } from './types';

export const integrateNodes: IntegrateNodes = (state, first, count, dt, gx, gy, gz) => {
  const posX = state.posX;
  const posY = state.posY;
  const posZ = state.posZ;
  const velX = state.velX;
  const velY = state.velY;
  const velZ = state.velZ;
  const frcX = state.frcX;
  const frcY = state.frcY;
  const frcZ = state.frcZ;
  const invMass = state.invMass;
  const end = first + count;
  for (let i = first; i < end; i++) {
    const im = invMass[i]!;
    if (im === 0) {
      // Pinned: forces discarded, never moves.
      velX[i] = 0;
      velY[i] = 0;
      velZ[i] = 0;
    } else {
      const vx = velX[i]! + (frcX[i]! * im + gx) * dt;
      const vy = velY[i]! + (frcY[i]! * im + gy) * dt;
      const vz = velZ[i]! + (frcZ[i]! * im + gz) * dt;
      velX[i] = vx;
      velY[i] = vy;
      velZ[i] = vz;
      posX[i] = posX[i]! + vx * dt;
      posY[i] = posY[i]! + vy * dt;
      posZ[i] = posZ[i]! + vz * dt;
    }
    frcX[i] = 0;
    frcY[i] = 0;
    frcZ[i] = 0;
  }
};
