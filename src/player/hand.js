// First person view model: what you are holding, bottom right of the screen.
//
// Parented to the camera so it rides the view, and drawn with a small emissive
// so it stays readable in shadow or underwater.

import * as THREE from 'three'
import { BLOCKS, tileFor, ATLAS_COLS, ATLAS_ROWS } from '../../shared/blocks.js'
import { TOOL_BY_KEY, TOOLS, TOOL_SWORD } from '../../shared/items.js'

const FACE_TILES = ['side', 'side', 'top', 'bottom', 'side', 'side']

/** Resting place of the view model, in camera space. */
const REST = { x: 0.30, y: -0.26, z: -0.52 }

/** BoxGeometry faces, in order: +X, -X, +Y, -Y, +Z, -Z (4 verts each). */
function remapBoxUv(geometry, blockId) {
  const uv = geometry.attributes.uv
  for (let face = 0; face < 6; face++) {
    const tile = tileFor(blockId, FACE_TILES[face])
    const col = tile % ATLAS_COLS
    const row = Math.floor(tile / ATLAS_COLS)
    for (let i = 0; i < 4; i++) {
      const idx = face * 4 + i
      uv.setXY(idx, (col + uv.getX(idx)) / ATLAS_COLS, (row + uv.getY(idx)) / ATLAS_ROWS)
    }
  }
  uv.needsUpdate = true
  return geometry
}

function blockMesh(blockId, atlas) {
  const geo = remapBoxUv(new THREE.BoxGeometry(0.26, 0.26, 0.26), blockId)
  const mat = new THREE.MeshLambertMaterial({ map: atlas, emissive: 0x333333 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.rotation.set(0.16, 0.62, 0.08)
  mesh.scale.setScalar(0.58)
  return mesh
}

const mat = (color, emissive = 0x2a2a2a) =>
  new THREE.MeshLambertMaterial({ color, emissive })

const part = (w, h, d, color, x, y, z, rx = 0, ry = 0, rz = 0) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color))
  m.position.set(x, y, z)
  m.rotation.set(rx, ry, rz)
  return m
}

const STEEL = 0xcfd6e0
const STEEL_DARK = 0x8d97a5
const HANDLE = 0x8a6a44

/**
 * Tools are built standing upright along +Y and then laid over by the caller,
 * so the parts read like the 2D hotbar icons.
 */
function toolMesh(toolId) {
  const key = TOOL_BY_KEY.get(toolId)?.key || 'sword'
  const g = new THREE.Group()

  if (key === 'sword') {
    g.add(part(0.032, 0.40, 0.014, STEEL, 0, 0.30, 0))         // blade
    g.add(part(0.040, 0.05, 0.018, STEEL_DARK, 0, 0.09, 0))    // ricasso
    g.add(part(0.19, 0.025, 0.030, HANDLE, 0, 0.055, 0))       // guard
    g.add(part(0.035, 0.10, 0.030, 0x2b2b2b, 0, -0.02, 0))     // grip
    g.add(part(0.050, 0.045, 0.040, HANDLE, 0, -0.085, 0))     // pommel
  } else if (key === 'pickaxe') {
    g.add(part(0.030, 0.44, 0.030, HANDLE, 0, 0.06, 0))        // shaft
    g.add(part(0.30, 0.045, 0.045, STEEL, 0, 0.27, 0, 0, 0, 0.42))
    g.add(part(0.030, 0.07, 0.050, HANDLE, 0, 0.23, 0))
  } else if (key === 'axe') {
    g.add(part(0.030, 0.44, 0.030, HANDLE, 0, 0.06, 0))
    g.add(part(0.13, 0.15, 0.040, STEEL, 0.055, 0.22, 0, 0, 0, 0.18))
    g.add(part(0.035, 0.16, 0.045, STEEL, 0.115, 0.20, 0))
  } else {
    // shovel
    g.add(part(0.028, 0.44, 0.028, HANDLE, 0, 0.06, 0))
    g.add(part(0.13, 0.17, 0.030, STEEL, 0, 0.30, 0))
    g.add(part(0.13, 0.02, 0.034, STEEL_DARK, 0, 0.215, 0))
  }

  g.rotation.set(0.34, -0.30, 0.30)
  g.position.set(0.02, -0.04, 0)
  g.scale.setScalar(0.68)
  return g
}

export class HandView {
  constructor(camera, atlas) {
    this.camera = camera
    this.atlas = atlas
    this.current = null
    this.group = new THREE.Group()
    this.group.position.set(0.30, -0.26, -0.52)
    camera.add(this.group)
    this.bob = 0
  }

  /** Swap the model when the hotbar selection changes. */
  setItem(item) {
    const key = item ? (item.kind === 'tool' ? `t${item.id}` : `b${item.id}`) : 'none'
    if (key === this.current) return
    this.current = key
    for (const child of [...this.group.children]) {
      this.group.remove(child)
      child.traverse?.((o) => {
        if (o.isMesh) {
          o.geometry.dispose()
          o.material.dispose()
        }
      })
    }
    if (!item) return
    const model = item.kind === 'tool' ? toolMesh(item.id) : blockMesh(item.id, this.atlas)
    this.group.add(model)
  }

  /**
   * @param {number} swing 0..1 progress of the current swing
   * @param {number} speed horizontal speed, for the walk bob
   */
  update(swing, speed, dt) {
    this.bob += dt * speed * 1.9
    const swingLift = Math.sin(swing * Math.PI)
    const idle = Math.sin(this.bob) * 0.010

    this.group.position.x = REST.x - swingLift * 0.12
    this.group.position.y = REST.y + idle - swingLift * 0.07
    this.group.position.z = REST.z + swingLift * 0.08
    this.group.rotation.x = -swingLift * 1.0
    this.group.rotation.z = -swingLift * 0.36
  }

  dispose() {
    this.camera.remove(this.group)
  }
}

export { TOOLS, TOOL_SWORD, BLOCKS }
