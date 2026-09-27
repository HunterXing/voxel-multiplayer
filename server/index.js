// Authoritative game server: raw WebSocket + JSON, one runtime dependency (ws).
//
//   node server/index.js            # PORT=8787 by default
//   PORT=9000 GAME_DATA_DIR=/tmp/x node server/index.js
//
// Exported `startServer` so tests can drive it in-process on an ephemeral port.

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'

import {
  SERVER_PORT, DEFAULT_SEED, INTEREST_RADIUS, SAVE_INTERVAL_MS, MAX_PAYLOAD,
  HELLO_TIMEOUT_MS, TICK_HZ, SNAPSHOT_HZ, INPUT_HZ, CHUNK_SIZE, MAX_PLAYERS,
  WORLD_X, WORLD_Y, WORLD_Z, PLAYER_MAX_HP,
} from '../shared/constants.js'
import { BLOCKS } from '../shared/blocks.js'
import { MOB_BY_ID, MOB_COUNT, PLAYER_KNOCKBACK } from '../shared/mobs.js'
import { toolReach, toolDamage, toolCooldown, isTool } from '../shared/items.js'
import { C2S, ERR, tryDecode, serverMsg } from '../shared/protocol.js'
import { AuthoritativeWorld } from './world.js'
import { PlayerRegistry } from './players.js'
import { Persistence } from './persistence.js'
import { MobRegistry } from './mobs.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function numEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function makeLogger(quiet) {
  if (quiet) return () => {}
  return (msg) => {
    const d = new Date()
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    console.log(`[${hh}:${mm}:${ss}] ${msg}`)
  }
}

const publicPlayer = (p) => ({
  id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
  hp: p.hp,
})

const publicMob = (m) => ({
  id: m.id, kind: m.kind, x: m.pos.x, y: m.pos.y, z: m.pos.z, yaw: m.yaw, hp: m.hp, moving: m.moving,
})

export function startServer(options = {}) {
  const port = options.port ?? numEnv('PORT', SERVER_PORT)
  const host = options.host ?? process.env.HOST ?? '0.0.0.0'
  const dataDir = options.dataDir ?? process.env.GAME_DATA_DIR ?? path.join(HERE, 'data')
  const seed = options.seed ?? numEnv('SEED', DEFAULT_SEED)
  const interestRadius = options.interestRadius ?? numEnv('INTEREST_RADIUS', INTEREST_RADIUS)
  const saveIntervalMs = options.saveIntervalMs ?? numEnv('SAVE_INTERVAL_MS', SAVE_INTERVAL_MS)
  const log = options.log ?? makeLogger(options.quiet)

  const world = new AuthoritativeWorld({ seed })
  const persistence = new Persistence({ world, dataDir, intervalMs: saveIntervalMs, log })
  persistence.load()
  const players = new PlayerRegistry({ world, interestRadius, log })
  const mobs = new MobRegistry({ world, log })

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`voxel server\nseed=${world.seed}\nplayers=${players.size}/${MAX_PLAYERS}\nedits=${world.edits.size}\n`)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found\n')
  })

  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD })
  const send = (socket, raw) => {
    if (socket && socket.readyState === 1) socket.send(raw)
  }
  const fail = (socket, code) => send(socket, serverMsg.error(code))

  // ---------------------------------------------------------------- handlers

  function handleHello(socket, msg) {
    const existing = players.forSocket(socket)
    if (existing) {
      const offender = players.noteBadMessage(socket)
      fail(socket, ERR.BAD_MESSAGE)
      if (offender) socket.close(1008, 'duplicate hello')
      return
    }

    const result = players.add({ socket, name: msg.name, resumeToken: msg.resumeToken })
    if (!result.ok) {
      fail(socket, result.code)
      socket.close(1008, result.code)
      return
    }

    const me = result.player
    clearTimeout(socket._helloTimer)

    send(socket, serverMsg.init({
      selfId: me.id,
      resumeToken: me.resumeToken,
      name: me.name,
      seed: world.seed,
      world: { x: WORLD_X, y: WORLD_Y, z: WORLD_Z, chunk: CHUNK_SIZE },
      players: players.all().map(publicPlayer),
      mobs: mobs.visibleFrom(me.x, me.z, players.interestRadius * 2).map(publicMob),
      edits: world.editList(),
      palette: BLOCKS.map((b) => ({ id: b.id, name: b.name })),
      rates: { input: INPUT_HZ, snapshot: SNAPSHOT_HZ, interestRadius: players.interestRadius },
      maxHp: PLAYER_MAX_HP,
      serverTime: Date.now(),
    }))

    // Others dropped our entity when we disconnected, so always re-announce.
    players.broadcastAll(serverMsg.playerJoin(publicPlayer(me)), me.id)
    log(`join  #${me.id} ${me.name} (${players.size} online${result.resumed ? ', resumed' : ''})`)
  }

  function handleInput(socket, msg) {
    const me = players.forSocket(socket)
    if (!me) return fail(socket, ERR.NOT_HELLOED)

    // Cheap flood guard: far above the 20 Hz the protocol asks for.
    const now = Date.now()
    socket._inputCount = (socket._inputCount || 0) + 1
    if (now - (socket._inputWindow || 0) > 1000) {
      socket._inputWindow = now
      socket._inputCount = 1
    }
    if (socket._inputCount > 60) return

    const res = players.applyInput(me, msg, now)
    if (res.ok) return
    fail(socket, ERR.SPEED)
    send(socket, serverMsg.correction(res.correction))
    if (res.kick) {
      log(`kick  #${me.id} ${me.name}: repeated movement violations`)
      socket.close(1008, 'speed')
    }
  }

  function handleBlockEdit(socket, msg) {
    const me = players.forSocket(socket)
    if (!me) return fail(socket, ERR.NOT_HELLOED)
    if (me.hp <= 0) return fail(socket, ERR.DEAD)

    const now = Date.now()
    if (!players.editAllowed(me, now)) return fail(socket, ERR.RATE_LIMITED)

    // instant break, paced by the tool: check against the block that is
    // actually there, since that is what the player is looking at
    const target = world.get(msg.x, msg.y, msg.z)
    if (!players.breakAllowed(me, target, msg.tool || 0, now)) return

    const res = world.applyEdit(msg)
    if (!res.ok) {
      if (res.code === ERR.CONFLICT) {
        // Somebody else won the race. Tell the loser the truth so both sides
        // converge on the server's value in the same frame.
        send(socket, serverMsg.editRejected({
          seq: msg.seq, x: msg.x, y: msg.y, z: msg.z, actual: res.actual, reason: ERR.CONFLICT,
        }))
      } else {
        fail(socket, res.code)
      }
      return
    }

    players.recordEdit(me, now)
    players.broadcastAll(serverMsg.blockChanged({
      x: msg.x, y: msg.y, z: msg.z, block: res.block, by: me.id, seq: msg.seq,
    }))
  }

  /**
   * Combat. The client says "I swung at this target with this tool"; the server
   * decides whether that is plausible (alive, off cooldown, in reach) and owns
   * every consequence: damage, knockback, death, respawn.
   */
  function handleAttack(socket, msg) {
    const me = players.forSocket(socket)
    if (!me) return fail(socket, ERR.NOT_HELLOED)

    const now = Date.now()
    const tool = isTool(msg.tool) ? msg.tool : 0
    const gate = players.canAttack(me, toolCooldown(tool), now)
    if (!gate.ok) return fail(socket, gate.code)
    players.markAttack(me, now)

    const reach = toolReach(tool)
    const damage = toolDamage(tool)
    const from = { x: me.x, y: me.y + 1.6, z: me.z }
    const [dx, dy, dz] = msg.dir
    const dirLen = Math.hypot(dx, dy, dz) || 1
    const dir = { x: dx / dirLen, y: dy / dirLen, z: dz / dirLen }

    if (msg.target.startsWith('m')) {
      const res = mobs.hitMob({ id: Number(msg.target.slice(1)), fromId: me.id, from, reach, damage, now, players })
      if (!res.ok) return fail(socket, res.code)
      players.broadcastAll(serverMsg.hurt({
        target: `m${res.mob.id}`, kind: 'mob', amount: damage, from: me.id,
        hp: res.killed ? 0 : res.mob.hp, killed: res.killed, dir,
      }))
      if (res.killed) {
        players.broadcastAll(serverMsg.mobGone({ id: res.mob.id }))
        log(`kill  ${me.name} killed a ${MOB_BY_ID.get(res.mob.kind).name}`)
      }
      return
    }

    const victimId = Number(msg.target.slice(1))
    const victim = players.get(victimId)
    if (!victim || victim.hp <= 0) return fail(socket, ERR.BAD_TARGET)

    const hit = players.hurtPlayer(victim, damage, now)
    // broadcast to the attacker too: you want to see the thing you hit flinch
    players.broadcastAll(serverMsg.hurt({
      target: `p${victimId}`, kind: 'player', amount: damage, from: me.id,
      hp: hit.hp, killed: hit.killed, dir,
    }))

    if (!hit.killed) {
      // knock the victim back: the server moves the authoritative body and the
      // client is told, so the speed clamp never fights the push
      const vdx = victim.x - me.x
      const vdz = victim.z - me.z
      const len = Math.hypot(vdx, vdz) || 1
      victim.x += (vdx / len) * PLAYER_KNOCKBACK
      victim.z += (vdz / len) * PLAYER_KNOCKBACK
      players.send(victim, serverMsg.correction({
        x: victim.x, y: victim.y, z: victim.z, yaw: victim.yaw, pitch: victim.pitch,
      }))
      return
    }

    // death: the body stays where it fell; tickVitals respawns it
    log(`kill  ${me.name} killed ${victim.name}`)
    players.broadcastAll(serverMsg.died({ id: victimId, by: me.id }))
  }

  function onMessage(socket, raw) {
    const decoded = tryDecode(raw.toString())
    if (!decoded.ok) {
      const offender = players.noteBadMessage(socket)
      fail(socket, ERR.BAD_MESSAGE)
      if (offender) {
        log(`kick  #${offender.id} ${offender.name}: ${decoded.reason} messages`)
        socket.close(1008, 'bad messages')
      }
      return
    }
    const msg = decoded.msg
    switch (msg.type) {
      case C2S.HELLO: return handleHello(socket, msg)
      case C2S.INPUT: return handleInput(socket, msg)
      case C2S.BLOCK_EDIT: return handleBlockEdit(socket, msg)
      case C2S.ATTACK: return handleAttack(socket, msg)
      case C2S.PING: return send(socket, serverMsg.pong({ t: msg.t, serverTime: Date.now() }))
      default: return fail(socket, ERR.BAD_MESSAGE)
    }
  }

  wss.on('connection', (socket) => {
    socket._helloTimer = setTimeout(() => {
      if (!players.forSocket(socket)) {
        fail(socket, ERR.NOT_HELLOED)
        socket.close(1008, 'hello timeout')
      }
    }, HELLO_TIMEOUT_MS)

    socket.on('message', (raw) => {
      try {
        onMessage(socket, raw)
      } catch (err) {
        log(`error while handling a message: ${err.stack || err}`)
        fail(socket, ERR.BAD_MESSAGE)
      }
    })
    socket.on('close', () => {
      clearTimeout(socket._helloTimer)
      const me = players.forSocket(socket)
      if (!me) return
      players.remove(me)
      players.broadcastAll(serverMsg.playerLeave({ id: me.id }))
      log(`leave #${me.id} ${me.name} (${players.size} online)`)
    })
    socket.on('error', () => { /* close handler does the cleanup */ })
  })

  // ------------------------------------------------------------- tick / loop

  let lastSnapshot = 0
  let lastTick = Date.now()
  const snapshotEvery = 1000 / SNAPSHOT_HZ
  const tickTimer = setInterval(() => {
    const now = Date.now()
    // clamp dt so a stalled event loop cannot teleport mobs across the world
    const dt = Math.min(Math.max((now - lastTick) / 1000, 0), 0.25)
    lastTick = now

    mobs.update(dt, players, now)
    const { respawned } = players.tickVitals(now)
    for (const p of respawned) {
      // the respawning player MUST get this too, or their client stays on the
      // death screen forever
      players.send(p, serverMsg.respawned({ id: p.id, hp: p.hp }))
      players.broadcastAll(serverMsg.respawned({ id: p.id, hp: p.hp }), p.id)
      players.send(p, serverMsg.correction({ x: p.x, y: p.y, z: p.z, yaw: 0, pitch: 0 }))
    }
    players.sweepRecent(now)

    if (now - lastSnapshot < snapshotEvery) return
    lastSnapshot = now
    for (const me of players.all()) {
      const list = players.visibleFrom(me).map((o) => ({
        id: o.id, x: o.x, y: o.y, z: o.z, yaw: o.yaw, pitch: o.pitch, hp: o.hp,
      }))
      const mobList = mobs.visibleFrom(me.x, me.z, players.interestRadius * 2).map(publicMob)
      players.send(me, serverMsg.snapshot({ t: now, players: list, mobs: mobList }))
    }
  }, 1000 / TICK_HZ)
  tickTimer.unref?.()

  persistence.start()

  // ------------------------------------------------------------------ boot

  const ready = new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject)
      const actual = httpServer.address().port
      log(`voxel server on ws://${host}:${actual}  seed=${world.seed}  world=${WORLD_X}x${WORLD_Y}x${WORLD_Z}  interest=${interestRadius}  data=${dataDir}`)
      resolve(actual)
    })
  })

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    clearInterval(tickTimer)
    for (const p of players.all()) {
      try {
        p.socket.terminate()
      } catch { /* already dead */ }
    }
    players.players.clear()
    players.byToken.clear()
    players.bySocket.clear()
    players.recent.clear()
    persistence.stop()
    await new Promise((resolve) => {
      const guard = setTimeout(resolve, 1000)
      wss.close(() => {
        clearTimeout(guard)
        resolve()
      })
    })
    await new Promise((resolve) => httpServer.close(() => resolve()))
    log('server closed, world saved')
  }

  return {
    world, players, mobs, persistence, wss, httpServer, ready, close, log,
    get port() {
      const addr = httpServer.address()
      return typeof addr === 'object' && addr ? addr.port : port
    },
  }
}

// ------------------------------------------------------------------- runnable

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const server = startServer()
  await server.ready
  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    server.log(`received ${signal}, saving world and exiting`)
    await server.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
