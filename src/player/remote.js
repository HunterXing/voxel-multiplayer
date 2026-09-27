// Remote players: coloured avatar + name tag, rendered from a snapshot buffer
// at (serverTime - INTERP_DELAY_MS) so movement stays smooth under jitter.

import * as THREE from 'three'
import { INTERP_DELAY_MS, EXTRAPOLATION_CAP_MS, PLAYER_MAX_HP } from '../../shared/constants.js'

const MAX_SAMPLES = 24

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function makeNameTag(name, color) {
  const font = '600 26px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  const probe = document.createElement('canvas').getContext('2d')
  probe.font = font
  const w = Math.ceil(probe.measureText(name).width) + 30
  const h = 40

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.font = font
  ctx.fillStyle = 'rgba(10,14,20,0.66)'
  roundRect(ctx, 0, 0, w, h, 9)
  ctx.fill()
  ctx.fillStyle = color
  roundRect(ctx, 7, 11, 5, h - 22, 3)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(name, 19, h / 2 + 1)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
  // world-space size: keep the tag a constant ~0.3 m tall over the head,
  // whatever the name length
  const height = 0.3
  sprite.scale.set((w / h) * height, height, 1)
  sprite.renderOrder = 10
  return sprite
}

function buildBody(color) {
  const group = new THREE.Group()
  const base = new THREE.Color(color)

  const torso = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 1.1, 0.6),
    new THREE.MeshLambertMaterial({ color: base }),
  )
  torso.position.y = 0.55

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.5, 0.5),
    new THREE.MeshLambertMaterial({ color: base.clone().multiplyScalar(1.3) }),
  )
  head.position.y = 1.35

  const face = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.16, 0.08),
    new THREE.MeshLambertMaterial({ color: 0x1b2028 }),
  )
  face.position.set(0, 1.35, -0.28)

  const legs = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.3, 0.6),
    new THREE.MeshLambertMaterial({ color: base.clone().multiplyScalar(0.7) }),
  )
  legs.position.y = 0.15

  group.add(legs, torso, head, face)
  return group
}

const HURT_COLOR = new THREE.Color('#ff5a4a')

function lerpAngle(a, b, f) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * f
}

export class RemotePlayers {
  constructor(scene) {
    this.scene = scene
    this.entities = new Map()
  }

  get count() {
    return this.entities.size
  }

  list() {
    return [...this.entities.values()].map((e) => ({
      id: e.id, name: e.name, color: e.color, x: e.x, y: e.y, z: e.z, hp: e.hp,
    }))
  }

  add({ id, name, color, x = 0, y = 0, z = 0, yaw = 0, pitch = 0, hp = PLAYER_MAX_HP }) {
    if (this.entities.has(id)) {
      this.rename(id, name, color)
      return this.entities.get(id)
    }
    const group = buildBody(color)
    group.position.set(x, y, z)
    const tag = makeNameTag(name, color)
    tag.position.y = 2.05
    group.add(tag)
    this.scene.add(group)
    const entity = { id, name, color, group, tag, buffer: [], x, y, z, yaw, pitch, hp, flash: 0 }
    this.entities.set(id, entity)
    return entity
  }

  /** Red tint for a moment after being hit. */
  flash(id) {
    const e = this.entities.get(id)
    if (e) e.flash = 0.24
  }

  setHp(id, hp) {
    const e = this.entities.get(id)
    if (e) e.hp = hp
  }

  rename(id, name, color) {
    const e = this.entities.get(id)
    if (!e || !name || e.name === name) return
    e.name = name
    e.color = color
    e.group.remove(e.tag)
    e.tag.material.map.dispose()
    e.tag.material.dispose()
    e.tag = makeNameTag(name, color)
    e.tag.position.y = 2.05
    e.group.add(e.tag)
  }

  remove(id) {
    const e = this.entities.get(id)
    if (!e) return
    this.scene.remove(e.group)
    e.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    e.tag.material.map?.dispose()
    e.tag.material.dispose()
    this.entities.delete(id)
  }

  clear() {
    for (const id of [...this.entities.keys()]) this.remove(id)
  }

  applySnapshot(list, serverTime) {
    for (const p of list) {
      if (!this.entities.has(p.id)) this.add(p)
      const e = this.entities.get(p.id)
      if (typeof p.hp === 'number') e.hp = p.hp
      e.buffer.push({ t: serverTime, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch })
      if (e.buffer.length > MAX_SAMPLES) e.buffer.shift()
    }
  }

  sampleAt(e, t) {
    const buf = e.buffer
    if (buf.length === 0) return null
    if (t <= buf[0].t) return buf[0]
    const last = buf[buf.length - 1]
    if (t >= last.t) {
      const capped = Math.min(t, last.t + EXTRAPOLATION_CAP_MS)
      const prev = buf.length >= 2 ? buf[buf.length - 2] : last
      const span = last.t - prev.t
      if (span <= 0) return last
      const f = (capped - last.t) / span
      return {
        x: last.x + (last.x - prev.x) * f,
        y: last.y + (last.y - prev.y) * f,
        z: last.z + (last.z - prev.z) * f,
        yaw: last.yaw,
        pitch: last.pitch,
      }
    }
    for (let i = buf.length - 1; i > 0; i--) {
      const b = buf[i]
      const a = buf[i - 1]
      if (t >= a.t && t <= b.t) {
        const f = (t - a.t) / (b.t - a.t || 1)
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          z: a.z + (b.z - a.z) * f,
          yaw: lerpAngle(a.yaw, b.yaw, f),
          pitch: lerpAngle(a.pitch, b.pitch, f),
        }
      }
    }
    return last
  }

  update(serverTime, dt = 0) {
    const t = serverTime - INTERP_DELAY_MS
    for (const e of this.entities.values()) {
      if (e.flash > 0) {
        e.flash = Math.max(0, e.flash - dt)
        const on = e.flash > 0
        e.group.traverse((o) => {
          if (!o.isMesh || !o.material?.color) return
          if (!o.userData.base) o.userData.base = o.material.color.clone()
          o.material.color.copy(on
            ? o.userData.base.clone().lerp(HURT_COLOR, 0.6)
            : o.userData.base)
        })
      }
      const s = this.sampleAt(e, t)
      if (!s) continue
      e.x = s.x
      e.y = s.y
      e.z = s.z
      e.yaw = s.yaw
      e.pitch = s.pitch
      e.group.position.set(s.x, s.y, s.z)
      e.group.rotation.y = s.yaw
      e.tag.position.y = 2.05
    }
  }
}
