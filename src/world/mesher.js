// Chunk meshing: face culling + per-vertex smooth ambient occlusion.
//
// Deliberately NOT greedy-meshed. The world is 64x48x64 (~8k visible faces),
// which is nothing for a GPU; greedy merging would add real complexity for no
// visible gain. See README "Known limits".

import { WORLD_Y, CHUNK_SIZE } from '../../shared/constants.js'
import { ATLAS_COLS, ATLAS_ROWS, tileFor, occludes, BLOCKS } from '../../shared/blocks.js'
import { indexOf } from '../../shared/voxel.js'

// Vertex order along (u, v); cross(u, v) === n keeps the winding front-facing.
//
// u and v must have NON-NEGATIVE components: the quad is emitted at
// blockOrigin + (n > 0 ? 1 : 0) + u*s + v*t, so a negative component silently
// shifts that whole face one cell along that axis. tu/tv are the axes that
// drive the texture instead, which keeps grass_side upright no matter how the
// winding pair had to be chosen.
//
// Each row below is asserted by test/mesher.test.js: cross(u,v) === n, and
// every vertex lands on one of the block's own boundary planes.
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]]
const FACE_INDICES = [0, 1, 2, 0, 2, 3]

const FACES = [
  // +X  |  cross((0,1,0),(0,0,1)) = ( 1, 0, 0)
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], tu: [0, 0, 1], tv: [0, 1, 0], key: 'side', shade: 0.82 },
  // -X  |  cross((0,0,1),(0,1,0)) = (-1, 0, 0)
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], tu: [0, 0, 1], tv: [0, 1, 0], key: 'side', shade: 0.78 },
  // +Y  |  cross((0,0,1),(1,0,0)) = ( 0, 1, 0)
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0], tu: [1, 0, 0], tv: [0, 0, 1], key: 'top', shade: 1.0 },
  // -Y  |  cross((1,0,0),(0,0,1)) = ( 0,-1, 0)
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], tu: [1, 0, 0], tv: [0, 0, 1], key: 'bottom', shade: 0.55 },
  // +Z  |  cross((1,0,0),(0,1,0)) = ( 0, 0, 1)
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], tu: [1, 0, 0], tv: [0, 1, 0], key: 'side', shade: 0.88 },
  // -Z  |  cross((0,1,0),(1,0,0)) = ( 0, 0,-1)
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0], tu: [1, 0, 0], tv: [0, 1, 0], key: 'side', shade: 0.72 },
]

const AO_LEVELS = [0.55, 0.72, 0.86, 1.0]

const newBucket = () => ({ pos: [], nor: [], uv: [], col: [], idx: [] })
const isEmpty = (b) => b.idx.length === 0

function pushFace(bucket, world, x, y, z, face, def) {
  const { n, u, v, tu, tv, shade } = face
  const base = bucket.pos.length / 3
  const nbx = x + n[0]
  const nby = y + n[1]
  const nbz = z + n[2]
  const tile = tileFor(def.id, face.key)
  const col = tile % ATLAS_COLS
  const row = Math.floor(tile / ATLAS_COLS)
  const xBase = x + (n[0] > 0 ? 1 : 0)
  const yBase = y + (n[1] > 0 ? 1 : 0)
  const zBase = z + (n[2] > 0 ? 1 : 0)

  for (let c = 0; c < 4; c++) {
    const s = CORNERS[c][0]
    const t = CORNERS[c][1]
    const du = s ? 1 : -1
    const dv = t ? 1 : -1

    const s1 = occludes(world.get(nbx + u[0] * du, nby + u[1] * du, nbz + u[2] * du)) ? 1 : 0
    const s2 = occludes(world.get(nbx + v[0] * dv, nby + v[1] * dv, nbz + v[2] * dv)) ? 1 : 0
    const cr = occludes(world.get(
      nbx + u[0] * du + v[0] * dv,
      nby + u[1] * du + v[1] * dv,
      nbz + u[2] * du + v[2] * dv,
    )) ? 1 : 0
    const level = s1 && s2 ? 0 : 3 - (s1 + s2 + cr)
    const light = AO_LEVELS[level] * shade

    const px = xBase + u[0] * s + v[0] * t
    const py = yBase + u[1] * s + v[1] * t
    const pz = zBase + u[2] * s + v[2] * t

    // texture axes are independent of the winding pair
    const ox = px - x
    const oy = py - y
    const oz = pz - z
    const su = tu[0] * ox + tu[1] * oy + tu[2] * oz
    const sv = tv[0] * ox + tv[1] * oy + tv[2] * oz

    bucket.pos.push(px, py, pz)
    bucket.nor.push(n[0], n[1], n[2])
    bucket.uv.push((col + su) / ATLAS_COLS, (row + (1 - sv)) / ATLAS_ROWS)
    bucket.col.push(light, light, light)
  }
  for (const k of FACE_INDICES) bucket.idx.push(base + k)
}

/**
 * @returns {{opaque:object, transparent:object}} raw attribute arrays
 */
export function meshChunk(world, cx, cz) {
  const opaque = newBucket()
  const transparent = newBucket()
  const x0 = cx * CHUNK_SIZE
  const z0 = cz * CHUNK_SIZE
  const blocks = world.blocks

  for (let y = 0; y < WORLD_Y; y++) {
    for (let z = z0; z < z0 + CHUNK_SIZE; z++) {
      for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
        const id = blocks[indexOf(x, y, z)]
        if (id === 0) continue
        const def = BLOCKS[id]
        if (!def) continue
        const bucket = def.occludes ? opaque : transparent
        for (let f = 0; f < 6; f++) {
          const face = FACES[f]
          if (occludes(world.get(x + face.n[0], y + face.n[1], z + face.n[2]))) continue
          pushFace(bucket, world, x, y, z, face, def)
        }
      }
    }
  }

  return { opaque, transparent }
}

export function bucketToGeometryData(bucket) {
  if (isEmpty(bucket)) return null
  return {
    position: new Float32Array(bucket.pos),
    normal: new Float32Array(bucket.nor),
    uv: new Float32Array(bucket.uv),
    color: new Float32Array(bucket.col),
    index: new Uint32Array(bucket.idx),
    triangles: bucket.idx.length / 3,
  }
}

export { isEmpty }
