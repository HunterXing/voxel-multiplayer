// Voxel storage layout. y-major so that horizontal slices are contiguous,
// which keeps the mesher and the heightmap helpers cache friendly.
//
//   idx = (y * WORLD_Z + z) * WORLD_X + x
//
// Pure integer math, no allocation: used by the server, the client and tests.

import { WORLD_X, WORLD_Y, WORLD_Z, CHUNK_SIZE, CHUNKS_X } from './constants.js'

export const VOXEL_COUNT = WORLD_X * WORLD_Y * WORLD_Z

export function indexOf(x, y, z) {
  return (y * WORLD_Z + z) * WORLD_X + x
}

export function inBounds(x, y, z) {
  return x >= 0 && x < WORLD_X && y >= 0 && y < WORLD_Y && z >= 0 && z < WORLD_Z
}

/** Chunk column index (world is only chunked in x/z; a column is full height). */
export function chunkIndexOf(x, z) {
  const cx = Math.floor(x / CHUNK_SIZE)
  const cz = Math.floor(z / CHUNK_SIZE)
  return cz * CHUNKS_X + cx
}

export function chunkCoords(ci) {
  return { cx: ci % CHUNKS_X, cz: Math.floor(ci / CHUNKS_X) }
}
