import test from 'node:test'
import assert from 'node:assert/strict'

import { generate, generateInto, heightAt, spawnPoint } from '../shared/worldgen.js'
import { indexOf, inBounds, chunkIndexOf, VOXEL_COUNT, chunkCoords } from '../shared/voxel.js'
import { WORLD_X, WORLD_Y, WORLD_Z, CHUNKS_X, CHUNK_SIZE, PLAZA } from '../shared/constants.js'
import { B, isSolid, isPlaceable, tileFor, BLOCKS, HOTBAR } from '../shared/blocks.js'
import { encode, tryDecode, C2S, S2C, ERRORS } from '../shared/protocol.js'
import { AuthoritativeWorld } from '../server/world.js'
import { sanitizeName } from '../server/players.js'

// ------------------------------------------------------------------ worldgen

test('worldgen is byte-identical for the same seed', () => {
  const a = generate(1337)
  const b = generate(1337)
  assert.equal(a.length, VOXEL_COUNT)
  assert.deepEqual(a, b)
})

test('worldgen differs across seeds and is stable across calls', () => {
  const a = generate(1337)
  const c = generate(4242)
  assert.notDeepEqual(a, c)
  assert.deepEqual(c, generate(4242))
})

test('worldgen fills a whole world: bedrock floor, no floating edge columns', () => {
  const w = generate(1337)
  for (let z = 0; z < WORLD_Z; z += 7) {
    for (let x = 0; x < WORLD_X; x += 7) {
      assert.equal(w[indexOf(x, 0, z)], B.BEDROCK, `bedrock missing at ${x},${z}`)
    }
  }
  // the spawn plaza is flat brick with air above it
  assert.equal(w[indexOf(PLAZA.x, PLAZA.y, PLAZA.z)], B.BRICK)
  assert.equal(w[indexOf(PLAZA.x, PLAZA.y + 1, PLAZA.z)], B.AIR)
  assert.equal(w[indexOf(PLAZA.x, PLAZA.y + 5, PLAZA.z)], B.AIR)
})

test('heightAt stays inside the world and is pure', () => {
  for (let z = 0; z < WORLD_Z; z += 11) {
    for (let x = 0; x < WORLD_X; x += 11) {
      const h = heightAt(1337, x, z)
      assert.equal(h, heightAt(1337, x, z))
      assert.ok(h >= 3 && h < WORLD_Y, `height ${h} out of range at ${x},${z}`)
    }
  }
})

test('generateInto writes into the buffer it is given', () => {
  const buf = new Uint8Array(VOXEL_COUNT)
  assert.equal(generateInto(99, buf), buf)
  assert.deepEqual(buf, generate(99))
})

test('spawn point stands on solid ground', () => {
  const w = new AuthoritativeWorld({ seed: 1337 })
  const s = spawnPoint()
  assert.equal(w.isSolid(Math.floor(s.x), Math.floor(s.y) - 1, Math.floor(s.z)), true)
})

// -------------------------------------------------------------------- voxel

test('idx <-> (x, y, z) round trips for every corner and the middle', () => {
  const probes = [
    [0, 0, 0], [WORLD_X - 1, WORLD_Y - 1, WORLD_Z - 1],
    [1, 2, 3], [WORLD_X - 2, 0, WORLD_Z - 2], [0, WORLD_Y - 1, WORLD_Z - 1],
  ]
  for (const [x, y, z] of probes) {
    const i = indexOf(x, y, z)
    assert.ok(i >= 0 && i < VOXEL_COUNT)
    const yc = Math.floor(i / (WORLD_X * WORLD_Z))
    const rem = i - yc * WORLD_X * WORLD_Z
    const zc = Math.floor(rem / WORLD_X)
    const xc = rem - zc * WORLD_X
    assert.deepEqual([xc, yc, zc], [x, y, z])
  }
  // every index is unique
  assert.equal(new Set(probes.map(([x, y, z]) => indexOf(x, y, z))).size, probes.length)
})
test('inBounds rejects the borders and out-of-range access reads air', () => {
  const w = new AuthoritativeWorld({ seed: 1 })
  assert.equal(inBounds(0, 0, 0), true)
  assert.equal(inBounds(WORLD_X - 1, WORLD_Y - 1, WORLD_Z - 1), true)
  assert.equal(inBounds(-1, 0, 0), false)
  assert.equal(inBounds(0, WORLD_Y, 0), false)
  assert.equal(inBounds(0, 0, WORLD_Z), false)
  assert.equal(w.get(-5, 0, 0), B.AIR)
  assert.equal(w.get(0, WORLD_Y + 9, 0), B.AIR)
})

test('chunkIndexOf covers every column exactly once', () => {
  const seen = new Set()
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const ci = chunkIndexOf(x, z)
      assert.ok(Number.isInteger(ci) && ci >= 0 && ci < CHUNKS_X * CHUNKS_X)
      seen.add(ci)
    }
  }
  assert.equal(seen.size, CHUNKS_X * CHUNKS_X)
  const { cx, cz } = chunkCoords(chunkIndexOf(CHUNK_SIZE + 3, CHUNK_SIZE * 2 + 1))
  assert.equal(cx, 1)
  assert.equal(cz, 2)
})

// -------------------------------------------------------------------- blocks

test('block table is consistent', () => {
  BLOCKS.forEach((b, i) => assert.equal(b.id, i))
  assert.equal(isSolid(B.AIR), false)
  assert.equal(isSolid(B.WATER), false)
  assert.equal(isSolid(B.GRASS), true)
  assert.equal(isPlaceable(B.WATER), false)
  assert.equal(isPlaceable(B.BEDROCK), false)
  assert.equal(isPlaceable(B.BRICK), true)
  assert.equal(HOTBAR.every(isPlaceable), true, 'every hotbar entry must be placeable')
  assert.equal(tileFor(B.GRASS, 'top'), 0)
  assert.equal(tileFor(B.GRASS, 'bottom'), tileFor(B.DIRT, 'side'))
})

// ------------------------------------------------------------------ protocol

test('tryDecode accepts every valid client message', () => {
  const hello = tryDecode(encode(C2S.HELLO, { name: 'Alice' }))
  assert.equal(hello.ok, true)
  assert.equal(hello.msg.name, 'Alice')

  const withToken = tryDecode(encode(C2S.HELLO, { name: 'A', resumeToken: 'deadbeef' }))
  assert.equal(withToken.ok, true)

  const input = tryDecode(encode(C2S.INPUT, { seq: 1, x: 1, y: 2, z: 3, yaw: 0.1, pitch: 0.2, t: 5 }))
  assert.equal(input.ok, true)

  const edit = tryDecode(encode(C2S.BLOCK_EDIT, { seq: 2, x: 0, y: 1, z: 2, block: 1, expected: 0 }))
  assert.equal(edit.ok, true)
  assert.equal(edit.msg.block, 1)
})

test('tryDecode rejects malformed frames', () => {
  assert.equal(tryDecode('not json').reason, 'json')
  assert.equal(tryDecode('[]').reason, 'shape')
  assert.equal(tryDecode('null').reason, 'shape')
  assert.equal(tryDecode(JSON.stringify({ type: 'nope' })).reason, 'type')
  assert.equal(tryDecode(encode(C2S.HELLO, { name: 42 })).reason, 'shape')
  assert.equal(tryDecode(encode(C2S.INPUT, { seq: 1, x: 1, y: 2, z: 3, yaw: 0, pitch: 0 })).reason, 'shape')
  assert.equal(tryDecode(encode(C2S.BLOCK_EDIT, { seq: 1, x: 1.5, y: 2, z: 3, block: 1, expected: 0 })).reason, 'shape')
  assert.equal(tryDecode(encode(C2S.PING, { t: 'soon' })).reason, 'shape')
})

test('every error code has a human message', () => {
  for (const code of Object.keys(ERRORS)) {
    assert.equal(typeof ERRORS[code], 'string')
    assert.ok(ERRORS[code].length > 0)
  }
})

// ---------------------------------------------------------- name sanitising

test('sanitizeName trims, strips control characters and caps length', () => {
  assert.equal(sanitizeName('  Alice  '), 'Alice')
  // control characters are dropped, the visible text around them is kept
  assert.equal(sanitizeName('Al' + String.fromCharCode(7) + 'ice'), 'Alice')
  assert.equal(sanitizeName('Al' + String.fromCharCode(27) + '[31mice'), 'Al[31mice')
  assert.equal(sanitizeName(''), null)
  assert.equal(sanitizeName('   '), null)
  assert.equal(sanitizeName(42), null)
  assert.equal(sanitizeName('abcdefghijklmnopqrst'), 'abcdefghijklmnop')
  assert.equal(sanitizeName('邢').length, 1)
})

// ------------------------------------------------------- authoritative world

test('applyEdit is a compare-and-swap: only the matching expectation wins', () => {
  const w = new AuthoritativeWorld({ seed: 5 })
  const cell = { x: 2, y: 30, z: 2 }
  const before = w.get(cell.x, cell.y, cell.z)

  const win = w.applyEdit({ ...cell, block: B.STONE, expected: before })
  assert.equal(win.ok, true)
  assert.equal(win.block, B.STONE)
  assert.equal(w.get(cell.x, cell.y, cell.z), B.STONE)

  // second writer still believes it is air -> conflict, world untouched
  const lose = w.applyEdit({ ...cell, block: B.GLASS, expected: before })
  assert.equal(lose.ok, false)
  assert.equal(lose.code, 'conflict')
  assert.equal(lose.actual, B.STONE)
  assert.equal(w.get(cell.x, cell.y, cell.z), B.STONE)
})

test('applyEdit rejects out of bounds and illegal blocks', () => {
  const w = new AuthoritativeWorld({ seed: 5 })
  assert.equal(w.applyEdit({ x: -1, y: 0, z: 0, block: B.STONE, expected: 0 }).code, 'out_of_bounds')
  assert.equal(w.applyEdit({ x: 0, y: WORLD_Y + 5, z: 0, block: B.STONE, expected: 0 }).code, 'out_of_bounds')
  assert.equal(w.applyEdit({ x: 0, y: 1, z: 0, block: 99, expected: 0 }).code, 'bad_block')
  assert.equal(w.applyEdit({ x: 0, y: 1, z: 0, block: B.WATER, expected: 0 }).code, 'bad_block')
  // bedrock is not removable
  assert.equal(w.applyEdit({ x: 0, y: 0, z: 0, type: B.AIR, expected: B.BEDROCK }).code, 'bad_block')
})

test('edit overlay collapses repeat writes to the same cell', () => {
  const w = new AuthoritativeWorld({ seed: 5 })
  const cell = { x: 3, y: 30, z: 3 }
  const seen = new Set()
  for (let i = 0; i < 25; i++) {
    const current = w.get(cell.x, cell.y, cell.z)
    const block = i % 2 === 0 ? B.STONE : B.GLASS
    const r = w.applyEdit({ ...cell, block, expected: current })
    assert.equal(r.ok, true)
    seen.add(r.block)
  }
  assert.equal(seen.size, 2)
  assert.equal(w.editList().length, 1, 'overlay must not grow with repeat edits')
  assert.equal(w.edits.size, 1)
})

test('applyOverlay ignores junk and is idempotent', () => {
  const w = new AuthoritativeWorld({ seed: 5 })
  const applied = w.applyOverlay([
    [1, 30, 1, B.STONE],
    [1, 30, 1, B.GLASS],       // later wins
    [999, 0, 0, B.STONE],      // out of bounds
    [1, 0, 1, 12345],          // illegal type
    'nonsense',
    [2, 30, 2],                // too short
  ])
  assert.equal(applied, 2)
  assert.equal(w.get(1, 30, 1), B.GLASS)
  assert.equal(w.applyOverlay([[1, 30, 1, B.GLASS]]), 1)
  assert.equal(w.get(1, 30, 1), B.GLASS)
})

test('S2C message names are the ones the client switches on', () => {
  assert.deepEqual(
    Object.values(S2C).sort(),
    [
      'blockChanged', 'correction', 'died', 'editRejected', 'error', 'hurt', 'init',
      'mobGone', 'playerJoin', 'playerLeave', 'pong', 'respawned', 'snapshot',
    ],
  )
})

test('C2S message names are the ones the server routes', () => {
  assert.deepEqual(
    Object.values(C2S).sort(),
    ['attack', 'blockEdit', 'hello', 'input', 'ping'],
  )
})
