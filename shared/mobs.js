// Mob species. The AI itself lives in server/mobs.js — this file is only the
// data both sides need, and it must stay free of any environment API.

export const MOB_PIG = 0
export const MOB_GOAT = 1
export const MOB_CHICKEN = 2

export const MOB_KINDS = ['mob', 'player']

/**
 * halfW/height are the AABB the shared collision uses, so a mob is exactly as
 * big as it looks. `speed` is m/s, `flee` the multiplier while it is scared.
 */
export const MOBS = [
  {
    id: MOB_PIG,
    key: 'pig',
    name: 'pig',
    hp: 10,
    speed: 1.5,
    fleeSpeed: 2.4,
    halfW: 0.45,
    height: 0.9,
    body: '#eda3ab',
    accent: '#d97f8c',
    wanderIdle: [1.5, 4.0],
    wanderMove: [1.5, 3.5],
    respawnMs: [8000, 16000],
  },
  {
    id: MOB_GOAT,
    key: 'goat',
    name: 'goat',
    hp: 8,
    speed: 1.9,
    fleeSpeed: 3.4,
    halfW: 0.32,
    height: 1.0,
    body: '#ded6c4',
    accent: '#5d564a',
    wanderIdle: [0.8, 2.4],
    wanderMove: [1.0, 2.6],
    respawnMs: [10000, 20000],
  },
  {
    id: MOB_CHICKEN,
    key: 'chicken',
    name: 'chicken',
    hp: 6,
    speed: 1.2,
    fleeSpeed: 2.0,
    halfW: 0.24,
    height: 0.65,
    body: '#f2f0ea',
    accent: '#d94f4f',
    wanderIdle: [0.4, 1.4],
    wanderMove: [0.6, 1.4],
    respawnMs: [6000, 12000],
  },
]

export const MOB_BY_ID = new Map(MOBS.map((m) => [m.id, m]))
export const MOB_BY_KEY = new Map(MOBS.map((m) => [m.key, m]))

/** How many of each species the server keeps alive. */
export const MOB_POPULATION = [
  { kind: MOB_PIG, count: 7 },
  { kind: MOB_GOAT, count: 5 },
  { kind: MOB_CHICKEN, count: 6 },
]

export const MOB_COUNT = MOB_POPULATION.reduce((n, e) => n + e.count, 0)

/** Mobs are dropped a bit before they would be culled by the interest radius. */
export const MOB_SPAWN_MARGIN = 4

export const KNOCKBACK = 5.2
export const KNOCKBACK_Y = 4.4
/** Metres a *player* is pushed when hit; the server moves the body directly. */
export const PLAYER_KNOCKBACK = 0.9
