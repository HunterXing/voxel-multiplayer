// Voxel AABB collision, shared by the browser client and the node server.
//
// The client uses it to feel movement, the server uses it to keep mobs from
// walking through walls. One implementation means a mob can never end up
// somewhere the client considers solid.

/** Does the AABB whose feet are at `pos` overlap any solid voxel? */
export function collides(world, pos, halfW, height) {
  const minX = Math.floor(pos.x - halfW)
  const maxX = Math.floor(pos.x + halfW)
  const minY = Math.floor(pos.y)
  const maxY = Math.floor(pos.y + height)
  const minZ = Math.floor(pos.z - halfW)
  const maxZ = Math.floor(pos.z + halfW)
  // A non-finite or absurd coordinate would make these loops either skip or
  // never terminate (y++ stops advancing past 2^53), so bail out loudly.
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)
    || !Number.isFinite(minY) || !Number.isFinite(maxY)
    || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
    return false
  }
  if (maxY - minY > WORLD_SPAN || maxX - minX > WORLD_SPAN || maxZ - minZ > WORLD_SPAN) return false
  for (let y = minY; y <= maxY; y++) {
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (world.isSolid(x, y, z)) return true
      }
    }
  }
  return false
}

/** Anything wider/taller than this is a bug, not a real body. */
const WORLD_SPAN = 64

const EPS = 1e-3

/**
 * Move along one axis and resolve the collision by snapping to the grid.
 * Mutates `pos` in place.
 *
 * Large steps are split into sub-steps of at most half a block: checking only
 * the destination would let a long frame (or a lag spike) tunnel straight
 * through a wall.
 *
 * @returns {{hit:boolean, onGround:boolean}} onGround is only meaningful for
 *          the y axis and is true when a downward move was blocked.
 */
export function moveAxis(world, pos, axis, amount, halfW, height, velocity) {
  if (amount === 0) return { hit: false, onGround: false }

  const steps = Math.max(1, Math.ceil(Math.abs(amount) / MAX_SUBSTEP))
  const inc = amount / steps
  let hit = false
  let onGround = false

  for (let s = 0; s < steps; s++) {
    pos[axis] += inc
    if (!collides(world, pos, halfW, height)) continue

    if (axis === 'y') {
      if (inc > 0) pos.y = Math.floor(pos.y + height) - height - EPS
      else {
        pos.y = Math.floor(pos.y) + 1 + EPS
        onGround = true
      }
      if (velocity) velocity.y = 0
    } else if (inc > 0) {
      pos[axis] = Math.floor(pos[axis] + halfW) - halfW - EPS
      if (velocity) velocity[axis] = 0
    } else {
      pos[axis] = Math.floor(pos[axis] - halfW) + 1 + halfW + EPS
      if (velocity) velocity[axis] = 0
    }
    hit = true
    break
  }

  return { hit, onGround }
}

/** Biggest distance resolved in one pass; keeps us out of the wall. */
const MAX_SUBSTEP = 0.5

/**
 * Full gravity + move step, axis separated. Used by the client (with velocity
 * driven by input) and by the server (velocity driven by the mob AI).
 *
 * @returns {{onGround:boolean, hitX:boolean, hitZ:boolean}}
 */
export function stepMovement(world, pos, velocity, dt, halfW, height, gravity = 28) {
  velocity.y = Math.max(velocity.y - gravity * dt, -60)
  const wasOnGround = collides(world, pos, halfW, height)
  const resY = moveAxis(world, pos, 'y', velocity.y * dt, halfW, height, velocity)
  const resX = moveAxis(world, pos, 'x', velocity.x * dt, halfW, height, velocity)
  const resZ = moveAxis(world, pos, 'z', velocity.z * dt, halfW, height, velocity)
  return {
    onGround: resY.onGround || wasOnGround,
    hitX: resX.hit,
    hitZ: resZ.hit,
  }
}

/** Would an entity of this size fit at (x, y, z)? */
export function fits(world, x, y, z, halfW, height) {
  return !collides(world, { x, y, z }, halfW, height)
}

/** Highest solid block at a column, or -1. */
export function surfaceY(world, x, z, from = 40) {
  for (let y = from; y >= 0; y--) {
    if (world.isSolid(x, y, z)) return y
  }
  return -1
}

export { EPS }
