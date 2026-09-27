// Periodic JSON snapshot of the *edit overlay* (never the full voxel array).
//
// Trade-off, documented in README: a crash loses up to SAVE_INTERVAL_MS of
// edits. The win is that a save is a few hundred bytes instead of 196 KB.

import fs from 'node:fs'
import path from 'node:path'
import { SNAPSHOT_VERSION, SAVE_INTERVAL_MS } from '../shared/constants.js'

const FILE = 'world.json'
const TMP = 'world.json.tmp'

export class Persistence {
  constructor({ world, dataDir, intervalMs = SAVE_INTERVAL_MS, log = console.log }) {
    this.world = world
    this.dataDir = dataDir
    this.file = path.join(dataDir, FILE)
    this.tmp = path.join(dataDir, TMP)
    this.intervalMs = intervalMs
    this.log = log
    this.timer = null
    this.saves = 0
  }

  /** @returns {{loaded:number, error?:string}} */
  load() {
    if (!fs.existsSync(this.file)) return { loaded: 0 }
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch (err) {
      this.log(`[persist] world.json is unreadable (${err.message}); regenerating from seed ${this.world.seed}`)
      return { loaded: 0, error: 'unreadable' }
    }
    if (parsed?.version !== SNAPSHOT_VERSION || !Array.isArray(parsed.edits)) {
      this.log('[persist] world.json has an unknown shape; regenerating from seed')
      return { loaded: 0, error: 'shape' }
    }
    const loaded = this.world.applyOverlay(parsed.edits)
    if (typeof parsed.seed === 'number' && parsed.seed >>> 0 !== this.world.seed) {
      this.log(`[persist] snapshot seed ${parsed.seed} != runtime seed ${this.world.seed}; edits re-applied on the new terrain`)
    }
    this.log(`[persist] restored ${loaded} block edit(s) from ${this.file}`)
    return { loaded }
  }

  /** Atomic: write a sibling temp file, then rename over the real one. */
  saveNow() {
    const payload = {
      version: SNAPSHOT_VERSION,
      seed: this.world.seed,
      savedAt: Date.now(),
      edits: this.world.editList(),
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.writeFileSync(this.tmp, JSON.stringify(payload))
      fs.renameSync(this.tmp, this.file)
      this.saves++
      return true
    } catch (err) {
      this.log(`[persist] save failed: ${err.message}`)
      return false
    }
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.saveNow(), this.intervalMs)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    return this.saveNow()
  }
}
