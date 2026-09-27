// The single source of truth for the world.
//
// Node is single threaded and `applyEdit` never awaits, so the
// read -> compare -> write sequence below is atomic with respect to every other
// message handler. That is the whole concurrency story: no locks, no queues.

import { WORLD_X, WORLD_Y, WORLD_Z, DEFAULT_SEED } from '../shared/constants.js'
import { B, BLOCKS } from '../shared/blocks.js'
import { indexOf, inBounds } from '../shared/voxel.js'
import { generateInto, spawnPoint } from '../shared/worldgen.js'
import { ERR } from '../shared/protocol.js'

export { indexOf, inBounds }

export class AuthoritativeWorld {
  constructor({ seed = DEFAULT_SEED } = {}) {
    this.seed = seed >>> 0
    this.blocks = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z)
    generateInto(this.seed, this.blocks)

    // idx -> {x, y, z, type}. A Map (not a log) so repeat edits on the same
    // cell collapse instead of growing without bound.
    this.edits = new Map()
    this.version = 0
  }

  get(x, y, z) {
    if (!inBounds(x, y, z)) return B.AIR
    return this.blocks[indexOf(x, y, z)]
  }

  isSolid(x, y, z) {
    const def = BLOCKS[this.get(x, y, z)]
    return def.solid === true
  }

  spawn() {
    return spawnPoint()
  }

  /** @returns {[x, y, z, type][]} compact overlay, safe to send over the wire. */
  editList() {
    const out = new Array(this.edits.size)
    let i = 0
    for (const e of this.edits.values()) {
      out[i++] = [e.x, e.y, e.z, e.type]
    }
    return out
  }

  /** Re-applies a persisted overlay. Out-of-range / stale entries are dropped. */
  applyOverlay(list) {
    let applied = 0
    for (const e of Array.isArray(list) ? list : []) {
      if (!Array.isArray(e) || e.length < 4) continue
      const [x, y, z, type] = e
      if (!inBounds(x, y, z)) continue
      if (!Number.isInteger(type) || type < 0 || type >= BLOCKS.length) continue
      this.set(x, y, z, type)
      applied++
    }
    return applied
  }

  /** Direct write, no CAS. Used for overlays, never for player requests. */
  set(x, y, z, type) {
    if (!inBounds(x, y, z)) return false
    const i = indexOf(x, y, z)
    this.blocks[i] = type
    this.edits.set(i, { x, y, z, type })
    this.version++
    return true
  }

  /**
   * Authoritative, conflict-safe block edit.
   *
   * Order matters and must not be reordered:
   *   1. bounds   2. block legality   3. compare-and-swap   4. commit
   *
   * @param {{x:number,y:number,z:number,block:number,expected:number}} edit
   * @returns {{ok:true,block:number,version:number}
   *          |{ok:false,code:string,actual?:number}}
   */
  applyEdit({ x, y, z, block, expected }) {
    if (!inBounds(x, y, z)) return { ok: false, code: ERR.OUT_OF_BOUNDS }

    // AIR (removal) is always allowed; anything else must be a placeable id.
    if (block !== B.AIR && !BLOCKS[block]?.placeable) return { ok: false, code: ERR.BAD_BLOCK }
    if (block === B.AIR && this.get(x, y, z) === B.BEDROCK) return { ok: false, code: ERR.BAD_BLOCK }

    const i = indexOf(x, y, z)
    const actual = this.blocks[i]

    // --- the CAS ------------------------------------------------------------
    if (actual !== expected) return { ok: false, code: ERR.CONFLICT, actual }
    // -----------------------------------------------------------------------

    this.blocks[i] = block
    this.edits.set(i, { x, y, z, type: block })
    this.version++
    return { ok: true, block, version: this.version }
  }
}
