// Shared tunables. Imported by BOTH the browser client and the node server, so
// this file must stay free of any environment-specific API.

// ---------------------------------------------------------------- world shape
export const WORLD_X = 64
export const WORLD_Y = 48
export const WORLD_Z = 64
export const CHUNK_SIZE = 16
export const CHUNKS_X = WORLD_X / CHUNK_SIZE
export const CHUNKS_Z = WORLD_Z / CHUNK_SIZE
export const CHUNK_COUNT = CHUNKS_X * CHUNKS_Z
export const WATER_LEVEL = 12
export const DEFAULT_SEED = 1337

// Flat brick plaza at the centre of the map: deterministic spawn for every
// client and an easy surface for tests to edit on.
export const PLAZA = { x: 32, y: 16, z: 32, r: 4 }
// Around the plaza the terrain is carved into a flat disc, then blended back
// out to the natural height, so players spawn on open ground instead of the
// floor of a canyon.
export const SPAWN_FLAT_R = 7
export const SPAWN_BLEND_R = 20

// -------------------------------------------------------------------- players
export const MAX_PLAYERS = 8
export const PLAYER_HEIGHT = 1.8
export const PLAYER_HALF_WIDTH = 0.3
export const GRAVITY = 28
export const JUMP_SPEED = 8.4
export const WALK_SPEED = 4.5
export const SPRINT_SPEED = 6.5
export const MAX_SPEED = SPRINT_SPEED

// Server-side movement clamp: allowed = MAX_SPEED * SPEED_TOLERANCE * dt + GRACE.
// The server does NOT re-simulate physics, it only refuses impossible deltas.
export const SPEED_TOLERANCE = 1.5
export const SPEED_GRACE = 0.3
export const SPEED_DT_CAP = 0.5
export const SPEED_STRIKE_LIMIT = 5
export const SPEED_STRIKE_WINDOW_MS = 10_000

// --------------------------------------------------------------------- net
export const TICK_HZ = 20
export const INPUT_HZ = 20
export const SNAPSHOT_HZ = 15
export const INTEREST_RADIUS = 48
export const HELLO_TIMEOUT_MS = 5_000
export const PING_INTERVAL_MS = 5_000
export const MAX_BAD_MESSAGES = 3
export const MAX_PAYLOAD = 16 * 1024
export const RECONNECT_BASE_MS = 500
export const RECONNECT_MAX_MS = 8_000
export const SERVER_PORT = 8787
export const CLIENT_PORT = 5173

// ---------------------------------------------------------------- block edits
export const EDIT_MIN_INTERVAL_MS = 60
export const EDIT_BURST = 5
export const EDIT_BURST_WINDOW_MS = 1_000
export const REACH = 6

// ------------------------------------------------------------------ rendering
export const INTERP_DELAY_MS = 100
export const EXTRAPOLATION_CAP_MS = 200
export const PLAYER_COLORS = [
  '#e05c5c', '#5c9de0', '#7fd05c', '#d0a95c',
  '#a55ce0', '#5cd0b8', '#e07fb0', '#c8c85c',
]

// -------------------------------------------------------------------- combat
export const PLAYER_MAX_HP = 20
export const PLAYER_REGEN_DELAY_MS = 6_000
export const PLAYER_REGEN_PERIOD = 3_000
export const PLAYER_REGEN_AMOUNT = 1
export const RESPAWN_MS = 3_000

// ---------------------------------------------------------------- persistence
export const SAVE_INTERVAL_MS = 10_000
export const SNAPSHOT_VERSION = 1
