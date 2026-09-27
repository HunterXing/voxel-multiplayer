// Mob rendering: low-poly box animals with a walk cycle.
//
// The server owns where a mob is; the client only derives the leg swing from
// how far it travelled, so every client animates the same animal the same way
// without any animation data on the wire.

import * as THREE from 'three'
import { MOB_BY_ID, MOB_PIG, MOB_GOAT, MOB_CHICKEN } from '../../shared/mobs.js'

const MAT = (color) => new THREE.MeshLambertMaterial({ color })

/** A box that pivots around its top edge, so it can swing like a leg. */
function limb(w, h, d, color, x, y, z) {
  const geo = new THREE.BoxGeometry(w, h, d)
  geo.translate(0, -h / 2, 0)
  const mesh = new THREE.Mesh(geo, MAT(color))
  mesh.position.set(x, y, z)
  return mesh
}

function box(w, h, d, color, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), MAT(color))
  mesh.position.set(x, y, z)
  return mesh
}

function buildPig(def) {
  const g = new THREE.Group()
  g.add(box(0.86, 0.5, 1.05, def.body, 0, 0.55, 0))
  g.add(box(0.46, 0.42, 0.42, def.body, 0, 0.62, -0.62))     // head, front is -Z
  g.add(box(0.3, 0.2, 0.1, def.accent, 0, 0.55, -0.85))        // snout
  g.add(box(0.1, 0.1, 0.06, '#2a2026', -0.14, 0.72, -0.84))   // eyes
  g.add(box(0.1, 0.1, 0.06, '#2a2026', 0.14, 0.72, -0.84))
  g.add(box(0.12, 0.14, 0.06, def.accent, -0.2, 0.86, -0.6))   // ears
  g.add(box(0.12, 0.14, 0.06, def.accent, 0.2, 0.86, -0.6))
  const legs = [
    limb(0.18, 0.32, 0.18, def.accent, -0.26, 0.42, -0.32),
    limb(0.18, 0.32, 0.18, def.accent, 0.26, 0.42, -0.32),
    limb(0.18, 0.32, 0.18, def.accent, -0.26, 0.42, 0.32),
    limb(0.18, 0.32, 0.18, def.accent, 0.26, 0.42, 0.32),
  ]
  legs.forEach((l) => g.add(l))
  return { group: g, legs }
}

function buildGoat(def) {
  const g = new THREE.Group()
  g.add(box(0.6, 0.55, 0.9, def.body, 0, 0.68, 0))
  g.add(box(0.34, 0.34, 0.4, def.body, 0, 0.82, -0.58))
  g.add(box(0.09, 0.22, 0.09, def.accent, -0.14, 1.02, -0.56))  // horns
  g.add(box(0.09, 0.22, 0.09, def.accent, 0.14, 1.02, -0.56))
  g.add(box(0.12, 0.22, 0.12, def.accent, 0, 0.58, -0.78))     // beard
  g.add(box(0.07, 0.07, 0.05, '#20242a', -0.1, 0.88, -0.78))
  g.add(box(0.07, 0.07, 0.05, '#20242a', 0.1, 0.88, -0.78))
  const legs = [
    limb(0.14, 0.42, 0.14, def.accent, -0.2, 0.62, -0.28),
    limb(0.14, 0.42, 0.14, def.accent, 0.2, 0.62, -0.28),
    limb(0.14, 0.42, 0.14, def.accent, -0.2, 0.62, 0.3),
    limb(0.14, 0.42, 0.14, def.accent, 0.2, 0.62, 0.3),
  ]
  legs.forEach((l) => g.add(l))
  return { group: g, legs }
}

function buildChicken(def) {
  const g = new THREE.Group()
  g.add(box(0.44, 0.38, 0.55, def.body, 0, 0.42, 0))
  g.add(box(0.24, 0.24, 0.24, def.body, 0, 0.7, -0.32))        // head
  g.add(box(0.07, 0.1, 0.1, def.accent, 0, 0.83, -0.32))     // comb
  g.add(box(0.1, 0.07, 0.1, '#e8a33a', 0, 0.68, -0.47))      // beak
  g.add(box(0.2, 0.22, 0.12, def.body, 0, 0.5, 0.34))        // tail
  const legs = [
    limb(0.08, 0.24, 0.08, '#e8a33a', -0.11, 0.26, -0.04),
    limb(0.08, 0.24, 0.08, '#e8a33a', 0.11, 0.26, -0.04),
  ]
  legs.forEach((l) => g.add(l))
  return { group: g, legs }
}

const BUILDERS = { [MOB_PIG]: buildPig, [MOB_GOAT]: buildGoat, [MOB_CHICKEN]: buildChicken }

function makeHealthBar() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 8
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthTest: false, transparent: true,
  }))
  sprite.scale.set(0.7, 0.09, 1)
  sprite.renderOrder = 9
  return { canvas, ctx: canvas.getContext('2d'), tex, sprite }
}

function drawHealthBar(bar, hp, maxHp) {
  const { ctx, canvas, tex } = bar
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = 'rgba(8,10,14,0.75)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  const pct = Math.max(0, Math.min(1, hp / maxHp))
  ctx.fillStyle = pct > 0.5 ? '#7ee787' : pct > 0.25 ? '#e3b341' : '#f85149'
  ctx.fillRect(1, 1, (canvas.width - 2) * pct, canvas.height - 2)
  tex.needsUpdate = true
}

export class MobView {
  constructor(scene) {
    this.scene = scene
    this.mobs = new Map()
  }

  get count() {
    return this.mobs.size
  }

  add(data) {
    if (this.mobs.has(data.id)) return this.mobs.get(data.id)
    const def = MOB_BY_ID.get(data.kind)
    if (!def) return null
    const { group, legs } = BUILDERS[data.kind](def)
    group.position.set(data.x, data.y, data.z)
    const bar = makeHealthBar()
    bar.sprite.position.y = def.height + 0.45
    bar.sprite.visible = false
    group.add(bar.sprite)
    this.scene.add(group)
    const mob = { id: data.id, kind: data.kind, def, group, legs, bar, phase: 0, lastHp: data.hp, x: data.x, z: data.z, flash: 0 }
    this.mobs.set(data.id, mob)
    return mob
  }

  remove(id) {
    const m = this.mobs.get(id)
    if (!m) return
    this.scene.remove(m.group)
    m.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose()
        o.material.dispose()
      }
    })
    m.bar.tex.dispose()
    m.bar.sprite.material.dispose()
    this.mobs.delete(id)
  }

  clear() {
    for (const id of [...this.mobs.keys()]) this.remove(id)
  }

  /** Mobs the client has never seen before, for the attacker picker. */
  list() {
    return [...this.mobs.values()].map((m) => ({
      id: m.id, kind: m.kind, x: m.x, y: m.group.position.y, z: m.z, hp: m.lastHp,
    }))
  }

  flash(id) {
    const m = this.mobs.get(id)
    if (m) m.flash = 0.22
  }

  applySnapshot(list, now) {
    for (const d of list) {
      const m = this.add(d) || this.mobs.get(d.id)
      if (!m) continue
      m.x = d.x
      m.z = d.z
      m.group.position.set(d.x, d.y, d.z)
      // the server's yaw is atan2(dirX, dirZ); models face -Z like the players
      m.group.rotation.y = d.yaw + Math.PI
      if (d.hp !== m.lastHp) {
        m.lastHp = d.hp
        m.bar.sprite.visible = d.hp < m.def.hp
        drawHealthBar(m.bar, d.hp, m.def.hp)
      }
      m.y = d.y
      m.moving = d.moving
    }
  }

  update(dt) {
    for (const m of this.mobs.values()) {
      const prevY = m.group.position.y
      const moved = Math.hypot(m.group.position.x - (m.px ?? m.group.position.x), m.group.position.z - (m.pz ?? m.group.position.z))
      m.px = m.group.position.x
      m.pz = m.group.position.z
      m.phase += moved * 5.5
      const swing = m.moving ? Math.sin(m.phase) * 0.7 : Math.sin(m.phase) * 0.06
      m.legs.forEach((leg, i) => {
        leg.rotation.x = (i % 2 === 0 ? swing : -swing)
      })
      // idle bob so a standing animal is not a statue
      m.group.position.y = prevY + (m.moving ? Math.abs(Math.sin(m.phase)) * 0.02 : 0)

      if (m.flash > 0) {
        m.flash = Math.max(0, m.flash - dt)
        const on = m.flash > 0
        m.group.traverse((o) => {
          if (o.isMesh && o.material.color) {
            if (!o.userData.base) o.userData.base = o.material.color.clone()
            o.material.color.copy(on ? o.userData.base.clone().lerp(new THREE.Color('#ff5a4a'), 0.6) : o.userData.base)
          }
        })
      }
    }
  }
}
