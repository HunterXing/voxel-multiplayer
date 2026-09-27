// Mesher tests. These run in plain node: the mesher has no three.js import, so
// the whole geometry pipeline is testable without a browser.

import test from 'node:test'
import assert from 'node:assert/strict'

import { meshChunk } from '../src/world/mesher.js'
import { generate } from '../shared/worldgen.js'
import { indexOf, inBounds } from '../shared/voxel.js'
import { CHUNKS_X, WORLD_Y } from '../shared/constants.js'
import { B, BLOCKS, occludes, tileFor, ATLAS_COLS, ATLAS_ROWS } from '../shared/blocks.js'

function fakeWorld(blocks) {
  return {
    blocks,
    get(x, y, z) {
      return inBounds(x, y, z) ? blocks[indexOf(x, y, z)] : B.AIR
    },
  }
}

function quads(bucket) {
  const out = []
  for (let i = 0; i < bucket.pos.length; i += 12) {
    out.push({
      n: [bucket.nor[i], bucket.nor[i + 1], bucket.nor[i + 2]],
      v: [
        [bucket.pos[i], bucket.pos[i + 1], bucket.pos[i + 2]],
        [bucket.pos[i + 3], bucket.pos[i + 4], bucket.pos[i + 5]],
        [bucket.pos[i + 6], bucket.pos[i + 7], bucket.pos[i + 8]],
        [bucket.pos[i + 9], bucket.pos[i + 10], bucket.pos[i + 11]],
      ],
      uv: [
        [bucket.uv[i * 2 / 3], bucket.uv[i * 2 / 3 + 1]],
        [bucket.uv[i * 2 / 3 + 2], bucket.uv[i * 2 / 3 + 3]],
        [bucket.uv[i * 2 / 3 + 4], bucket.uv[i * 2 / 3 + 5]],
        [bucket.uv[i * 2 / 3 + 6], bucket.uv[i * 2 / 3 + 7]],
      ],
    })
  }
  return out
}

test('a lone block emits exactly six unit quads on its own boundary planes', () => {
  const blocks = new Uint8Array(64 * WORLD_Y * 64)
  blocks[indexOf(5, 5, 5)] = B.STONE
  const r = meshChunk(fakeWorld(blocks), 0, 0)
  const qs = quads(r.opaque)

  assert.equal(qs.length, 6, 'an isolated block must show all six sides')

  for (const q of qs) {
    // the quad lies on the plane one cell out along its own normal
    const axis = q.n[0] !== 0 ? 0 : q.n[1] !== 0 ? 1 : 2
    const expected = 5 + (q.n[axis] > 0 ? 1 : 0)
    for (const v of q.v) {
      assert.equal(v[axis], expected,
        `face n=${q.n} vertex ${v} is not on plane ${axis}=${expected}`)
    }
    // and it covers the block's own cell, not a neighbour's
    for (const v of q.v) {
      for (let a = 0; a < 3; a++) {
        if (a === axis) continue
        assert.ok(v[a] === 5 || v[a] === 6, `face n=${q.n} vertex ${v} escapes the cell on axis ${a}`)
      }
    }
  }
})

test('faces are wound counter-clockwise when viewed from outside', () => {
  const blocks = new Uint8Array(64 * WORLD_Y * 64)
  blocks[indexOf(5, 5, 5)] = B.STONE
  const r = meshChunk(fakeWorld(blocks), 0, 0)

  for (const q of quads(r.opaque)) {
    const [p0, p1, p2] = q.v
    const ax = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]
    const bx = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]]
    const cross = [
      ax[1] * bx[2] - ax[2] * bx[1],
      ax[2] * bx[0] - ax[0] * bx[2],
      ax[0] * bx[1] - ax[1] * bx[0],
    ]
    assert.equal(cross[0], q.n[0])
    assert.equal(cross[1], q.n[1])
    assert.equal(cross[2], q.n[2])
  }
})

test('side textures stay upright: a grass side samples the side tile, the cap the top tile', () => {
  const blocks = new Uint8Array(64 * WORLD_Y * 64)
  blocks[indexOf(5, 5, 5)] = B.GRASS
  const r = meshChunk(fakeWorld(blocks), 0, 0)
  const qs = quads(r.opaque)

  const topCol = tileFor(B.GRASS, 'top') % ATLAS_COLS
  const sideCol = tileFor(B.GRASS, 'side') % ATLAS_COLS
  assert.notEqual(topCol, sideCol, 'this test needs the top and side tiles to differ')

  for (const q of qs) {
    const us = q.uv.map((uv) => uv[0])
    const vs = q.uv.map((uv) => uv[1])
    const minU = Math.min(...us)
    const maxU = Math.max(...us)
    const minV = Math.min(...vs)
    const maxV = Math.max(...vs)

    // exactly one tile across, and aligned to the tile grid
    assert.ok(Math.abs((maxU - minU) * ATLAS_COLS - 1) < 1e-6, `u spans ${(maxU - minU) * ATLAS_COLS} tiles`)
    assert.ok(Math.abs((maxV - minV) * ATLAS_ROWS - 1) < 1e-6, `v spans ${(maxV - minV) * ATLAS_ROWS} tiles`)
    assert.ok(Math.abs(minU * ATLAS_COLS - Math.round(minU * ATLAS_COLS)) < 1e-6, 'u is not tile aligned')
    assert.ok(Math.abs(minV * ATLAS_ROWS - Math.round(minV * ATLAS_ROWS)) < 1e-6, 'v is not tile aligned')

    const col = Math.round(minU * ATLAS_COLS)
    const row = Math.round(minV * ATLAS_ROWS)
    if (q.n[1] === 1) {
      assert.equal(col, topCol, 'the cap face must use the top tile')
    } else if (q.n[1] === -1) {
      assert.equal(col, tileFor(B.GRASS, 'bottom') % ATLAS_COLS, 'the underside must use the bottom tile')
    } else {
      assert.equal(col, sideCol, 'a side face must use the side tile')
      // the two highest vertices sit on the tile's TOP edge, so v is the row's
      // upper bound there and the lower bound at the bottom
      const upper = q.uv.filter((uv, i) => q.v[i][1] === 6)
      const lower = q.uv.filter((uv, i) => q.v[i][1] === 5)
      assert.equal(upper.length, 2)
      assert.equal(lower.length, 2)
      assert.ok(Math.abs(upper[0][1] - row / ATLAS_ROWS) < 1e-6, 'top edge of the side texture is upside down')
      assert.ok(Math.abs(lower[0][1] - (row + 1) / ATLAS_ROWS) < 1e-6, 'bottom edge of the side texture is upside down')
    }
  }
})

test('a full column emits its two caps and no interior faces', () => {
  const blocks = new Uint8Array(64 * WORLD_Y * 64)
  for (let y = 0; y < 5; y++) blocks[indexOf(5, y, 5)] = B.STONE
  const r = meshChunk(fakeWorld(blocks), 0, 0)
  const qs = quads(r.opaque)

  const caps = qs.filter((q) => q.n[1] !== 0)
  assert.equal(caps.length, 2, 'a solid column shows only the top and bottom')
  assert.deepEqual(caps.map((q) => q.n[1]).sort(), [-1, 1])

  // 4 sides x 5 blocks
  assert.equal(qs.length, 2 + 4 * 5)
})

test('neighbouring opaque blocks cull their shared face', () => {
  const blocks = new Uint8Array(64 * WORLD_Y * 64)
  blocks[indexOf(5, 5, 5)] = B.STONE
  blocks[indexOf(6, 5, 5)] = B.STONE
  const r = meshChunk(fakeWorld(blocks), 0, 0)
  const qs = quads(r.opaque)
  // 6 + 6 - 2 shared faces
  assert.equal(qs.length, 10)
  const plusX = qs.filter((q) => q.n[0] === 1)
  assert.equal(plusX.length, 1, 'only the far block keeps its +X face')
  for (const v of plusX[0].v) {
    assert.equal(v[0], 7)
    assert.ok(v[1] === 5 || v[1] === 6)
    assert.ok(v[2] === 5 || v[2] === 6)
  }
})

test('glass does not occlude, so both blocks keep their shared face', () => {
  const blocks = new Uint8Array(64 * WORLD_Y * 64)
  blocks[indexOf(5, 5, 5)] = B.STONE
  blocks[indexOf(6, 5, 5)] = B.GLASS
  const r = meshChunk(fakeWorld(blocks), 0, 0)
  // stone sees glass (not occluding) -> 6 faces
  assert.equal(quads(r.opaque).length, 6)
  // glass sees stone (occluding) -> 5 faces
  assert.equal(quads(r.transparent).length, 5)
})

test('UVs always land inside the atlas', () => {
  const world = fakeWorld(generate(1337))
  for (const [cx, cz] of [[0, 0], [1, 1], [2, 1], [3, 3]]) {
    const r = meshChunk(world, cx, cz)
    for (const bucket of [r.opaque, r.transparent]) {
      for (let i = 0; i < bucket.uv.length; i += 2) {
        const u = bucket.uv[i]
        const v = bucket.uv[i + 1]
        assert.ok(u >= 0 && u <= 1, `u ${u} out of atlas`)
        assert.ok(v >= 0 && v <= 1, `v ${v} out of atlas`)
      }
    }
  }
})

test('every quad of the real world sits on a block boundary (no shifted faces)', () => {
  const world = fakeWorld(generate(1337))
  let checked = 0
  for (const ci of [0, 5, 10, 15]) {
    const cx = ci % CHUNKS_X
    const cz = Math.floor(ci / CHUNKS_X)
    const r = meshChunk(world, cx, cz)
    for (const bucket of [r.opaque, r.transparent]) {
      for (const q of quads(bucket)) {
        // every vertex of a voxel face must land on the integer lattice
        for (const v of q.v) {
          for (let a = 0; a < 3; a++) {
            assert.ok(Number.isInteger(v[a]),
              `vertex ${v} of face n=${q.n} is off the integer lattice`)
          }
        }
        checked++
      }
    }
  }
  assert.ok(checked > 500, `expected a decent sample, got ${checked} quads`)
})

test('the whole world meshes without producing NaN or out-of-range indices', () => {
  const world = fakeWorld(generate(1337))
  let tris = 0
  for (let cz = 0; cz < 4; cz++) {
    for (let cx = 0; cx < 4; cx++) {
      const r = meshChunk(world, cx, cz)
      for (const bucket of [r.opaque, r.transparent]) {
        const verts = bucket.pos.length / 3
        assert.equal(bucket.nor.length / 3, verts)
        assert.equal(bucket.uv.length / 2, verts)
        assert.equal(bucket.col.length / 3, verts)
        assert.equal(bucket.idx.length % 6, 0)
        for (let i = 0; i < bucket.idx.length; i++) {
          assert.ok(bucket.idx[i] < verts, 'index out of range')
        }
        for (const v of bucket.pos) assert.ok(Number.isFinite(v))
        tris += bucket.idx.length / 3
      }
    }
  }
  assert.ok(tris > 10000, `expected a real world, got ${tris} triangles`)
  assert.ok(tris < 400000, `mesh looks degenerate: ${tris} triangles`)
})

test('block ids survive the round trip through the mesher', () => {
  // every placeable block must be meshable in isolation
  for (const def of BLOCKS) {
    if (def.id === B.AIR) continue
    const blocks = new Uint8Array(64 * WORLD_Y * 64)
    blocks[indexOf(3, 3, 3)] = def.id
    const r = meshChunk(fakeWorld(blocks), 0, 0)
    const total = r.opaque.idx.length + r.transparent.idx.length
    assert.equal(total, 6 * 6, `${def.name} should emit 6 quads`)
  }
})

test('occludes() marks exactly the blocks that hide a neighbour face', () => {
  assert.equal(occludes(B.AIR), false)
  assert.equal(occludes(B.WATER), false)
  assert.equal(occludes(B.GLASS), false)
  assert.equal(occludes(B.GRASS), true)
  assert.equal(occludes(B.LEAVES), true)
})
