// Deterministic world generation.
//
// The SERVER owns the world, but it does not ship 196k voxels over the wire:
// it ships a seed, and the client runs this exact module to build the same
// bytes locally. Only the *edit overlay* travels over the network.
//
// Every source of randomness is either a pure hash of (seed, x, z) or a PRNG
// consumed in a fixed iteration order, so the output is byte-identical on every
// machine and every call.

import { WORLD_X, WORLD_Y, WORLD_Z, WATER_LEVEL, PLAZA, SPAWN_FLAT_R, SPAWN_BLEND_R } from './constants.js'
import { B } from './blocks.js'
import { indexOf } from './voxel.js'

/** Small, fast, deterministic PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash2(seed, xi, zi) {
  let h = (seed ^ Math.imul(xi, 0x27d4eb2d) ^ Math.imul(zi, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10)

function valueNoise2(seed, x, z) {
  const x0 = Math.floor(x)
  const z0 = Math.floor(z)
  const fx = fade(x - x0)
  const fz = fade(z - z0)
  const v00 = hash2(seed, x0, z0)
  const v10 = hash2(seed, x0 + 1, z0)
  const v01 = hash2(seed, x0, z0 + 1)
  const v11 = hash2(seed, x0 + 1, z0 + 1)
  const a = v00 + (v10 - v00) * fx
  const b = v01 + (v11 - v01) * fx
  return a + (b - a) * fz
}

/** 4 octave fractional brownian motion, returns 0..1. */
export function fbm(seed, x, z) {
  let amp = 1
  let freq = 1 / 26
  let sum = 0
  let norm = 0
  for (let o = 0; o < 4; o++) {
    sum += valueNoise2((seed + o * 1013) | 0, x * freq, z * freq) * amp
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}

/** Raw surface height (before the spawn bowl is carved), at a column. */
export function heightAt(seed, x, z) {
  const n = fbm(seed, x, z)
  // Averaged octaves cluster hard around 0.5, which yields a nearly flat plain.
  // Expanding the contrast produces real hills and a real basin below the
  // waterline instead.
  const c = Math.max(0, Math.min(1, (n - 0.5) * 2.1 + 0.5))
  return Math.max(3, Math.min(WORLD_Y - 10, Math.round(3 + c * 30)))
}

/**
 * Height after carving the spawn bowl: a flat disc, then a linear blend back
 * out to the natural terrain. Without this the plaza sits at y=16 in the
 * bottom of a canyon, because the surrounding hills reach y=33.
 */
export function spawnBowlHeight(seed, x, z) {
  const natural = heightAt(seed, x, z)
  const d = Math.max(Math.abs(x - PLAZA.x), Math.abs(z - PLAZA.z))
  if (d <= SPAWN_FLAT_R) return PLAZA.y
  if (d >= SPAWN_BLEND_R) return natural
  const t = (d - SPAWN_FLAT_R) / (SPAWN_BLEND_R - SPAWN_FLAT_R)
  return Math.round(PLAZA.y + (natural - PLAZA.y) * t)
}

/**
 * Fills `out` with the generated world. Must stay allocation free and
 * order-stable; the unit tests assert byte equality across calls.
 */
export function generateInto(seed, out) {
  out.fill(B.AIR)

  // --- 1. terrain columns, beaches and water -------------------------------
  for (let z = 0; z < WORLD_Z; z++) {
    for (let x = 0; x < WORLD_X; x++) {
      const h = spawnBowlHeight(seed, x, z)
      const beach = h <= WATER_LEVEL + 1
      for (let y = 0; y <= h; y++) {
        let t
        if (y === 0) t = B.BEDROCK
        else if (y === h) t = beach ? B.SAND : B.GRASS
        else if (y > h - 4) t = beach ? B.SAND : B.DIRT
        else t = B.STONE
        out[indexOf(x, y, z)] = t
      }
      for (let y = h + 1; y <= WATER_LEVEL; y++) {
        out[indexOf(x, y, z)] = B.WATER
      }
    }
  }

  // --- 2. trees (fixed scan order + seeded PRNG) ---------------------------
  const rand = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const taken = new Set()
  for (let z = 3; z < WORLD_Z - 3; z++) {
    for (let x = 3; x < WORLD_X - 3; x++) {
      if (rand() > 0.02) continue
      // keep the spawn field and its immediate slope clear
      if (Math.max(Math.abs(x - PLAZA.x), Math.abs(z - PLAZA.z)) <= SPAWN_FLAT_R + 1) continue
      const h = spawnBowlHeight(seed, x, z)
      if (h <= WATER_LEVEL + 1) continue
      if (out[indexOf(x, h, z)] !== B.GRASS) continue

      let clear = true
      for (let dz = -2; dz <= 2 && clear; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (taken.has(`${x + dx},${z + dz}`)) {
            clear = false
            break
          }
        }
      }
      if (!clear) continue
      taken.add(`${x},${z}`)

      const trunk = 4 + Math.floor(rand() * 3)
      for (let y = 1; y <= trunk; y++) out[indexOf(x, h + y, z)] = B.WOOD

      const topY = h + trunk
      for (let dy = -2; dy <= 1; dy++) {
        const r = dy === 1 ? 1 : 2
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx === 0 && dz === 0 && dy < 1) continue
            // trim the corners of the wide layers for a rounder canopy
            if (r > 1 && Math.abs(dx) === r && Math.abs(dz) === r) continue
            const lx = x + dx
            const ly = topY + dy
            const lz = z + dz
            if (lx < 0 || lx >= WORLD_X || ly < 0 || ly >= WORLD_Y || lz < 0 || lz >= WORLD_Z) continue
            const i = indexOf(lx, ly, lz)
            if (out[i] === B.AIR) out[i] = B.LEAVES
          }
        }
      }
    }
  }

  // --- 3. spawn plaza (last, so it always wins over trees) -----------------
  for (let dz = -PLAZA.r; dz <= PLAZA.r; dz++) {
    for (let dx = -PLAZA.r; dx <= PLAZA.r; dx++) {
      const x = PLAZA.x + dx
      const z = PLAZA.z + dz
      if (x < 0 || x >= WORLD_X || z < 0 || z >= WORLD_Z) continue
      out[indexOf(x, PLAZA.y - 1, z)] = B.DIRT
      out[indexOf(x, PLAZA.y, z)] = B.BRICK
      for (let y = PLAZA.y + 1; y < WORLD_Y; y++) out[indexOf(x, y, z)] = B.AIR
    }
  }

  return out
}

export function generate(seed) {
  const out = new Uint8Array(WORLD_X * WORLD_Y * WORLD_Z)
  return generateInto(seed, out)
}

/** Feet position of a freshly spawned player. */
export function spawnPoint() {
  return { x: PLAZA.x + 0.5, y: PLAZA.y + 1.05, z: PLAZA.z + 0.5 }
}
