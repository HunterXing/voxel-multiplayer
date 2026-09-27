// Client entry point: wires connection, world, renderer, controls and HUD.

import * as THREE from 'three'
import './ui/hud.css'

import { WorldRenderer } from './world/renderer.js'
import { ClientWorld } from './world/world.js'
import { Reconciler } from './net/reconciler.js'
import { Connection, resolveServerUrl } from './net/connection.js'
import { PlayerController } from './player/controls.js'
import { RemotePlayers } from './player/remote.js'
import { MobView } from './player/mobs.js'
import { HandView } from './player/hand.js'
import { Hud } from './ui/hud.js'
import { S2C, C2S, ERRORS } from '../shared/protocol.js'
import { INPUT_HZ, PLAYER_MAX_HP } from '../shared/constants.js'
import { B, BLOCKS } from '../shared/blocks.js'
import { HOTBAR, TOOL_BY_ID, toolSpeedOn, FAMILY, isTool, breakDelay } from '../shared/items.js'
import { MOB_BY_ID } from '../shared/mobs.js'

const app = document.getElementById('app')
const hud = new Hud(document.body)
const worldRenderer = new WorldRenderer(app)
const world = new ClientWorld()
const remotes = new RemotePlayers(worldRenderer.scene)
const mobView = new MobView(worldRenderer.scene)
const controller = new PlayerController(worldRenderer.camera, worldRenderer.renderer.domElement)
// what you are holding, drawn in view space
const handView = new HandView(worldRenderer.camera, worldRenderer.atlas)
hud.onSelect = (item) => handView.setItem(item)

const serverUrl = resolveServerUrl()
const params = new URLSearchParams(location.search)
const autoJoin = params.get('autoplay') === '1'
const randomName = `Player-${Math.floor(1000 + Math.random() * 9000)}`
const defaultName = params.get('name') || randomName

let joined = false
let selfId = null
let selfName = defaultName
let selfHp = PLAYER_MAX_HP
let maxHp = PLAYER_MAX_HP
let inputSeq = 1
let attackSeq = 1
let buildMs = 0
let fps = 0
let dead = false
/** client-side pacing so breaking feels like the tool, not just the server */
let breakReadyAt = 0
let attackReadyAt = 0

// ---------------------------------------------------------------- selection

const selection = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
  new THREE.LineBasicMaterial({ color: 0x0b0f14, transparent: true, opacity: 0.85 }),
)
selection.visible = false
worldRenderer.add(selection)

// ------------------------------------------------------------- networking

const reconciler = new Reconciler({
  world,
  renderer: worldRenderer,
  send: (x, y, z, block, expected, seq) => {
    connection.send(C2S.BLOCK_EDIT, { seq, x, y, z, block, expected, tool: hud.selectedTool })
  },
})

const connection = new Connection({
  url: serverUrl,
  name: defaultName,
  onStatus: (state) => {
    hud.setStatus(state)
    hud.setJoinEnabled(state === 'connected', state === 'connected' ? 'Join' : 'Connecting…')
    if (state !== 'connected') {
      joined = false
      hud.showOverlay(true)
    }
  },
  onOpen: () => {
    // The name from ?name= already went out in the hello, so autoplay only
    // needs to get out of the way — reconnecting here would loop forever.
    hud.setJoinEnabled(true, autoJoin ? 'Joined' : 'Join')
    if (autoJoin) hud.setHint('Joining…')
  },
  onMessage: handleMessage,
})

// ------------------------------------------------------------------ routing

function handleMessage(msg) {
  switch (msg.type) {
    case S2C.INIT: return onInit(msg)
    case S2C.PLAYER_JOIN: remotes.add(msg); return syncRoster()
    case S2C.PLAYER_LEAVE: remotes.remove(msg.id); return syncRoster()
    case S2C.SNAPSHOT:
      remotes.applySnapshot(msg.players, msg.t)
      if (msg.mobs) mobView.applySnapshot(msg.mobs)
      return
    case S2C.BLOCK_CHANGED: reconciler.onBlockChanged(msg); return
    case S2C.EDIT_REJECTED:
      reconciler.onEditRejected(msg)
      hud.toast('Someone else changed that block first', 'info')
      return
    case S2C.CORRECTION:
      controller.setPosition(msg.x, msg.y, msg.z)
      controller.yaw = msg.yaw
      controller.pitch = msg.pitch
      return
    case S2C.MOB_GONE: mobView.remove(msg.id); return
    case S2C.HURT: return onHurt(msg)
    case S2C.DIED:
      if (msg.id === selfId) enterDeathState()
      return
    case S2C.RESPAWNED:
      if (msg.id === selfId) leaveDeathState(msg.hp)
      return
    case S2C.ERROR:
      // a dropped break / rejected swing is normal pacing, not a problem
      if (msg.code === 'too_fast' || msg.code === 'dead') return
      hud.toast(msg.message || ERRORS[msg.code] || msg.code)
      return
    default:
  }
}

function onHurt(msg) {
  const id = Number(msg.target.slice(1))
  const isSelf = msg.target === `p${selfId}`
  if (msg.kind === 'mob') {
    mobView.flash(id)
    return
  }
  remotes.flash(id)
  if (isSelf) {
    selfHp = msg.hp
    hud.setHealth(selfHp, maxHp)
    hud.flashHurt(msg.amount / 5)
    if (msg.killed) enterDeathState()
  }
}

function onInit(msg) {
  const t0 = performance.now()
  selfId = msg.selfId
  selfName = msg.name
  maxHp = msg.maxHp || PLAYER_MAX_HP
  selfHp = maxHp
  connection.name = msg.name

  world.generate(msg.seed)
  world.applyEdits(msg.edits)

  worldRenderer.markAll()
  worldRenderer.flush(world)
  worldRenderer.countTriangles()
  buildMs = Math.round(performance.now() - t0)

  const me = msg.players.find((p) => p.id === selfId)
  if (me) controller.setPosition(me.x, me.y, me.z)

  for (const p of msg.players) {
    if (p.id !== selfId) remotes.add(p)
  }
  if (msg.mobs) mobView.applySnapshot(msg.mobs)

  hud.attachAtlas(worldRenderer.atlas.image)
  handView.setItem(HOTBAR[hud.selected])
  hud.setHealth(selfHp, maxHp)
  hud.showOverlay(false)
  hud.setHint('Click the world to look around')
  hud.toast(`Joined as ${msg.name} · world built in ${buildMs} ms`, 'info')

  joined = true
  reconciler.reset()
  syncRoster()
}

function syncRoster() {
  const all = [{ id: selfId, name: selfName, color: '#e6edf3' }, ...remotes.list()]
  hud.updateRoster(selfId, all)
}

function enterDeathState() {
  dead = true
  controller.dead = true
  hud.setDead(true)
  hud.setHint('')
}

function leaveDeathState(hp) {
  dead = false
  controller.dead = false
  selfHp = hp || maxHp
  hud.setDead(false)
  hud.setHealth(selfHp, maxHp)
  hud.setHint('Respawned')
}

// ------------------------------------------------------------------ joining

function join() {
  const name = (hud.nameInput.value || defaultName).trim().slice(0, 16) || defaultName
  connection.name = name
  hud.showOverlay(false)
  hud.setHint('Connecting…')
  // hello carries the name and may only be sent once per socket, so a name
  // change needs a fresh connection (the resume token keeps the identity).
  connection.reconnect()
}

hud.joinBtn.addEventListener('click', join)
hud.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !hud.joinBtn.disabled) join()
})
hud.nameInput.value = defaultName

// ----------------------------------------------------------------- controls

const dom = worldRenderer.renderer.domElement
dom.addEventListener('contextmenu', (e) => e.preventDefault())

/** Mobs and other players the crosshair could be aimed at. */
function combatTargets() {
  const targets = mobView.list().map((m) => ({
    target: `m${m.id}`, x: m.x, y: m.y, z: m.z, aimY: MOB_BY_ID.get(m.kind).height * 0.5,
    label: MOB_BY_ID.get(m.kind).name,
  }))
  for (const p of remotes.list()) {
    targets.push({ target: `p${p.id}`, x: p.x, y: p.y, z: p.z, aimY: 0.9, label: p.name })
  }
  return targets
}

function tryAttack() {
  const tool = hud.selectedTool
  const target = controller.pickEntity(combatTargets(), tool)
  controller.startSwing()
  if (!target) return false
  if (Date.now() < attackReadyAt) return true
  attackReadyAt = Date.now() + 450
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(controller.camera.quaternion)
  connection.send(C2S.ATTACK, {
    seq: attackSeq++, target: target.target, tool, dir: [dir.x, dir.y, dir.z],
  })
  return true
}

dom.addEventListener('mousedown', (e) => {
  if (!joined) return
  if (!controller.locked) {
    controller.requestLock()
    return
  }
  if (dead) return

  if (e.button === 0) {
    // left click: hit whatever is in front of you, otherwise break a block
    if (tryAttack()) return
    const hit = controller.pick(world, hud.selectedTool)
    if (!hit) return
    if (Date.now() < breakReadyAt) return
    breakReadyAt = Date.now() + breakDelay(hud.selectedTool, hit.id) * 1000
    controller.startSwing()
    reconciler.requestEdit(hit.x, hit.y, hit.z, B.AIR)
    return
  }

  if (e.button === 2) {
    const block = hud.selectedBlock
    if (!block) return
    const hit = controller.pick(world, hud.selectedTool)
    if (!hit) return
    const tx = hit.x + hit.nx
    const ty = hit.y + hit.ny
    const tz = hit.z + hit.nz
    const current = world.get(tx, ty, tz)
    if (current !== B.AIR && current !== B.WATER) return
    if (overlapsPlayer(tx, ty, tz)) return
    if (Date.now() < breakReadyAt) return
    breakReadyAt = Date.now() + breakDelay(hud.selectedTool, hit.id) * 1000
    reconciler.requestEdit(tx, ty, tz, block)
  }
})

dom.addEventListener('wheel', (e) => {
  if (!joined) return
  hud.cycle(e.deltaY > 0 ? 1 : -1)
}, { passive: true })

window.addEventListener('keydown', (e) => {
  if (!joined) return
  if (e.code === 'Escape') return
  const n = Number(e.key)
  if (Number.isInteger(n) && n >= 1 && n <= HOTBAR.length) {
    hud.select(n - 1)
  }
})

controller.onLockChange = (locked) => {
  hud.setHint(locked ? '' : 'Click the world to resume')
}

/** Would a block at this cell intersect the player AABB? */
function overlapsPlayer(x, y, z) {
  const p = controller.pos
  return (
    p.x + 0.3 > x && p.x - 0.3 < x + 1
    && p.z + 0.3 > z && p.z - 0.3 < z + 1
    && p.y + 1.8 > y && p.y < y + 1
  )
}

// --------------------------------------------------------------- main loop

const timer = new THREE.Timer()
let fpsAcc = 0
let fpsFrames = 0
let inputAcc = 0
let rosterAcc = 0

function tick() {
  requestAnimationFrame(tick)
  timer.update()
  const dt = Math.min(timer.getDelta(), 0.05)

  fpsAcc += dt
  fpsFrames++
  if (fpsAcc >= 0.5) {
    fps = Math.round(fpsFrames / fpsAcc)
    fpsAcc = 0
    fpsFrames = 0
  }

  if (joined) {
    controller.update(dt, world)
    handView.update(controller.swing, Math.hypot(controller.vel.x, controller.vel.z), dt)
    remotes.update(connection.serverTime(), dt)
    mobView.update(dt)


    inputAcc += dt
    const every = 1 / INPUT_HZ
    if (inputAcc >= every) {
      inputAcc = inputAcc % every
      connection.send(C2S.INPUT, {
        seq: inputSeq++,
        x: controller.pos.x,
        y: controller.pos.y,
        z: controller.pos.z,
        yaw: controller.yaw,
        pitch: controller.pitch,
        t: connection.serverTime(),
        hp: selfHp,
        item: hud.selectedTool,
      })
    }
  }

  const tool = hud.selectedTool
  const target = joined && !dead ? controller.pickEntity(combatTargets(), tool) : null
  const hit = joined ? controller.pick(world, tool) : null

  if (target) {
    selection.visible = false
    hud.setTargetInfo(`${target.label}  ·  left click to hit`)
  } else if (hit) {
    selection.visible = true
    selection.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5)
    const speed = toolSpeedOn(tool, hit.id)
    const family = FAMILY[hit.id]
    hud.setTargetInfo(speed > 1.2
      ? `${BLOCK_NAME(hit.id)} · ${TOOL_NAME(tool)} is fast here`
      : '')
  } else {
    selection.visible = false
    hud.setTargetInfo('')
  }

  hud.setSwing(controller.swinging > 0 ? 1 - controller.swinging : 0)
  if (!joined) handView.update(0, 0, dt)

  worldRenderer.flush(world)
  worldRenderer.render()

  rosterAcc += dt
  if (rosterAcc >= 0.25) {
    rosterAcc = 0
    hud.updateStats({
      state: connection.state,
      rtt: connection.rtt,
      ping: connection.rtt,
      count: remotes.count + (joined ? 1 : 0),
      mobs: mobView.count,
      tris: worldRenderer.countTriangles(),
      pos: joined
        ? `${controller.pos.x.toFixed(1)}, ${controller.pos.y.toFixed(1)}, ${controller.pos.z.toFixed(1)}`
        : '—',
    })
  }
}

const BLOCK_NAME = (id) => BLOCKS[id]?.name || 'block'
const TOOL_NAME = (id) => (isTool(id) ? TOOL_BY_ID.get(id).name : 'bare hands')

// ------------------------------------------------------------- debug handle

window.__voxel = {
  serverUrl,
  three: { scene: worldRenderer.scene, camera: worldRenderer.camera, renderer: worldRenderer.renderer },
  getState: () => ({
    state: connection.state,
    joined,
    selfId,
    name: selfName,
    rtt: connection.rtt,
    fps,
    buildMs,
    players: remotes.count + (joined ? 1 : 0),
    pendingEdits: reconciler.pendingCount,
    worldVersion: world.version,
    seed: world.seed,
    hp: selfHp,
    dead,
    mobs: mobView.count,
  }),
  getBlock: (x, y, z) => world.get(x, y, z),
  isSolidAt: (x, y, z) => world.isSolid(x, y, z),
  getPlayers: () => remotes.list(),
  getMobs: () => mobView.list(),
  getTriangles: () => worldRenderer.triangles || worldRenderer.countTriangles(),
  /** Drive an edit from the console / automation. */
  edit: (x, y, z, block) => reconciler.requestEdit(x, y, z, block),
  /** Drive a swing from the console / automation. */
  attack: (target) => {
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(controller.camera.quaternion)
    controller.startSwing()
    return connection.send(C2S.ATTACK, {
      seq: attackSeq++, target, tool: hud.selectedTool, dir: [dir.x, dir.y, dir.z],
    })
  },
  selectSlot: (i) => { hud.select(i); return { ...HOTBAR[hud.selected], tool: hud.selectedTool, block: hud.selectedBlock } },
  getSelected: () => ({ ...HOTBAR[hud.selected], tool: hud.selectedTool, block: hud.selectedBlock }),
  getCombatTargets: () => combatTargets(),
  setLook: (yaw, pitch) => { controller.yaw = yaw; controller.pitch = pitch },
  teleport: (x, y, z) => controller.setPosition(x, y, z),
  getHealth: () => ({ hp: selfHp, max: maxHp, dead }),
  getPosition: () => ({ x: controller.pos.x, y: controller.pos.y, z: controller.pos.z }),
  hotbar: HOTBAR,
}

hud.setStatus('idle')
connection.connect()
tick()
