// Procedural texture atlas: 16x16 tiles drawn on a 4x4 canvas at runtime.
// No image assets, no network fetch, and byte-identical on every machine
// because the jitter PRNG is seeded.

import * as THREE from 'three'
import { TILE, ATLAS_COLS, ATLAS_ROWS } from '../../shared/blocks.js'
import { mulberry32 } from '../../shared/worldgen.js'

const TILE_PX = 16

function mulberry(seed) {
  return mulberry32(seed)
}

function paint(ctx, tile, fn) {
  const col = tile % ATLAS_COLS
  const row = Math.floor(tile / ATLAS_COLS)
  const img = ctx.createImageData(TILE_PX, TILE_PX)
  for (let y = 0; y < TILE_PX; y++) {
    for (let x = 0; x < TILE_PX; x++) {
      const px = fn(x, y)
      const i = (y * TILE_PX + x) * 4
      img.data[i] = px[0]
      img.data[i + 1] = px[1]
      img.data[i + 2] = px[2]
      img.data[i + 3] = px.length > 3 ? px[3] : 255
    }
  }
  ctx.putImageData(img, col * TILE_PX, row * TILE_PX)
}

const jitter = (rnd, n) => (rnd() * 2 - 1) * n
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0)

export function createAtlas() {
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_COLS * TILE_PX
  canvas.height = ATLAS_ROWS * TILE_PX
  const ctx = canvas.getContext('2d', { willReadFrequently: false })
  ctx.imageSmoothingEnabled = false

  const rnd = mulberry(0xA71A5)

  paint(ctx, TILE.GRASS_TOP, (x, y) => {
    const n = jitter(rnd, 16)
    const patch = rnd() > 0.86 ? 14 : 0
    return [clamp255(88 + n + patch), clamp255(146 + n + patch), clamp255(58 + n)]
  })

  paint(ctx, TILE.GRASS_SIDE, (x, y) => {
    const n = jitter(rnd, 14)
    if (y < 4 + (x % 3 === 0 ? 1 : 0)) {
      return [clamp255(88 + n), clamp255(146 + n), clamp255(58 + n)]
    }
    const d = jitter(rnd, 12)
    return [clamp255(126 + d), clamp255(96 + d), clamp255(62 + d)]
  })

  paint(ctx, TILE.DIRT, (x, y) => {
    const d = jitter(rnd, 18)
    const speck = rnd() > 0.9 ? -18 : 0
    return [clamp255(126 + d + speck), clamp255(96 + d + speck), clamp255(62 + d + speck)]
  })

  paint(ctx, TILE.STONE, (x, y) => {
    const d = jitter(rnd, 14)
    const crack = ((x + y) % 7 === 0 || (x * 3 + y) % 11 === 0) ? -22 : 0
    return [clamp255(128 + d + crack), clamp255(128 + d + crack), clamp255(132 + d + crack)]
  })

  paint(ctx, TILE.BARK, (x, y) => {
    const groove = x % 4 === 0 ? -26 : x % 4 === 2 ? 10 : 0
    const d = jitter(rnd, 10)
    return [clamp255(92 + groove + d), clamp255(70 + groove + d), clamp255(46 + groove + d)]
  })

  paint(ctx, TILE.LOG_TOP, (x, y) => {
    const dx = x - 7.5
    const dy = y - 7.5
    const r = Math.sqrt(dx * dx + dy * dy)
    const ring = Math.sin(r * 2.1) * 10
    const d = jitter(rnd, 6)
    return [clamp255(168 + ring + d), clamp255(138 + ring + d), clamp255(96 + ring + d)]
  })

  paint(ctx, TILE.LEAVES, (x, y) => {
    const d = jitter(rnd, 22)
    const dark = rnd() > 0.78 ? -26 : 0
    return [clamp255(52 + d + dark), clamp255(112 + d + dark), clamp255(46 + d + dark)]
  })

  paint(ctx, TILE.SAND, (x, y) => {
    const d = jitter(rnd, 12)
    return [clamp255(222 + d), clamp255(206 + d), clamp255(150 + d)]
  })

  paint(ctx, TILE.GLASS, (x, y) => {
    const border = x === 0 || y === 0 || x === TILE_PX - 1 || y === TILE_PX - 1
    const streak = (x + y === 4) || (x + y === 5) || (x - y === 9)
    if (border) return [214, 234, 242, 150]
    if (streak) return [236, 248, 252, 130]
    return [198, 228, 238, 42]
  })

  paint(ctx, TILE.BRICK, (x, y) => {
    const row = Math.floor(y / 4)
    const offset = row % 2 === 0 ? 0 : 4
    const isMortar = y % 4 === 3 || (x + offset) % 8 === 0
    const d = jitter(rnd, 10)
    if (isMortar) return [clamp255(198 + d), clamp255(190 + d), clamp255(178 + d)]
    return [clamp255(152 + d), clamp255(64 + d), clamp255(48 + d)]
  })

  paint(ctx, TILE.WATER, (x, y) => {
    const wave = Math.sin((x + y) * 0.9) * 8
    const d = jitter(rnd, 6)
    return [clamp255(48 + wave + d), clamp255(112 + wave + d), clamp255(196 + wave + d), 165]
  })

  paint(ctx, TILE.BEDROCK, (x, y) => {
    const chunk = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0) ? 14 : -12
    const d = jitter(rnd, 12)
    return [clamp255(58 + chunk + d), clamp255(58 + chunk + d), clamp255(64 + chunk + d)]
  })

  // spare slots, kept neutral
  for (let t = 12; t < ATLAS_COLS * ATLAS_ROWS; t++) {
    paint(ctx, t, () => [200, 200, 200])
  }

  const tex = new THREE.CanvasTexture(canvas)
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.colorSpace = THREE.SRGBColorSpace
  // Our UVs put v=row/4 with row 0 = canvas top, so keep the image unflipped.
  tex.flipY = false
  tex.needsUpdate = true
  return tex
}
