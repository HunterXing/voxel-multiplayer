// Player registry: identity, validation, rate limiting, interest management.
//
// Everything here is synchronous and single threaded, so "atomic" simply means
// "no await in the middle of a state transition".

import { randomBytes } from 'node:crypto'
import {
  MAX_PLAYERS, MAX_SPEED, SPEED_TOLERANCE, SPEED_GRACE, SPEED_DT_CAP,
  SPEED_STRIKE_LIMIT, SPEED_STRIKE_WINDOW_MS,
  EDIT_MIN_INTERVAL_MS, EDIT_BURST, EDIT_BURST_WINDOW_MS,
  INTEREST_RADIUS, MAX_BAD_MESSAGES, WORLD_X, WORLD_Y, WORLD_Z,
  PLAYER_COLORS, INPUT_HZ, PLAYER_MAX_HP, PLAYER_REGEN_DELAY_MS, PLAYER_REGEN_PERIOD,
  PLAYER_REGEN_AMOUNT,
  RESPAWN_MS,
} from '../shared/constants.js'
import { breakDelay, BREAK_GRACE } from '../shared/items.js'

const MAX_NAME_LEN = 16
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/** How long a disconnected player keeps their identity available for a resume. */
export const RESUME_TTL_MS = 60_000

/** Trim, strip control characters, cap to 16 code points. */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(CONTROL_CHARS, '').trim()
  if (!cleaned) return null
  return [...cleaned].slice(0, MAX_NAME_LEN).join('')
}

function isOpen(socket) {
  return Boolean(socket) && socket.readyState === 1
}

export class PlayerRegistry {
  constructor({ world, interestRadius = INTEREST_RADIUS, log = console.log } = {}) {
    this.world = world
    this.interestRadius = interestRadius
    this.log = log
    this.players = new Map()
    this.byToken = new Map()
    this.bySocket = new Map()
    this.recent = new Map()
    this.nextId = 1
  }

  get size() {
    return this.players.size
  }

  all() {
    return [...this.players.values()]
  }

  get(id) {
    return this.players.get(id)
  }

  byResumeToken(token) {
    return typeof token === 'string' ? this.byToken.get(token) : undefined
  }

  forSocket(socket) {
    return this.bySocket.get(socket)
  }

  uniqueName(name) {
    const taken = new Set([...this.players.values()].map((p) => p.name))
    if (!taken.has(name)) return name
    for (let n = 2; n < 1000; n++) {
      const candidate = `${name} ${n}`
      if (!taken.has(candidate)) return candidate
    }
    return `${name} ${Date.now()}`
  }

  pickColor() {
    const taken = new Set([...this.players.values()].map((p) => p.color))
    return PLAYER_COLORS.find((c) => !taken.has(c))
      || PLAYER_COLORS[this.players.size % PLAYER_COLORS.length]
  }

  /** @returns {{ok:true,player:object,resumed:boolean}|{ok:false,code:string}} */
  add({ socket, name, resumeToken, now = Date.now() }) {
    const clean = sanitizeName(name)
    if (!clean) return { ok: false, code: 'bad_name' }

    const existing = this.byResumeToken(resumeToken)
    if (existing && existing.socket !== socket) {
      // Token replay / duplicated tab: close the stale connection, then re-point
      // the SAME player record at the new socket. detach() is wrong here — it
      // would unregister the player we are about to resume.
      this.log(`[players] ${existing.name} resumed on a new socket, dropping the old one`)
      this.closeSocket(existing, 1000, 'resumed elsewhere')
      return { ok: true, player: this.attach(existing, socket), resumed: true }
    }

    if (this.players.size >= MAX_PLAYERS) return { ok: false, code: 'server_full' }

    // A player that dropped within the resume window keeps their identity.
    const remembered = typeof resumeToken === 'string' ? this.recent.get(resumeToken) : undefined
    if (remembered && now - remembered.at < RESUME_TTL_MS) {
      this.recent.delete(resumeToken)
      // a reconnect is a fresh life: never resume into a corpse
      const back = remembered.dead ? this.world.spawn() : { x: remembered.x, y: remembered.y, z: remembered.z }
      const player = {
        ...remembered,
        socket,
        name: this.uniqueName(remembered.name),
        x: back.x, y: back.y, z: back.z,
        hp: PLAYER_MAX_HP,
        deadUntil: 0,
        lastHurtAt: 0,
        flashUntil: 0,
        editTimes: [],
        lastBreakAt: null,
        lastAttackAt: 0,
        speedStrikes: [],
        badMessages: 0,
        lastInputAt: now,
      }
      this.players.set(player.id, player)
      this.byToken.set(player.resumeToken, player)
      this.bySocket.set(socket, player)
      return { ok: true, player, resumed: true }
    }

    const spawn = this.world.spawn()
    const player = {
      id: this.nextId++,
      socket,
      name: this.uniqueName(clean),
      color: this.pickColor(),
      resumeToken: randomBytes(12).toString('hex'),
      x: spawn.x, y: spawn.y, z: spawn.z,
      yaw: 0, pitch: 0,
      seq: 0,
      lastInputAt: now,
      editTimes: [],
      lastBreakAt: null,
      lastAttackAt: 0,
      hp: PLAYER_MAX_HP,
      deadUntil: 0,
      lastHurtAt: 0,
      flashUntil: 0,
      speedStrikes: [],
      badMessages: 0,
      helloedAt: now,
    }
    this.players.set(player.id, player)
    this.byToken.set(player.resumeToken, player)
    this.bySocket.set(socket, player)
    return { ok: true, player, resumed: false }
  }

  /** Re-point an existing player at a fresh socket (resume path). */
  attach(player, socket) {
    if (player.socket) this.bySocket.delete(player.socket)
    player.socket = socket
    this.bySocket.set(socket, player)
    return player
  }

  /**
   * Remove from every index and close the socket.
   *
   * The identity is parked in `recent` for RESUME_TTL_MS so an immediate
   * reconnect keeps the same id/name/colour, while everyone else has already
   * seen the player leave (no ghost avatars while a tab is closed).
   */
  detach(player, code = 1000, reason = '') {
    if (!player) return
    this.players.delete(player.id)
    this.byToken.delete(player.resumeToken)
    if (player.socket) this.bySocket.delete(player.socket)
    this.recent.set(player.resumeToken, {
      id: player.id,
      name: player.name,
      color: player.color,
      resumeToken: player.resumeToken,
      x: player.x, y: player.y, z: player.z,
      yaw: player.yaw, pitch: player.pitch,
      dead: player.hp <= 0,
      at: Date.now(),
    })
    this.closeSocket(player, code, reason)
  }

  /** Drop resume records that nobody came back for. */
  sweepRecent(now = Date.now()) {
    for (const [token, rec] of this.recent) {
      if (now - rec.at >= RESUME_TTL_MS) this.recent.delete(token)
    }
  }

  /** Close a socket without touching registry membership. */
  closeSocket(player, code = 1000, reason = '') {
    if (!player || !player.socket) return
    if (isOpen(player.socket)) {
      try {
        player.socket.close(code, reason.slice(0, 100))
      } catch {
        /* socket already gone */
      }
    }
  }

  remove(player) {
    this.detach(player)
  }

  /** @returns {object|null} the player once they have exceeded the strike budget */
  noteBadMessage(socket) {
    const player = this.forSocket(socket)
    if (!player) return null
    player.badMessages++
    return player.badMessages >= MAX_BAD_MESSAGES ? player : null
  }

  /**
   * Accepts a position only if the delta is physically plausible.
   * The server never re-simulates physics, it just refuses impossible deltas.
   * @returns {{ok:true}|{ok:false,code:string,kick:boolean,correction:object}}
   */
  applyInput(player, msg, now = Date.now()) {
    const rawDt = player.lastInputAt ? (now - player.lastInputAt) / 1000 : 1 / INPUT_HZ
    player.lastInputAt = now
    const dt = Math.min(Math.max(rawDt, 0), SPEED_DT_CAP)

    const dx = msg.x - player.x
    const dy = msg.y - player.y
    const dz = msg.z - player.z
    const moved = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const allowed = MAX_SPEED * SPEED_TOLERANCE * dt + SPEED_GRACE

    const outOfBounds =
      msg.x < -8 || msg.x > WORLD_X + 8 ||
      msg.y < -16 || msg.y > WORLD_Y + 16 ||
      msg.z < -8 || msg.z > WORLD_Z + 8

    if (moved > allowed || outOfBounds) {
      player.speedStrikes = player.speedStrikes.filter((t) => now - t < SPEED_STRIKE_WINDOW_MS)
      player.speedStrikes.push(now)
      return {
        ok: false,
        code: 'speed',
        kick: player.speedStrikes.length >= SPEED_STRIKE_LIMIT,
        correction: { x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch },
      }
    }

    player.x = msg.x
    player.y = msg.y
    player.z = msg.z
    player.yaw = msg.yaw
    player.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, msg.pitch))
    player.seq = msg.seq
    return { ok: true }
  }

  /** Sliding window: at most EDIT_BURST accepted edits per window, min gap between them. */
  editAllowed(player, now = Date.now()) {
    player.editTimes = player.editTimes.filter((t) => now - t < EDIT_BURST_WINDOW_MS)
    if (player.editTimes.length >= EDIT_BURST) return false
    const last = player.editTimes[player.editTimes.length - 1]
    if (last !== undefined && now - last < EDIT_MIN_INTERVAL_MS) return false
    return true
  }

  recordEdit(player, now = Date.now()) {
    player.editTimes.push(now)
  }

  /**
   * Instant break, but rate limited by the tool in hand. A modified client
   * cannot mine faster than the table allows — though there is nothing to gain
   * by trying, so this is pacing, not security.
   *
   * @returns {{ok:boolean, waitMs:number}}
   */
  breakAllowed(player, blockId, toolId, now = Date.now()) {
    const waitMs = breakDelay(toolId, blockId) * BREAK_GRACE * 1000
    // null is the "never broke anything" sentinel; 0 is a real timestamp
    if (player.lastBreakAt !== null && now - player.lastBreakAt < waitMs) {
      return { ok: false, waitMs: waitMs - (now - player.lastBreakAt) }
    }
    player.lastBreakAt = now
    return { ok: true, waitMs: 0 }
  }

  /** @returns {{ok:true}|{ok:false,code:string}} */
  canAttack(player, cooldown, now = Date.now()) {
    if (player.hp <= 0) return { ok: false, code: 'dead' }
    if (now - player.lastAttackAt < cooldown * 1000) return { ok: false, code: 'too_fast' }
    return { ok: true }
  }

  markAttack(player, now = Date.now()) {
    player.lastAttackAt = now
  }

  /**
   * Apply damage to a player and resolve death.
   * @returns {{killed:boolean, hp:number}}
   */
  hurtPlayer(player, amount, now = Date.now()) {
    if (player.hp <= 0) return { killed: false, hp: 0 }
    player.hp = Math.max(0, player.hp - amount)
    player.lastHurtAt = now
    player.flashUntil = now + 200
    if (player.hp === 0) {
      player.deadUntil = now + RESPAWN_MS
      return { killed: true, hp: 0 }
    }
    return { killed: false, hp: player.hp }
  }

  /**
   * Slow out-of-combat regen, and respawn anyone whose timer expired.
   * @returns {{respawned:object[]}}
   */
  tickVitals(now = Date.now()) {
    const respawned = []
    for (const p of this.players.values()) {
      if (p.hp > 0) {
        if (p.hp < PLAYER_MAX_HP && now - p.lastHurtAt > PLAYER_REGEN_DELAY_MS) {
          p.hp = Math.min(PLAYER_MAX_HP, p.hp + PLAYER_REGEN_AMOUNT)
          p.lastHurtAt = now - PLAYER_REGEN_DELAY_MS + PLAYER_REGEN_PERIOD
        }
        continue
      }
      if (p.deadUntil && now >= p.deadUntil) {
        const spawn = this.world.spawn()
        p.x = spawn.x
        p.y = spawn.y
        p.z = spawn.z
        p.yaw = 0
        p.pitch = 0
        p.hp = PLAYER_MAX_HP
        p.deadUntil = 0
        p.lastHurtAt = now
        respawned.push(p)
      }
    }
    return { respawned }
  }

  /** Players the receiver should know about, stable order by id. */
  visibleFrom(player) {
    const r2 = this.interestRadius * this.interestRadius
    const out = []
    for (const other of this.players.values()) {
      if (other.id === player.id) continue
      const dx = other.x - player.x
      const dz = other.z - player.z
      if (dx * dx + dz * dz > r2) continue
      out.push(other)
    }
    out.sort((a, b) => a.id - b.id)
    return out
  }

  broadcastAll(raw, exceptId = -1) {
    for (const p of this.players.values()) {
      if (p.id === exceptId) continue
      if (isOpen(p.socket)) p.socket.send(raw)
    }
  }

  send(player, raw) {
    if (isOpen(player.socket)) player.socket.send(raw)
  }
}
