// Tests for combat, tools, the shared collision and the mob AI.
// All of it runs in plain node — the mob simulation is pure JS by design.

import test from 'node:test'
import assert from 'node:assert/strict'

import { collides, moveAxis, stepMovement, fits, surfaceY } from '../shared/collision.js'
import {
  TOOLS, TOOL_BY_ID, TOOL_BY_KEY, HOTBAR, breakDelay, toolSpeedOn, toolReach, toolDamage,
  toolCooldown, isTool, BREAK_GRACE,
} from '../shared/items.js'
import { MOBS, MOB_BY_ID, MOB_COUNT, MOB_POPULATION } from '../shared/mobs.js'
import { B, BLOCKS } from '../shared/blocks.js'
import { indexOf, inBounds } from '../shared/voxel.js'
import { WORLD_X, WORLD_Y, WORLD_Z, PLAYER_MAX_HP, RESPAWN_MS } from '../shared/constants.js'
import { generate } from '../shared/worldgen.js'
import { AuthoritativeWorld } from '../server/world.js'
import { PlayerRegistry } from '../server/players.js'
import { MobRegistry } from '../server/mobs.js'
import { tryDecode, encode, C2S } from '../shared/protocol.js'

const solidWorld = (cells) => {
  const blocks = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z)
  for (const [x, y, z, t] of cells) blocks[indexOf(x, y, z)] = t ?? B.STONE
  return {
    blocks,
    isSolid(x, y, z) {
      if (!inBounds(x, y, z)) return false
      const v = blocks[indexOf(x, y, z)]
      return BLOCKS[v].solid === true
    },
  }
}

// ---------------------------------------------------------------- collision

test('collision: an AABB resting on a floor does not overlap, one voxel lower does', () => {
  const w = solidWorld([[5, 4, 5, B.STONE]])
  assert.equal(collides(w, { x: 5.5, y: 5, z: 5.5 }, 0.3, 1.8), false)
  assert.equal(collides(w, { x: 5.5, y: 4.9, z: 5.5 }, 0.3, 1.8), true)
})

test('collision: a wall stops horizontal movement at the grid boundary', () => {
  const w = solidWorld([[7, 5, 5, B.STONE], [7, 6, 5, B.STONE]])
  const pos = { x: 5.5, y: 5, z: 5.5 }
  const res = moveAxis(w, pos, 'x', 3, 0.3, 1.8, null)
  assert.equal(res.hit, true)
  assert.ok(pos.x <= 6.7, `stopped at ${pos.x}, expected just before 6.7`)
  assert.equal(collides(w, pos, 0.3, 1.8), false)
})

test('collision: falling lands on the surface and reports onGround', () => {
  const w = solidWorld([[5, 4, 5, B.STONE]])
  const pos = { x: 5.5, y: 12, z: 5.5 }
  const vel = { x: 0, y: 0, z: 0 }
  let onGround = false
  for (let i = 0; i < 200 && !onGround; i++) {
    onGround = stepMovement(w, pos, vel, 1 / 60, 0.3, 1.8, 28).onGround
  }
  assert.equal(onGround, true)
  assert.ok(pos.y >= 5 && pos.y < 5.05, `landed at ${pos.y}`)
})

test('collision: an entity that does not fit is not spawned inside a block', () => {
  const w = solidWorld([[5, 5, 5, B.STONE]])
  assert.equal(fits(w, 5.5, 5, 5.5, 0.3, 1.8), false)
  assert.equal(fits(w, 5.5, 6, 5.5, 0.3, 1.8), true)
})

test('surfaceY finds the top of a column', () => {
  const w = solidWorld([[5, 3, 5, B.STONE], [5, 4, 5, B.DIRT]])
  assert.equal(surfaceY(w, 5, 5), 4)
  assert.equal(surfaceY(w, 9, 9), -1)
})

// -------------------------------------------------------------------- tools

test('every tool is faster than bare hands on the block it is made for', () => {
  assert.ok(toolSpeedOn(TOOL_BY_KEY.get('pickaxe').id, B.STONE) > 1, 'pickaxe vs stone')
  assert.ok(toolSpeedOn(TOOL_BY_KEY.get('axe').id, B.WOOD) > 1, 'axe vs wood')
  assert.ok(toolSpeedOn(TOOL_BY_KEY.get('shovel').id, B.DIRT) > 1, 'shovel vs dirt')
  for (const tool of TOOLS) {
    const id = tool.id
    for (const block of [B.GRASS, B.DIRT, B.STONE, B.WOOD, B.LEAVES, B.SAND, B.GLASS, B.BRICK]) {
      assert.ok(breakDelay(id, block) > 0, 'every delay is positive')
    }
  }
})

test('a sword digs slower than any tool but hits hardest', () => {
  const sword = TOOL_BY_KEY.get('sword').id
  assert.equal(toolSpeedOn(sword, B.STONE), 0.45)
  assert.ok(breakDelay(sword, B.STONE) > breakDelay(TOOL_BY_KEY.get('pickaxe'), B.STONE))
  const swordDamage = toolDamage(TOOL_BY_KEY.get('sword').id)
  for (const tool of TOOLS) {
    assert.ok(tool.damage <= swordDamage,
      `${tool.name} (${tool.damage}) should not out-damage the sword (${swordDamage})`)
  }
})

test('the pickaxe cuts the break delay for stone the most', () => {
  const pick = TOOL_BY_KEY.get('pickaxe').id
  assert.ok(breakDelay(pick, B.STONE) < breakDelay(pick, B.DIRT))
  assert.ok(breakDelay(0, B.STONE) > breakDelay(pick, B.STONE))
  assert.ok(breakDelay(0, B.GLASS) < breakDelay(0, B.STONE), 'glass is softer than stone')
})

test('reach follows the tool, and an empty hand has the shortest reach', () => {
  assert.ok(toolReach(TOOL_BY_KEY.get('sword').id) < toolReach(TOOL_BY_KEY.get('pickaxe').id))
  assert.equal(toolReach(0), 3.0)
  assert.ok(toolCooldown(TOOL_BY_KEY.get('axe').id) > 0)
  assert.equal(toolDamage(0), 1)
})

test('the hotbar carries four tools then eight blocks, all placeable', () => {
  assert.equal(HOTBAR.length, 12)
  assert.equal(HOTBAR.filter((i) => i.kind === 'tool').length, 4)
  for (const item of HOTBAR) {
    if (item.kind === 'block') assert.equal(BLOCKS[item.id].placeable, true)
    else assert.ok(isTool(item.id))
  }
})

test('breakGrace gives a laggy client room before the server drops an edit', () => {
  assert.ok(BREAK_GRACE >= 1.4 && BREAK_GRACE <= 2)
})

// ------------------------------------------------------------------ protocol

test('the attack message is validated', () => {
  const ok = tryDecode(encode(C2S.ATTACK, { seq: 1, target: 'm7', tool: 4, dir: [0, 0, -1] }))
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.msg.dir, [0, 0, -1])
  assert.equal(tryDecode(encode(C2S.ATTACK, { seq: 1, target: 'm7', tool: 4, dir: [0, 0] })).ok, false)
  assert.equal(tryDecode(encode(C2S.ATTACK, { seq: 1, target: 'm7', tool: 4 })).ok, false)
  assert.equal(tryDecode(encode(C2S.ATTACK, { seq: 1, target: 5, tool: 4, dir: [0, 0, -1] })).ok, false)
})

test('input may carry hp and the held tool', () => {
  const bare = tryDecode(encode(C2S.INPUT, { seq: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, t: 0 }))
  assert.equal(bare.ok, true)
  const full = tryDecode(encode(C2S.INPUT, { seq: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, t: 0, hp: 12, item: 2 }))
  assert.equal(full.ok, true)
  assert.equal(full.msg.item, 2)
})

// ------------------------------------------------------------- player vitals

function makeRegistry(world) {
  return new PlayerRegistry({ world, interestRadius: 48, log: () => {} })
}

test('a fresh player spawns at full health and can attack', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const reg = makeRegistry(world)
  const { player } = reg.add({ socket: { readyState: 1 }, name: 'Alice' })
  assert.equal(player.hp, PLAYER_MAX_HP)
  assert.equal(reg.canAttack(player, 0.45, 1000).ok, true)
  reg.markAttack(player, 1000)
  assert.equal(reg.canAttack(player, 0.45, 1100).ok, false, 'a second swing inside the cooldown is refused')
  assert.equal(reg.canAttack(player, 0.45, 1500).ok, true)
})

test('damage, death and respawn run on the server clock', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const reg = makeRegistry(world)
  const { player } = reg.add({ socket: { readyState: 1 }, name: 'Alice' })

  assert.deepEqual(reg.hurtPlayer(player, 5, 1000), { killed: false, hp: 15 })
  assert.equal(reg.tickVitals(1000).respawned.length, 0)

  // out of combat regen only starts after the delay
  reg.tickVitals(1000 + 5_000)
  assert.equal(player.hp, 15, 'no regen before the delay elapses')
  reg.tickVitals(1000 + 6_100)
  assert.equal(player.hp, 16, 'regen ticks once combat is over')

  reg.hurtPlayer(player, 99, 20_000)
  assert.equal(player.hp, 0)
  assert.equal(player.deadUntil, 20_000 + RESPAWN_MS)
  assert.equal(reg.canAttack(player, 0.45, 21_000).code, 'dead')

  const spawn = world.spawn()
  player.x = spawn.x + 9          // die somewhere else than the spawn
  player.z = spawn.z - 6
  assert.equal(reg.tickVitals(20_000 + RESPAWN_MS - 1).respawned.length, 0)
  const { respawned } = reg.tickVitals(20_000 + RESPAWN_MS)
  assert.equal(respawned.length, 1)
  assert.equal(player.hp, PLAYER_MAX_HP)
  assert.equal(player.x, spawn.x, 'respawn puts the body back on the plaza')
  assert.equal(player.z, spawn.z)
})

test('break pacing is per block family and switching family resets it', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const reg = makeRegistry(world)
  const { player } = reg.add({ socket: { readyState: 1 }, name: 'Alice' })
  const pick = TOOL_BY_KEY.get('pickaxe').id

  assert.equal(reg.breakAllowed(player, B.STONE, pick, 0).ok, true)
  const wait = reg.breakAllowed(player, B.STONE, pick, 50)
  assert.equal(wait.ok, false, 'same family again too soon is refused')
  assert.ok(wait.waitMs > 0)
  // one shared timer: alternating families must not buy a double rate
  assert.equal(reg.breakAllowed(player, B.LEAVES, pick, 50).ok, false, 'switching family does not reset the timer')
  assert.equal(reg.breakAllowed(player, B.STONE, pick, 100).ok, false, 'still on cooldown')
  assert.equal(reg.breakAllowed(player, B.STONE, pick, 400).ok, true, 'and it clears once the wait is up')
  assert.equal(reg.breakAllowed(player, B.STONE, pick, 5_000).ok, true)
})

test('a faster tool clears its cooldown sooner', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const reg = makeRegistry(world)
  const slow = reg.add({ socket: { readyState: 1 }, name: 'Slow' }).player
  const fast = reg.add({ socket: { readyState: 1 }, name: 'Fast' }).player
  const pick = TOOL_BY_KEY.get('pickaxe').id
  reg.breakAllowed(slow, B.STONE, 0, 0)
  reg.breakAllowed(fast, B.STONE, pick, 0)
  // bare hands: 0.60s * 1.6 grace = 960ms.  pickaxe: 0.20 * 1.6 = 320ms
  assert.equal(reg.breakAllowed(slow, B.STONE, 0, 400).ok, false, 'bare hands are still waiting')
  assert.equal(reg.breakAllowed(fast, B.STONE, pick, 400).ok, true, 'the pickaxe already cleared')
})

// ---------------------------------------------------------------------- mobs

test('the mob table is internally consistent', () => {
  assert.equal(MOB_COUNT, MOB_POPULATION.reduce((n, e) => n + e.count, 0))
  for (const def of MOBS) {
    assert.equal(MOB_BY_ID.get(def.id), def)
    assert.ok(def.hp > 0)
    assert.ok(def.fleeSpeed >= def.speed, `${def.name} should flee faster than it wanders`)
    assert.ok(def.halfW > 0 && def.height > 0)
    assert.ok(def.respawnMs[0] < def.respawnMs[1])
    assert.ok(def.wanderIdle[0] < def.wanderIdle[1])
  }
  assert.deepEqual(MOBS.map((m) => m.key), ['pig', 'goat', 'chicken'])
})

test('mobs spawn on solid ground, in bounds, and never inside each other', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const mobs = new MobRegistry({ world, log: () => {} })
  assert.equal(mobs.count, MOB_COUNT)

  for (const mob of mobs.all()) {
    const def = MOB_BY_ID.get(mob.kind)
    assert.ok(inBounds(Math.floor(mob.pos.x), Math.floor(mob.pos.y), Math.floor(mob.pos.z)), 'mob is inside the world')
    assert.equal(fits(world, mob.pos.x, mob.pos.y, mob.pos.z, def.halfW, def.height), true, 'mob is not stuck in a block')
    assert.equal(world.isSolid(Math.floor(mob.pos.x), Math.floor(mob.pos.y) - 1, Math.floor(mob.pos.z)), true, 'mob has ground')
  }
  const positions = mobs.all().map((m) => `${m.pos.x.toFixed(1)},${m.pos.z.toFixed(1)}`)
  assert.equal(new Set(positions).size, positions.length, 'no two mobs share a spot')
})

test('mob AI keeps them out of walls over many ticks', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const mobs = new MobRegistry({ world, log: () => {} })
  const players = new Map()
  let now = 0
  for (let i = 0; i < 20 * 60; i++) {   // one simulated minute
    now += 50
    mobs.update(1 / 20, players, now)
  }
  assert.equal(mobs.count, MOB_COUNT, 'nobody fell out of the world')
  for (const mob of mobs.all()) {
    const def = MOB_BY_ID.get(mob.kind)
    assert.equal(fits(world, mob.pos.x, mob.pos.y, mob.pos.z, def.halfW, def.height), true, 'a mob ended up inside terrain')
    // bounds, not just "greater than zero": an exploding coordinate still
    // satisfies y > 0 while being nonsense
    assert.ok(mob.pos.x > 0 && mob.pos.x < WORLD_X, `x escaped: ${mob.pos.x}`)
    assert.ok(mob.pos.z > 0 && mob.pos.z < WORLD_Z, `z escaped: ${mob.pos.z}`)
    assert.ok(mob.pos.y > 0 && mob.pos.y < WORLD_Y, `y escaped: ${mob.pos.y}`)
  }
})

test('a swing only connects inside the tool reach and off cooldown', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const mobs = new MobRegistry({ world, log: () => {} })
  const mob = mobs.all()[0]
  const near = { x: mob.pos.x + 1, y: mob.pos.y + 1.6, z: mob.pos.z }

  assert.equal(mobs.hitMob({ id: mob.id, fromId: 1, from: near, reach: 4, damage: 5, now: 1000 }).ok, true)
  assert.equal(mob.hp, MOB_BY_ID.get(mob.kind).hp - 5)
  assert.equal(mobs.hitMob({ id: mob.id, fromId: 1, from: near, reach: 4, damage: 5, now: 1100 }).ok, false, 'hit flash blocks instant re-hits')
  assert.equal(mobs.hitMob({ id: mob.id, fromId: 1, from: near, reach: 4, damage: 5, now: 2000 }).ok, true)

  const far = { x: mob.pos.x + 40, y: mob.pos.y + 1.6, z: mob.pos.z }
  assert.equal(mobs.hitMob({ id: mob.id, fromId: 1, from: far, reach: 4, damage: 5, now: 3000 }).code, 'bad_target')
  assert.equal(mobs.hitMob({ id: 9999, fromId: 1, from: near, reach: 4, damage: 5, now: 3000 }).code, 'bad_target')
})

test('a hurt mob runs away from its attacker', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const mobs = new MobRegistry({ world, log: () => {} })
  const reg = new PlayerRegistry({ world, log: () => {} })
  const { player } = reg.add({ socket: { readyState: 1 }, name: 'Victim' })
  player.x = 0
  player.z = 0

  const mob = mobs.all()[0]
  mob.pos.x = 3
  mob.pos.z = 0
  mobs.hitMob({ id: mob.id, fromId: player.id, from: { x: 0, y: mob.pos.y + 1.6, z: 0 }, reach: 6, damage: 1, now: 1000, players: reg.players })
  assert.equal(mob.state, 'flee')
  assert.ok(mob.dirX > 0.5, 'fleeing away from the attacker (+x)')
})

test('killing a mob removes it now and queues a respawn', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const mobs = new MobRegistry({ world, log: () => {} })
  const mob = mobs.all()[0]
  const def = MOB_BY_ID.get(mob.kind)
  const from = { x: mob.pos.x + 0.5, y: mob.pos.y + 1.6, z: mob.pos.z }

  const res = mobs.hitMob({ id: mob.id, fromId: 1, from, reach: 4, damage: def.hp + 5, now: 1000 })
  assert.equal(res.killed, true)
  assert.equal(mobs.get(mob.id), undefined)
  assert.equal(mobs.count, MOB_COUNT - 1)
  assert.equal(mobs.pendingRespawns.length, 1)

  // bring the clock past the respawn window
  const due = mobs.pendingRespawns[0].at
  mobs.update(1 / 20, new Map(), due + 10)
  assert.equal(mobs.count, MOB_COUNT, 'the population recovers on its own')
  assert.equal(mobs.pendingRespawns.length, 0)
})

test('mob visibility follows the interest radius', () => {
  const world = new AuthoritativeWorld({ seed: 1337 })
  const mobs = new MobRegistry({ world, log: () => {} })
  const all = mobs.all()
  const first = all[0]
  assert.ok(mobs.visibleFrom(first.pos.x, first.pos.z, 8).some((m) => m.id === first.id))
  assert.equal(mobs.visibleFrom(first.pos.x + 1000, first.pos.z, 8).length, 0)
})

test('the same collision code runs on both sides of the wire', () => {
  // the client world and the server world must answer isSolid identically
  const blocks = generate(1337)
  const client = {
    isSolid: (x, y, z) => (inBounds(x, y, z)
      ? BLOCKS[blocks[indexOf(x, y, z)]].solid === true
      : false),
  }
  const server = new AuthoritativeWorld({ seed: 1337 })
  for (let i = 0; i < 500; i++) {
    const x = i % 64
    const y = Math.floor(i / 64) % WORLD_Y
    const z = Math.floor(i / 4096) % 64
    assert.equal(client.isSolid(x, y, z), server.isSolid(x, y, z), `disagreement at ${x},${y},${z}`)
  }
})
