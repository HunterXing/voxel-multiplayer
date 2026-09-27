import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { startTestServer, TestClient, walkTo, sleep, EDIT_GAP_MS, C2S, S2C } from './harness.js'
import { B, BLOCKS } from '../shared/blocks.js'
import { TOOL_BY_KEY } from '../shared/items.js'
import { MAX_PLAYERS, WORLD_X, WORLD_Y, WORLD_Z, PLAZA } from '../shared/constants.js'

/**
 * Cells guaranteed to be air: the spawn plaza is flattened and cleared above
 * PLAZA.y, and |dx|,|dz| <= 3 stays inside its radius. Editing a cell that is
 * actually solid would fail the compare-and-swap and silently look like a
 * server bug, so every edit test asserts this first.
 */
const AIR_CELLS = [
  { x: PLAZA.x, y: PLAZA.y + 6, z: PLAZA.z },
  { x: PLAZA.x + 1, y: PLAZA.y + 6, z: PLAZA.z },
  { x: PLAZA.x + 2, y: PLAZA.y + 6, z: PLAZA.z - 1 },
  { x: PLAZA.x - 2, y: PLAZA.y + 6, z: PLAZA.z + 2 },
]
const AIR_CELL = AIR_CELLS[0]

function assertAir(ctx, cell) {
  assert.equal(ctx.server.world.get(cell.x, cell.y, cell.z), B.AIR,
    `test cell ${cell.x},${cell.y},${cell.z} must start as air`)
  return cell
}

async function withServer(options, fn) {
  const ctx = await startTestServer(options)
  try {
    await fn(ctx)
  } finally {
    await ctx.server.close()
  }
}

// ------------------------------------------------------------------- join

test('join: init carries the world contract, and players learn about each other', async () => {
  await withServer({}, async ({ url }) => {
    const a = await TestClient.connect(url, 'Alice')
    const init = a.all(S2C.INIT)[0]

    assert.equal(init.selfId, 1)
    assert.equal(init.name, 'Alice')
    assert.equal(typeof init.seed, 'number')
    assert.deepEqual(init.world, { x: WORLD_X, y: WORLD_Y, z: WORLD_Z, chunk: 16 })
    assert.equal(init.players.length, 1)
    assert.equal(init.palette.length, BLOCKS.length)
    assert.equal(init.rates.snapshot, 15)
    assert.ok(init.resumeToken.length >= 16)
    // a join must never ship the voxel array
    assert.equal(init.edits.length, 0)
    assert.equal(JSON.stringify(init).length < 4096, true)

    const b = await TestClient.connect(url, 'Bob')
    await a.waitFor((m) => m.type === S2C.PLAYER_JOIN && m.name === 'Bob')
    const bJoin = b.all(S2C.INIT)[0]
    assert.equal(bJoin.players.length, 2)
    assert.ok(bJoin.players.some((p) => p.name === 'Alice'))

    // duplicate names get disambiguated
    const c = await TestClient.connect(url, 'Alice')
    assert.equal(c.all(S2C.INIT)[0].name, 'Alice 2')

    await Promise.all([a.close(), b.close(), c.close()])
  })
})

test('join: a blank name is rejected and the server never reuses names blindly', async () => {
  await withServer({}, async ({ url }) => {
    const bad = new TestClient(url)
    await bad.open()
    bad.send(C2S.HELLO, { name: '   ' })
    const err = await bad.waitFor(S2C.ERROR)
    assert.equal(err.code, 'bad_name')
    const closed = await bad.waitClose()
    assert.equal(closed.code, 1008)
  })
})

test('join: the server refuses connections past MAX_PLAYERS', async () => {
  await withServer({}, async ({ url }) => {
    const clients = []
    for (let i = 0; i < MAX_PLAYERS; i++) {
      clients.push(await TestClient.connect(url, `P${i}`))
    }
    const extra = new TestClient(url)
    await extra.open()
    extra.send(C2S.HELLO, { name: 'one-too-many' })
    const err = await extra.waitFor(S2C.ERROR)
    assert.equal(err.code, 'server_full')
    assert.equal((await extra.waitClose()).code, 1008)
    await Promise.all(clients.map((c) => c.close()))
  })
})

// ------------------------------------------------------------------- sync

test('sync: movement propagates through snapshots', async () => {
  await withServer({}, async ({ url }) => {
    const a = await TestClient.connect(url, 'Alice')
    const b = await TestClient.connect(url, 'Bob')
    const aliceId = a.all(S2C.INIT)[0].selfId
    const bobId = b.all(S2C.INIT)[0].selfId
    await a.waitFor(S2C.SNAPSHOT)

    const spawn = a.all(S2C.INIT)[0].players.find((p) => p.id === aliceId)
    const target = { x: spawn.x + 3, y: spawn.y, z: spawn.z }
    await walkTo(a, spawn, target)

    const snap = await b.waitFor((m) => m.type === S2C.SNAPSHOT
      && m.players.some((p) => p.id === aliceId && Math.abs(p.x - target.x) < 0.3))
    const alice = snap.players.find((p) => p.id === aliceId)
    assert.ok(Math.abs(alice.x - target.x) < 0.3)
    assert.ok(Math.abs(alice.z - target.z) < 0.3)
    assert.equal(typeof alice.yaw, 'number')
    // snapshots are id scoped: you never appear in your own
    assert.equal(snap.players.some((p) => p.id === bobId), false)

    await Promise.all([a.close(), b.close()])
  })
})

test('sync: interest management hides players outside the radius', async () => {
  await withServer({ interestRadius: 8 }, async ({ url }) => {
    const a = await TestClient.connect(url, 'Alice')
    const watcher = await TestClient.connect(url, 'Watcher')
    const aliceId = a.all(S2C.INIT)[0].selfId
    const watcherId = watcher.all(S2C.INIT)[0].selfId

    // both spawn on the same plaza, so they are inside each other's radius
    const near = await a.waitFor((m) => m.type === S2C.SNAPSHOT
      && m.players.some((p) => p.id === watcherId))
    assert.ok(near.players.some((p) => p.id === watcherId), 'visible up close')

    const spawn = a.all(S2C.INIT)[0].players.find((p) => p.id === aliceId)
    const far = { x: spawn.x + 12, y: spawn.y, z: spawn.z + 12 }
    await walkTo(a, spawn, far)

    await a.waitFor((m) => m.type === S2C.SNAPSHOT
      && !m.players.some((p) => p.id === watcherId)
      && m.players.length === 0, 6000)
    await watcher.waitFor((m) => m.type === S2C.SNAPSHOT
      && !m.players.some((p) => p.id === aliceId)
      && m.players.length === 0, 6000)

    await Promise.all([a.close(), watcher.close()])
  })
})

// ------------------------------------------------------------------ leave

test('leave: disconnecting broadcasts playerLeave and stops the snapshots', async () => {
  await withServer({}, async ({ url }) => {
    const a = await TestClient.connect(url, 'Alice')
    const b = await TestClient.connect(url, 'Bob')
    const aliceId = a.all(S2C.INIT)[0].selfId
    await b.waitFor((m) => m.type === S2C.SNAPSHOT && m.players.some((p) => p.id === aliceId))

    await a.close()
    const left = await b.waitFor((m) => m.type === S2C.PLAYER_LEAVE)
    assert.equal(left.id, aliceId)

    const after = await b.waitFor((m) => m.type === S2C.SNAPSHOT
      && !m.players.some((p) => p.id === aliceId), 3000)
    assert.equal(after.players.length, 0)
  })
})

// ----------------------------------------------------------------- edits

test('edit: placing a block is applied server side and broadcast', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const b = await TestClient.connect(ctx.url, 'Bob')
    const cell = assertAir(ctx, AIR_CELLS[0])

    a.send(C2S.BLOCK_EDIT, { seq: 1, ...cell, block: B.BRICK, expected: B.AIR })
    const heard = await b.waitFor(S2C.BLOCK_CHANGED)
    assert.deepEqual([heard.x, heard.y, heard.z], [cell.x, cell.y, cell.z])
    assert.equal(heard.block, B.BRICK)
    assert.equal(heard.by, 1)

    // the server agrees, and the winner is echoed back to the author too
    assert.equal(ctx.server.world.get(cell.x, cell.y, cell.z), B.BRICK)
    const echo = await a.waitFor(S2C.BLOCK_CHANGED)
    assert.equal(echo.seq, 1)

    // removing it again works (respect the server's edit cadence)
    await sleep(EDIT_GAP_MS)
    a.send(C2S.BLOCK_EDIT, { seq: 2, ...cell, block: B.AIR, expected: B.BRICK })
    const removed = await b.waitFor((m) => m.type === S2C.BLOCK_CHANGED && m.seq === 2)
    assert.equal(removed.block, B.AIR)
    assert.equal(ctx.server.world.get(cell.x, cell.y, cell.z), B.AIR)

    await Promise.all([a.close(), b.close()])
  } finally {
    await ctx.server.close()
  }
})

// -------------------------------------------------------------- conflicts

test('conflict: a same-cell race has exactly one winner and the loser is corrected', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const b = await TestClient.connect(ctx.url, 'Bob')
    const cell = assertAir(ctx, AIR_CELLS[1])

    // Both writers still believe the cell is air. Fire both without waiting:
    // whichever the event loop handles first commits, the other must be told.
    a.send(C2S.BLOCK_EDIT, { seq: 10, ...cell, block: B.STONE, expected: B.AIR })
    b.send(C2S.BLOCK_EDIT, { seq: 20, ...cell, block: B.GLASS, expected: B.AIR })

    await sleep(300)

    const committed = ctx.server.world.get(cell.x, cell.y, cell.z)
    assert.ok(committed === B.STONE || committed === B.GLASS, 'one of the two must have won')

    const aOwn = a.all(S2C.BLOCK_CHANGED).filter((m) => m.seq === 10 && m.block === B.STONE)
    const bOwn = b.all(S2C.BLOCK_CHANGED).filter((m) => m.seq === 20 && m.block === B.GLASS)
    const aReject = a.all(S2C.EDIT_REJECTED)
    const bReject = b.all(S2C.EDIT_REJECTED)

    if (committed === B.STONE) {
      assert.equal(aOwn.length, 1, 'Alice committed her own block')
      assert.equal(bReject.length, 1, 'Bob was rejected')
      assert.equal(bReject[0].actual, B.STONE, 'rejection carries the server truth')
      assert.equal(bOwn.length, 0)
    } else {
      assert.equal(bOwn.length, 1)
      assert.equal(aReject.length, 1)
      assert.equal(aReject[0].actual, B.GLASS)
      assert.equal(aOwn.length, 0)
    }

    // whoever lost also saw the broadcast, so both clients hold the same value
    const winnerBlock = committed
    const seenByA = [...a.all(S2C.BLOCK_CHANGED)].filter((m) => m.x === cell.x && m.y === cell.y && m.z === cell.z)
    const seenByB = [...b.all(S2C.BLOCK_CHANGED)].filter((m) => m.x === cell.x && m.y === cell.y && m.z === cell.z)
    assert.ok(seenByA.length >= 1 && seenByB.length >= 1)
    assert.equal(seenByA.at(-1).block, winnerBlock)
    assert.equal(seenByB.at(-1).block, winnerBlock)

    await Promise.all([a.close(), b.close()])
  } finally {
    await ctx.server.close()
  }
})

test('conflict: a stale expectation is rejected even without a real race', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const cell = assertAir(ctx, AIR_CELLS[2])

    a.send(C2S.BLOCK_EDIT, { seq: 1, ...cell, block: B.SAND, expected: B.AIR })
    await a.waitFor(S2C.BLOCK_CHANGED)

    // Alice's own view is stale by one block
    await sleep(EDIT_GAP_MS)
    a.send(C2S.BLOCK_EDIT, { seq: 2, ...cell, block: B.DIRT, expected: B.AIR })
    const rejected = await a.waitFor(S2C.EDIT_REJECTED)
    assert.equal(rejected.actual, B.SAND)
    assert.equal(rejected.seq, 2)
    assert.equal(ctx.server.world.get(cell.x, cell.y, cell.z), B.SAND)

    await a.close()
  } finally {
    await ctx.server.close()
  }
})

// ------------------------------------------------------------- validation

test('guard: edits are rate limited', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    for (let i = 0; i < 12; i++) {
      a.send(C2S.BLOCK_EDIT, {
        seq: i + 1, x: AIR_CELL.x + 3 + i, y: AIR_CELL.y, z: AIR_CELL.z,
        block: B.STONE, expected: B.AIR,
      })
    }
    const err = await a.waitFor((m) => m.type === S2C.ERROR && m.code === 'rate_limited')
    assert.equal(err.code, 'rate_limited')
    // not everything got through
    assert.ok(ctx.server.world.edits.size < 12)
    await a.close()
  } finally {
    await ctx.server.close()
  }
})

test('guard: illegal blocks and out of bounds coordinates are refused', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')

    a.send(C2S.BLOCK_EDIT, { seq: 1, x: 5, y: 20, z: 5, block: 99, expected: 0 })
    assert.equal((await a.waitFor((m) => m.type === S2C.ERROR && m.code === 'bad_block')).code, 'bad_block')

    a.send(C2S.BLOCK_EDIT, { seq: 2, x: 5, y: WORLD_Y + 10, z: 5, block: B.STONE, expected: 0 })
    assert.equal((await a.waitFor((m) => m.type === S2C.ERROR && m.code === 'out_of_bounds')).code, 'out_of_bounds')

    a.send(C2S.BLOCK_EDIT, { seq: 3, x: -4, y: 20, z: 5, block: B.STONE, expected: 0 })
    assert.equal((await a.waitFor((m) => m.type === S2C.ERROR && m.code === 'out_of_bounds')).code, 'out_of_bounds')

    // bedrock is protected
    a.send(C2S.BLOCK_EDIT, { seq: 4, x: 0, y: 0, z: 0, block: B.AIR, expected: B.BEDROCK })
    assert.equal((await a.waitFor((m) => m.type === S2C.ERROR && m.code === 'bad_block')).code, 'bad_block')

    await a.close()
  } finally {
    await ctx.server.close()
  }
})

test('guard: three malformed frames drop the connection', async () => {
  const ctx = await startTestServer({})
  try {
    const a = new TestClient(ctx.url)
    await a.open()
    a.send(C2S.HELLO, { name: 'Alice' })
    await a.waitFor(S2C.INIT)

    a.sendRaw('{{{ not json')
    assert.equal((await a.waitFor(S2C.ERROR)).code, 'bad_message')
    a.sendRaw(JSON.stringify({ type: 'nonsense' }))
    assert.equal((await a.waitFor((m) => m.type === S2C.ERROR)).code, 'bad_message')
    a.sendRaw(JSON.stringify({ type: C2S.BLOCK_EDIT, seq: 1, x: 'five', y: 2, z: 3, block: 1, expected: 0 }))
    await sleep(100)
    const closed = await a.waitClose()
    assert.equal(closed.code, 1008)
  } finally {
    await ctx.server.close()
  }
})

test('guard: a moving client cannot teleport', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const before = { ...ctx.server.players.get(1) }
    const beforePos = { x: before.x, y: before.y, z: before.z }

    a.send(C2S.INPUT, { seq: 1, x: beforePos.x + 40, y: beforePos.y, z: beforePos.z + 40, yaw: 0, pitch: 0, t: Date.now() })
    // the server answers with correction + error in one go; read the log rather
    // than relying on their relative order
    await a.waitFor(S2C.CORRECTION)
    await sleep(50)
    const err = a.all(S2C.ERROR).find((m) => m.code === 'speed')

    assert.ok(err, 'a speed error must be reported')
    assert.equal(err.code, 'speed')
    const correction = a.all(S2C.CORRECTION)[0]
    assert.ok(Math.abs(correction.x - beforePos.x) < 1e-6, 'server must not accept the teleport')
    const now = ctx.server.players.get(1)
    assert.equal(now.x, beforePos.x)
    assert.equal(now.z, beforePos.z)

    await a.close()
  } finally {
    await ctx.server.close()
  }
})

test('guard: ping/pong keeps the client clock in sync', async () => {
  await withServer({}, async ({ url }) => {
    const a = await TestClient.connect(url, 'Alice')
    const t = Date.now()
    a.send(C2S.PING, { t })
    const pong = await a.waitFor(S2C.PONG)
    assert.equal(pong.t, t)
    assert.ok(Math.abs(pong.serverTime - Date.now()) < 5000)
    await a.close()
  })
})

// ------------------------------------------------------------------ resume

test('resume: reconnecting with the token keeps identity and re-sends the world', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const first = a.all(S2C.INIT)[0]

    const cell = assertAir(ctx, AIR_CELLS[3])
    a.send(C2S.BLOCK_EDIT, { seq: 1, ...cell, block: B.LEAVES, expected: B.AIR })
    await a.waitFor(S2C.BLOCK_CHANGED)
    await a.close()
    await sleep(80)

    // a client that reconnects with the stored token comes back as the same player
    const b = new TestClient(ctx.url)
    await b.open()
    b.send(C2S.HELLO, { name: 'Alice', resumeToken: first.resumeToken })
    const second = await b.waitFor(S2C.INIT)

    assert.equal(second.selfId, first.selfId, 'same player id after resume')
    assert.equal(second.name, 'Alice')
    assert.equal(second.resumeToken, first.resumeToken)
    assert.deepEqual(second.edits, [[cell.x, cell.y, cell.z, B.LEAVES]])
    assert.equal(ctx.server.players.size, 1, 'resume must not create a second player')

    await b.close()
  } finally {
    await ctx.server.close()
  }
})

test('resume: a fresh connection without a token is a different player', async () => {
  await withServer({}, async ({ url }) => {
    const a = await TestClient.connect(url, 'Alice')
    const first = a.all(S2C.INIT)[0]
    const b = await TestClient.connect(url, 'Alice')
    const second = b.all(S2C.INIT)[0]
    assert.notEqual(second.selfId, first.selfId)
    assert.notEqual(second.resumeToken, first.resumeToken)
    assert.equal(second.name, 'Alice 2')
    await Promise.all([a.close(), b.close()])
  })
})

// ------------------------------------------------------------ persistence

test('persistence: edits survive a server restart', async () => {
  const first = await startTestServer({})
  const dataDir = first.dataDir
  const seed = first.server.world.seed
  const cell = { ...AIR_CELLS[1] }

  try {
    const a = await TestClient.connect(first.url, 'Alice')
    a.send(C2S.BLOCK_EDIT, { seq: 1, ...cell, block: B.GLASS, expected: B.AIR })
    await a.waitFor(S2C.BLOCK_CHANGED)
    await sleep(EDIT_GAP_MS)
    a.send(C2S.BLOCK_EDIT, { seq: 2, x: cell.x + 1, y: cell.y, z: cell.z, block: B.BRICK, expected: B.AIR })
    await a.waitFor((m) => m.type === S2C.BLOCK_CHANGED && m.seq === 2)
    await a.close()
  } finally {
    await first.server.close() // this performs the final save
  }

  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'world.json'), 'utf8'))
  assert.equal(saved.version, 1)
  assert.equal(saved.seed, seed)
  assert.equal(saved.edits.length, 2)

  // boot again on the same data directory
  const second = await startTestServer({ dataDir })
  try {
    assert.equal(second.server.world.get(cell.x, cell.y, cell.z), B.GLASS)
    const fresh = await TestClient.connect(second.url, 'Latecomer')
    const init = fresh.all(S2C.INIT)[0]
    assert.equal(init.seed, seed)
    assert.deepEqual(init.edits, [[cell.x, cell.y, cell.z, B.GLASS], [cell.x + 1, cell.y, cell.z, B.BRICK]])
    await fresh.close()
  } finally {
    await second.server.close()
  }
})

test('persistence: a corrupt snapshot falls back to the generated world', async () => {
  const ctx = await startTestServer({})
  const dataDir = ctx.dataDir
  await ctx.server.close()

  fs.writeFileSync(path.join(dataDir, 'world.json'), '{ this is not json')
  const revived = await startTestServer({ dataDir })
  try {
    assert.equal(revived.server.world.edits.size, 0)
    assert.equal(revived.server.world.get(0, 0, 0), B.BEDROCK, 'terrain regenerated from the seed')
    const a = await TestClient.connect(revived.url, 'Alice')
    assert.equal(a.all(S2C.INIT)[0].edits.length, 0)
    await a.close()
  } finally {
    await revived.server.close()
  }
})

test('persistence: the periodic timer saves without an explicit shutdown', async () => {
  const ctx = await startTestServer({ saveIntervalMs: 120 })
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const cell = assertAir(ctx, AIR_CELLS[2])
    a.send(C2S.BLOCK_EDIT, { seq: 1, ...cell, block: B.SAND, expected: B.AIR })
    await a.waitFor(S2C.BLOCK_CHANGED)
    await sleep(300)
    const saved = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'world.json'), 'utf8'))
    assert.deepEqual(saved.edits, [[cell.x, cell.y, cell.z, B.SAND]])
    await a.close()
  } finally {
    await ctx.server.close()
  }
})

// ---------------------------------------------------------------- teardown

test('teardown: closing the server disconnects everyone', async () => {
  const ctx = await startTestServer({})
  const a = await TestClient.connect(ctx.url, 'Alice')
  assert.equal(ctx.server.players.size, 1)
  await ctx.server.close()
  const closed = await a.waitClose()
  assert.equal(closed.code, 1006)
})

// ------------------------------------------------------------------ combat

/** Walk a client next to a world position, then face it. */
async function approach(client, from, to) {
  await walkTo(client, from, { x: to.x, z: to.z })
}

function faceYaw(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z))
}

test('combat: a swing in reach damages a mob and a kill removes it', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const mob = ctx.server.mobs.all()[0]
    const def = mob.hp
    const me = ctx.server.players.get(a.all(S2C.INIT)[0].selfId)

    // set the scene: a mob an arm's length away. Walking to a wandering animal
    // would make the test depend on its mood.
    mob.pos.x = me.x + 1.2
    mob.pos.y = me.y
    mob.pos.z = me.z
    assert.ok(Math.hypot(me.x - mob.pos.x, me.z - mob.pos.z) < 3.2, 'inside sword reach')

    const dir = [0, 0, -1]
    a.send(C2S.ATTACK, { seq: 1, target: `m${mob.id}`, tool: 4, dir })
    const hurt = await a.waitFor((m) => m.type === S2C.HURT && m.target === `m${mob.id}`)
    assert.equal(hurt.amount, 5, 'sword damage')
    assert.equal(hurt.killed, false)
    assert.equal(ctx.server.mobs.get(mob.id).hp, def - 5)

    // a second swing lands, then a third kills it
    a.send(C2S.ATTACK, { seq: 2, target: `m${mob.id}`, tool: 4, dir })
    await sleep(600)
    a.send(C2S.ATTACK, { seq: 3, target: `m${mob.id}`, tool: 4, dir })
    const gone = await a.waitFor((m) => m.type === S2C.MOB_GONE && m.id === mob.id)
    assert.equal(gone.id, mob.id)
    assert.equal(ctx.server.mobs.get(mob.id), undefined)
  } finally {
    await ctx.server.close()
  }
})

test('combat: out of reach and too-fast swings are refused', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const mob = ctx.server.mobs.all()[0]
    const me = ctx.server.players.get(1)
    // park the mob far away and on the same level
    mob.pos.x = me.x + 30
    mob.pos.y = me.y
    mob.pos.z = me.z
    a.send(C2S.ATTACK, { seq: 1, target: `m${mob.id}`, tool: 4, dir: [0, 0, -1] })
    const err = await a.waitFor((m) => m.type === S2C.ERROR && m.code === 'bad_target')
    assert.equal(err.code, 'bad_target', 'a swing at 30m does not connect')
    assert.equal(mob.hp, mob.hp, 'hp untouched')
  } finally {
    await ctx.server.close()
  }
})

test('combat: attack cooldown is enforced per player', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const mob = ctx.server.mobs.all()[0]
    const me = ctx.server.players.get(1)
    mob.pos.x = me.x + 1
    mob.pos.y = me.y
    mob.pos.z = me.z

    a.send(C2S.ATTACK, { seq: 1, target: `m${mob.id}`, tool: 4, dir: [0, 0, -1] })
    await a.waitFor((m) => m.type === S2C.HURT)
    a.send(C2S.ATTACK, { seq: 2, target: `m${mob.id}`, tool: 4, dir: [0, 0, -1] })
    const err = await a.waitFor((m) => m.type === S2C.ERROR && m.code === 'too_fast')
    assert.equal(err.code, 'too_fast')
  } finally {
    await ctx.server.close()
  }
})

test('combat: two players can kill each other, and death respawns you', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const b = await TestClient.connect(ctx.url, 'Bob')
    const alice = ctx.server.players.get(a.all(S2C.INIT)[0].selfId)
    const bob = ctx.server.players.get(b.all(S2C.INIT)[0].selfId)

    // walk Alice to within sword reach of Bob
    await walkTo(a, { x: alice.x, y: alice.y, z: alice.z }, { x: bob.x, z: bob.z })
    assert.ok(ctx.server.players.get(alice.id), 'Alice is still connected')
    assert.ok(Math.hypot(alice.x - bob.x, alice.z - bob.z) < 3.0,
      `in sword reach (distance ${Math.hypot(alice.x - bob.x, alice.z - bob.z).toFixed(1)})`)

    const aId = alice.id
    // sword: 5 damage, 20 hp -> four hits
    for (let i = 0; i < 4; i++) {
      a.send(C2S.ATTACK, { seq: 100 + i, target: `p${bob.id}`, tool: 4, dir: [0, 0, -1] })
      await sleep(520)
    }

    const died = await a.waitFor((m) => m.type === S2C.DIED && m.id === bob.id, 4000)
    assert.equal(died.id, bob.id)
    assert.equal(ctx.server.players.get(bob.id).hp, 0, 'the server considers Bob dead')

    // the corpse freezes, then comes back at the plaza with full health
    const seen = await b.waitFor((m) => m.type === S2C.RESPAWNED && m.id === bob.id, 6000)
    assert.equal(seen.id, bob.id)
    assert.equal(ctx.server.players.get(bob.id).hp, 20)
    assert.ok(Math.hypot(bob.x - 32.5, bob.z - 32.5) < 2, 'respawned on the plaza')
    void aId
  } finally {
    await ctx.server.close()
  }
})

test('combat: a dead player cannot swing', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const me = ctx.server.players.get(1)
    me.hp = 0
    me.deadUntil = Date.now() + 1000
    a.send(C2S.ATTACK, { seq: 1, target: 'm1', tool: 4, dir: [0, 0, -1] })
    const err = await a.waitFor((m) => m.type === S2C.ERROR && m.code === 'dead')
    assert.equal(err.code, 'dead')
  } finally {
    await ctx.server.close()
  }
})

test('combat: mobs ride along in snapshots and stay inside the world', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const snap = await a.waitFor((m) => m.type === S2C.SNAPSHOT && m.mobs.length > 0)
    for (const m of snap.mobs) {
      assert.equal(typeof m.kind, 'number')
      assert.ok(m.x > 0 && m.x < WORLD_X, `mob x out of range: ${m.x}`)
      assert.ok(m.z > 0 && m.z < WORLD_Z, `mob z out of range: ${m.z}`)
      assert.ok(m.y > 0 && m.y < WORLD_Y, `mob y out of range: ${m.y}`)
    }
    // and they actually move
    const before = snap.mobs[0]
    const moved = await a.waitFor((m) => m.type === S2C.SNAPSHOT
      && m.mobs.some((x) => x.id === before.id
        && Math.abs(x.x - before.x) + Math.abs(x.z - before.z) > 0.01), 5000)
    assert.ok(moved.mobs.length > 0)
  } finally {
    await ctx.server.close()
  }
})

test('combat: the tool in hand paces breaking, and the server drops it', async () => {
  const ctx = await startTestServer({})
  try {
    const a = await TestClient.connect(ctx.url, 'Alice')
    const cell = assertAir(ctx, AIR_CELLS[1])
    const other = assertAir(ctx, AIR_CELLS[2])
    const stoneWait = 320   // breakDelay(pickaxe, STONE) 0.2 * grace 1.6

    // put a stone down, wait out the tool timer, then break it
    a.send(C2S.BLOCK_EDIT, { seq: 1, ...cell, block: B.STONE, expected: B.AIR, tool: 1 })
    await a.waitFor((m) => m.type === S2C.BLOCK_CHANGED && m.seq === 1)
    assert.equal(ctx.server.world.get(cell.x, cell.y, cell.z), B.STONE)

    await sleep(stoneWait + 80)
    a.send(C2S.BLOCK_EDIT, { seq: 2, ...cell, block: B.AIR, expected: B.STONE, tool: 1 })
    const broken = await a.waitFor((m) => m.type === S2C.BLOCK_CHANGED && m.seq === 2)
    assert.equal(broken.block, B.AIR)

    // a fresh stone, then an immediate attempt to break it: dropped.
    // The 80ms gap clears the 60ms edit rate limit first, so what rejects
    // seq 4 really is the tool cooldown.
    await sleep(80)
    a.send(C2S.BLOCK_EDIT, { seq: 3, ...other, block: B.STONE, expected: B.AIR, tool: 1 })
    await a.waitFor((m) => m.type === S2C.BLOCK_CHANGED && m.seq === 3)
    a.send(C2S.BLOCK_EDIT, { seq: 4, ...other, block: B.AIR, expected: B.STONE, tool: 1 })
    await sleep(150)
    assert.equal(ctx.server.world.get(other.x, other.y, other.z), B.STONE,
      'a break inside the tool cooldown is dropped, not queued')

    // once the timer clears the same swing goes through
    await sleep(stoneWait + 100)
    a.send(C2S.BLOCK_EDIT, { seq: 5, ...other, block: B.AIR, expected: B.STONE, tool: 1 })
    await a.waitFor((m) => m.type === S2C.BLOCK_CHANGED && m.seq === 5)
    assert.equal(ctx.server.world.get(other.x, other.y, other.z), B.AIR)
  } finally {
    await ctx.server.close()
  }
})
