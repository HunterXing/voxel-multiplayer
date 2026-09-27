// Block palette. Index of the array == block id stored in the voxel array.

export const AIR = 0

/** Tile indices inside the 4x4 procedural atlas (see src/world/atlas.js). */
export const TILE = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  BARK: 4,
  LOG_TOP: 5,
  LEAVES: 6,
  SAND: 7,
  GLASS: 8,
  BRICK: 9,
  WATER: 10,
  BEDROCK: 11,
}

export const ATLAS_COLS = 4
export const ATLAS_ROWS = 4

/** Named ids, used all over worldgen / mesher / HUD. */
export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  WOOD: 4,
  LEAVES: 5,
  SAND: 6,
  GLASS: 7,
  BRICK: 8,
  WATER: 9,
  BEDROCK: 10,
}

/**
 * `tile`      -> same tile on every face
 * `top/side/bottom` -> per-face tiles
 * `occludes`  -> hides the face of a neighbouring block (false = see-through)
 * `solid`     -> blocks player movement
 * `placeable` -> players may place/remove it
 */
export const BLOCKS = [
  { id: 0, name: 'air', tile: TILE.DIRT, solid: false, occludes: false, placeable: false },
  { id: 1, name: 'grass', top: TILE.GRASS_TOP, side: TILE.GRASS_SIDE, bottom: TILE.DIRT, solid: true, occludes: true, placeable: true },
  { id: 2, name: 'dirt', tile: TILE.DIRT, solid: true, occludes: true, placeable: true },
  { id: 3, name: 'stone', tile: TILE.STONE, solid: true, occludes: true, placeable: true },
  { id: 4, name: 'wood', top: TILE.LOG_TOP, side: TILE.BARK, bottom: TILE.LOG_TOP, solid: true, occludes: true, placeable: true },
  { id: 5, name: 'leaves', tile: TILE.LEAVES, solid: true, occludes: true, placeable: true },
  { id: 6, name: 'sand', tile: TILE.SAND, solid: true, occludes: true, placeable: true },
  { id: 7, name: 'glass', tile: TILE.GLASS, solid: true, occludes: false, placeable: true },
  { id: 8, name: 'brick', tile: TILE.BRICK, solid: true, occludes: true, placeable: true },
  { id: 9, name: 'water', tile: TILE.WATER, solid: false, occludes: false, placeable: false },
  { id: 10, name: 'bedrock', tile: TILE.BEDROCK, solid: true, occludes: true, placeable: false },
]

/** Hotbar order, resolved by index 1..N on the keyboard. */
export const HOTBAR = [B.GRASS, B.DIRT, B.STONE, B.WOOD, B.LEAVES, B.SAND, B.GLASS, B.BRICK]

export function isSolid(id) {
  return id > 0 && BLOCKS[id] !== undefined && BLOCKS[id].solid === true
}

export function occludes(id) {
  return BLOCKS[id] !== undefined && BLOCKS[id].occludes === true
}

export function isPlaceable(id) {
  return Number.isInteger(id) && id > 0 && BLOCKS[id] !== undefined && BLOCKS[id].placeable === true
}

/** @param {'top'|'side'|'bottom'} face */
export function tileFor(id, face) {
  const def = BLOCKS[id] || BLOCKS[0]
  if (def.top === undefined) return def.tile
  return def[face] ?? def.side
}
