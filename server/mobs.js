// Server-authoritative mobs.
//
// They are simulated here, in the same tick loop that broadcasts snapshots,
// using the same shared/collision.js the client uses. A mob therefore can never
// end up somewhere the client thinks is solid, and every client sees the same
// animal in the same place.

import {
  MOB_BY_ID, MOB_POPULATION, MOB_COUNT, KNOCKBACK, KNOCKBACK_Y,
} from '../shared/mobs.js'
import { stepMovement, surfaceY, fits } from '../shared/collision.js'
import { WORLD_X, WORLD_Y, WORLD_Z, WATER_LEVEL } from '../shared/constants.js'

const GRAVITY = 28

export class MobRegistry {
  constructor({ world, log = console.log }) {
    this.world = world
    this.log = log
    this.mobs = new Map()
    this.nextId = 1
    this.pendingRespawns = []
    this.populate()
  }

  get count() {
    return this.mobs.size
  }

  all() {
    return [...this.mobs.values()]
  }

  get(id) {
    return this.mobs.get(id)
  }

  getByKey(key) {
    return [...this.mobs.values()].find((m) => MOB_BY_ID.get(m.kind).key === key)
  }

  /** @returns {{x:number,y:number,z:number}} plain position, safe to hand out */
  positionOf(mob) {
    return mob.pos
  }

  /** Drop the initial population somewhere sane: on land, not in each other. */
  populate() {
    for (const { kind, count } of MOB_POPULATION) {
      for (let i = 0; i < count; i++) this.spawn(kind)
    }
    this.log(`[mobs] spawned ${this.mobs.size}/${MOB_COUNT}`)
  }

  spawn(kind) {
    const def = MOB_BY_ID.get(kind)
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = 2 + Math.floor(Math.random() * (WORLD_X - 4))
      const z = 2 + Math.floor(Math.floor(Math.random() * (WORLD_Z - 4)))
      const y = surfaceY(this.world, x, z) + 1.02
      if (y < WATER_LEVEL + 1 || y > WORLD_Y - 3) continue
      if (!fits(this.world, x, y, z, def.halfW, def.height)) continue
      if ([...this.mobs.values()].some((m) => Math.hypot(m.pos.x - x, m.pos.z - z) < 3)) continue
      // pos and vel are separate objects on purpose: stepMovement writes one
      // and reads the other, and sharing a record makes a mob's height get
      // treated as its velocity and explode
      const mob = {
        id: this.nextId++,
        kind,
        pos: { x, y, z },
        vel: { x: 0, y: 0, z: 0 },
        yaw: Math.random() * Math.PI * 2,
        hp: def.hp,
        state: 'idle',
        timer: def.wanderIdle[0] + Math.random() * (def.wanderIdle[1] - def.wanderIdle[0]),
        dirX: 0,
        dirZ: 0,
        flashUntil: 0,
        deadUntil: 0,
        moving: false,
      }
      this.mobs.set(mob.id, mob)
      return mob
    }
    return null
  }

  /** @returns {object|null} the mob that was hit */
  damage(mob, amount, players, fromId, now) {
    if (!mob || now < mob.flashUntil - 1000) return null
    const def = MOB_BY_ID.get(mob.kind)
    mob.hp -= amount
    mob.flashUntil = now + 180
    if (mob.hp <= 0) {
      this.kill(mob, now)
      return mob
    }
    // flee from the attacker for a moment
    const away = this._awayFrom(mob, players, fromId)
    mob.state = 'flee'
    mob.dirX = away.x
    mob.dirZ = away.z
    mob.timer = 1.6 + Math.random() * 1.4
    return mob
  }

  _awayFrom(mob, players, fromId) {
    const attacker = players?.get(fromId)
    if (!attacker) return { x: Math.cos(mob.yaw), z: Math.sin(mob.yaw) }
    const dx = mob.pos.x - attacker.x
    const dz = mob.pos.z - attacker.z
    const len = Math.hypot(dx, dz) || 1
    return { x: dx / len, z: dz / len }
  }

  kill(mob, now) {
    const def = MOB_BY_ID.get(mob.kind)
    this.mobs.delete(mob.id)
    const [lo, hi] = def.respawnMs
    this.pendingRespawns.push({ kind: mob.kind, at: now + lo + Math.random() * (hi - lo) })
  }

  knockback(mob, dirX, dirZ) {
    mob.vel.x += dirX * KNOCKBACK
    mob.vel.z += dirZ * KNOCKBACK
    mob.vel.y = Math.max(mob.vel.y, KNOCKBACK_Y)
  }

  /**
   * One AI step. Called at TICK_HZ with a fixed dt so the result does not
   * depend on how often the loop happens to fire.
   */
  update(dt, players, now) {

    for (let i = this.pendingRespawns.length - 1; i >= 0; i--) {
      if (now >= this.pendingRespawns[i].at) {
        this.spawn(this.pendingRespawns[i].kind)
        this.pendingRespawns.splice(i, 1)
      }
    }

    for (const mob of this.mobs.values()) {
      const def = MOB_BY_ID.get(mob.kind)
      mob.timer -= dt

      if (mob.timer <= 0) {
        if (mob.state === 'flee') {
          mob.state = 'idle'
          mob.timer = def.wanderIdle[0] + Math.random() * (def.wanderIdle[1] - def.wanderIdle[0])
        } else {
          // pick a new heading, biased to stay on the surface
          mob.state = 'walk'
          const a = Math.random() * Math.PI * 2
          mob.dirX = Math.cos(a)
          mob.dirZ = Math.sin(a)
          mob.timer = def.wanderMove[0] + Math.random() * (def.wanderMove[1] - def.wanderMove[0])
        }
      }

      // sheep-like: do not walk off a big drop
      if (mob.state === 'walk' && this._cliffAhead(mob)) {
        mob.dirX = -mob.dirX
        mob.dirZ = -mob.dirZ
        mob.timer = Math.max(mob.timer, 0.4)
      }

      const speed = mob.state === 'flee' ? def.fleeSpeed : def.speed
      const walking = mob.state === 'walk' || mob.state === 'flee'
      const targetVx = walking ? mob.dirX * speed : 0
      const targetVz = walking ? mob.dirZ * speed : 0
      const k = Math.min(1, dt * 8)
      mob.vel.x += (targetVx - mob.vel.x) * k
      mob.vel.z += (targetVz - mob.vel.z) * k

      const before = { x: mob.pos.x, z: mob.pos.z }
      const res = stepMovement(this.world, mob.pos, mob.vel, dt, def.halfW, def.height, GRAVITY)

      // a wall in front means turn around, do not grind against it
      if ((res.hitX && Math.abs(mob.vel.x) < 0.01) || (res.hitZ && Math.abs(mob.vel.z) < 0.01)) {
        mob.dirX = -mob.dirX
        mob.dirZ = -mob.dirZ
        mob.timer = Math.max(mob.timer, 0.5)
      }

      const moved = Math.hypot(mob.pos.x - before.x, mob.pos.z - before.z)
      mob.moving = moved > 0.002
      if (mob.moving) {
        // face the direction of travel, smoothed
        const want = Math.atan2(mob.dirX, mob.dirZ)
        let d = want - mob.yaw
        while (d > Math.PI) d -= Math.PI * 2
        while (d < -Math.PI) d += Math.PI * 2
        mob.yaw += d * Math.min(1, dt * 8)
      }

      // fell out of the world
      if (mob.pos.y < -8) this.kill(mob, now)
    }
  }

  /** Is there a drop of more than `steps` blocks just ahead? */
  _cliffAhead(mob) {
    const aheadX = mob.pos.x + mob.dirX * 0.8
    const aheadZ = mob.pos.z + mob.dirZ * 0.8
    const here = surfaceY(this.world, Math.floor(mob.pos.x), Math.floor(mob.pos.z))
    const there = surfaceY(this.world, Math.floor(aheadX), Math.floor(aheadZ))
    if (there < 0) return true
    return here - there > 3
  }

  /** Mobs the receiver should know about, given their player position. */
  visibleFrom(px, pz, radius) {
    const r2 = radius * radius
    const out = []
    for (const m of this.mobs.values()) {
      const dx = m.pos.x - px
      const dz = m.pos.z - pz
      if (dx * dx + dz * dz > r2) continue
      out.push(m)
    }
    out.sort((a, b) => a.id - b.id)
    return out
  }

  /**
   * Resolve a swing against a mob. Player-vs-player damage is applied by the
   * caller in server/index.js, because only it knows how to push a
   * client-authoritative body around.
   *
   * @returns {{ok:true,mob:object,killed:boolean}|{ok:false,code:string}}
   */
  hitMob({ id, fromId, from, reach, damage, now, players }) {
    const mob = this.mobs.get(id)
    if (!mob) return { ok: false, code: 'bad_target' }
    if (mob.hp <= 0) return { ok: false, code: 'bad_target' }
    if (now < mob.flashUntil) return { ok: false, code: 'too_fast' }

    const dx = mob.pos.x - from.x
    const dy = mob.pos.y + 0.45 - from.y
    const dz = mob.pos.z - from.z
    if (Math.hypot(dx, dy, dz) > reach) return { ok: false, code: 'bad_target' }

    mob.hp -= damage
    mob.flashUntil = now + 180
    if (mob.hp <= 0) {
      this.kill(mob, now)
      return { ok: true, mob, killed: true }
    }

    const away = this._awayFrom(mob, players, fromId)
    mob.state = 'flee'
    mob.dirX = away.x
    mob.dirZ = away.z
    mob.timer = 1.6 + Math.random() * 1.4
    const len = Math.hypot(dx, dz) || 1
    this.knockback(mob, dx / len, dz / len)
    return { ok: true, mob, killed: false }
  }

  /** Mobs inside a box around a player, for "did my swing land" feedback. */
  inReach(from, reach) {
    const out = []
    for (const m of this.mobs.values()) {
      const dx = m.pos.x - from.x
      const dy = m.pos.y + 0.45 - from.y
      const dz = m.pos.z - from.z
      if (Math.hypot(dx, dy, dz) <= reach) out.push(m)
    }
    return out
  }
}

export { MOB_BY_ID, MOB_COUNT }
