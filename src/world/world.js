// Client-side mirror of the server world.
//
// The terrain is *not* downloaded: it is regenerated from the seed the server
// handed us, then the server's edit overlay is applied on top. So a join costs
// a few hundred bytes no matter how big the world is.

import { WORLD_X, WORLD_Y, WORLD_Z } from '../../shared/constants.js'
import { B, isSolid as isSolidId } from '../../shared/blocks.js'
import { indexOf, inBounds, chunkIndexOf, VOXEL_COUNT } from '../../shared/voxel.js'
import { generateInto } from '../../shared/worldgen.js'

export class ClientWorld {
  constructor() {
    this.blocks = new Uint8Array(VOXEL_COUNT)
    this.seed = 0
    this.version = 0
  }

  generate(seed) {
    this.seed = seed >>> 0
    this.blocks = new Uint8Array(VOXEL_COUNT)
    generateInto(this.seed, this.blocks)
    this.version++
    return this
  }

  get(x, y, z) {
    if (!inBounds(x, y, z)) return B.AIR
    return this.blocks[indexOf(x, y, z)]
  }

  set(x, y, z, type) {
    if (!inBounds(x, y, z)) return false
    this.blocks[indexOf(x, y, z)] = type
    this.version++
    return true
  }

  isSolid(x, y, z) {
    return isSolidId(this.get(x, y, z))
  }

  /** [[x, y, z, type]] from the server's init payload. */
  applyEdits(list) {
    let n = 0
    for (const e of Array.isArray(list) ? list : []) {
      if (!Array.isArray(e) || e.length < 4) continue
      if (this.set(e[0], e[1], e[2], e[3])) n++
    }
    return n
  }
}

export { indexOf, inBounds, chunkIndexOf }
