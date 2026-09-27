// Hotbar items: blocks and tools.
//
// Breaking stays instant (one click = one block), so a tool's benefit shows up
// as the *cooldown between breaks* on the block family it is made for, plus
// reach. The server enforces both with a grace window, so a modified client
// cannot mine faster — though there is nothing to gain by doing so.

import { B } from './blocks.js'

export const TOOL_HAND = 0
export const TOOL_PICKAXE = 1
export const TOOL_AXE = 2
export const TOOL_SHOVEL = 3
export const TOOL_SWORD = 4

/**
 * @typedef {{id:number,name:string,kind:'tool',damage:number,reach:number,cooldown:number,best:Object<string,number>}} Tool
 */

/** A sword is a weapon first: every family gets the same slow dig. */
const DIG_PENALTY = { hard: 0.45, wood: 0.45, soft: 0.45, leaf: 0.45, glass: 0.45 }
export const TOOLS = [
  { id: TOOL_PICKAXE, key: 'pickaxe', name: 'pickaxe', damage: 2, reach: 4.0, cooldown: 0.45, best: { hard: 3, glass: 3.2 } },
  { id: TOOL_AXE, key: 'axe', name: 'axe', damage: 3, reach: 4.0, cooldown: 0.5, best: { wood: 3, leaf: 2.2 } },
  { id: TOOL_SHOVEL, key: 'shovel', name: 'shovel', damage: 1, reach: 4.0, cooldown: 0.4, best: { soft: 3 } },
  { id: TOOL_SWORD, key: 'sword', name: 'sword', damage: 5, reach: 3.2, cooldown: 0.45, best: DIG_PENALTY },
]

export const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]))
export const TOOL_BY_KEY = new Map(TOOLS.map((t) => [t.key, t]))

/** Attack cooldown is per tool, in seconds. */
export const ATTACK_COOLDOWN = 0.45

/**
 * Seconds to wait before the *next* break of this block family.
 * The hand (empty slot) is deliberately slow; tools cut that time.
 */
const BREAK_TIME = {
  soft: 0.30,   // dirt / grass / sand / water
  hard: 0.60,   // stone / brick / bedrock
  wood: 0.45,
  leaf: 0.20,
  glass: 0.15,
}

export const FAMILY = {
  [B.GRASS]: 'soft',
  [B.DIRT]: 'soft',
  [B.SAND]: 'soft',
  [B.WATER]: 'soft',
  [B.STONE]: 'hard',
  [B.BRICK]: 'hard',
  [B.BEDROCK]: 'hard',
  [B.WOOD]: 'wood',
  [B.LEAVES]: 'leaf',
  [B.GLASS]: 'glass',
}

/** Multiplier a tool gets on a block family; 1 when it has no bonus. */
export function toolSpeedOn(toolId, blockId) {
  const tool = TOOL_BY_ID.get(toolId)
  if (!tool) return 1
  const family = FAMILY[blockId]
  if (!family) return 1
  return tool.best[family] ?? 1
}

/** @returns {number} seconds the player must wait before the next break */
export function breakDelay(toolId, blockId) {
  const family = FAMILY[blockId] || 'soft'
  return BREAK_TIME[family] / toolSpeedOn(toolId, blockId)
}

export function toolReach(toolId) {
  const tool = TOOL_BY_ID.get(toolId)
  return tool ? tool.reach : 3.0
}

export function toolDamage(toolId) {
  const tool = TOOL_BY_ID.get(toolId)
  return tool ? tool.damage : 1
}

export function toolCooldown(toolId) {
  const tool = TOOL_BY_ID.get(toolId)
  return tool ? tool.cooldown : ATTACK_COOLDOWN
}

export function isTool(itemId) {
  return TOOL_BY_ID.has(itemId)
}

/**
 * Hotbar layout: tools first, then blocks. Item ids are namespaced so a tool
 * id never collides with a block id (blocks are 1..10, tools are 1..4, so the
 * hotbar carries an explicit `kind` instead).
 */
export const HOTBAR = [
  { kind: 'tool', id: TOOL_PICKAXE },
  { kind: 'tool', id: TOOL_AXE },
  { kind: 'tool', id: TOOL_SHOVEL },
  { kind: 'tool', id: TOOL_SWORD },
  { kind: 'block', id: B.GRASS },
  { kind: 'block', id: B.DIRT },
  { kind: 'block', id: B.STONE },
  { kind: 'block', id: B.WOOD },
  { kind: 'block', id: B.LEAVES },
  { kind: 'block', id: B.SAND },
  { kind: 'block', id: B.GLASS },
  { kind: 'block', id: B.BRICK },
]

/** How much slack the server gives before it starts dropping too-fast edits. */
export const BREAK_GRACE = 1.6

export function isBlockItem(item) {
  return item.kind === 'block'
}

export function describeItem(item) {
  if (!item) return 'empty'
  if (item.kind === 'tool') return TOOL_BY_ID.get(item.id)?.name || 'tool'
  return `block:${item.id}`
}
