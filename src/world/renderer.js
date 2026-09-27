// three.js scene graph for the voxel world.
//
// One mesh per chunk column per material class (opaque / see-through), rebuilt
// lazily when a chunk is marked dirty.

import * as THREE from 'three'
import { CHUNK_COUNT, CHUNKS_X, CHUNKS_Z, CHUNK_SIZE } from '../../shared/constants.js'
import { meshChunk, bucketToGeometryData } from './mesher.js'
import { createAtlas } from './atlas.js'

function createSkyTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  const grad = ctx.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, '#3f86cf')
  grad.addColorStop(0.55, '#8fc0e8')
  grad.addColorStop(1, '#d6e7f3')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 4, 256)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export class WorldRenderer {
  constructor(container) {
    this.container = container
    this.scene = new THREE.Scene()
    this.scene.background = createSkyTexture()
    this.scene.fog = new THREE.Fog(0xc3dcf0, 48, 165)

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.08, 400)
    // The camera must be part of the scene graph, otherwise its children
    // (the first person held item) are never traversed for rendering.
    this.scene.add(this.camera)

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)

    const hemi = new THREE.HemisphereLight(0xc7dcf5, 0x55603f, 0.9)
    this.scene.add(hemi)
    const sun = new THREE.DirectionalLight(0xfff2d8, 0.7)
    sun.position.set(60, 90, 35)
    this.scene.add(sun)

    this.atlas = createAtlas()
    this.matOpaque = new THREE.MeshLambertMaterial({ map: this.atlas, vertexColors: true })
    this.matTransparent = new THREE.MeshLambertMaterial({
      map: this.atlas, vertexColors: true, transparent: true, opacity: 0.62, depthWrite: true,
    })

    this.chunks = new Map()
    this.dirty = new Set()
    this.triangles = 0
    this._onResize = () => this.resize()
    window.addEventListener('resize', this._onResize)
    this.resize()
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth
    const h = this.container.clientHeight || window.innerHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
  }

  markAll() {
    for (let ci = 0; ci < CHUNK_COUNT; ci++) this.dirty.add(ci)
  }

  markChunk(cx, cz) {
    if (cx < 0 || cx >= CHUNKS_X || cz < 0 || cz >= CHUNKS_Z) return
    this.dirty.add(cz * CHUNKS_X + cx)
  }

  /**
   * Editing a voxel changes its own faces AND, across a chunk border, the
   * faces of the neighbouring chunk's voxel. Mark those too.
   */
  markDirtyAt(x, z) {
    const cx = Math.floor(x / CHUNK_SIZE)
    const cz = Math.floor(z / CHUNK_SIZE)
    this.markChunk(cx, cz)
    const lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    const lz = ((z % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE
    if (lx === 0) this.markChunk(cx - 1, cz)
    if (lx === CHUNK_SIZE - 1) this.markChunk(cx + 1, cz)
    if (lz === 0) this.markChunk(cx, cz - 1)
    if (lz === CHUNK_SIZE - 1) this.markChunk(cx, cz + 1)
  }

  /** Rebuild every dirty chunk. Called once per frame. */
  flush(world) {
    if (this.dirty.size === 0) return
    for (const ci of this.dirty) {
      this.rebuild(world, ci, ci % CHUNKS_X, Math.floor(ci / CHUNKS_X))
    }
    this.dirty.clear()
  }

  rebuild(world, ci, cx, cz) {
    const { opaque, transparent } = meshChunk(world, cx, cz)
    let entry = this.chunks.get(ci)
    if (!entry) {
      entry = { opaque: null, transparent: null }
      this.chunks.set(ci, entry)
    }
    for (const [key, bucket] of [['opaque', opaque], ['transparent', transparent]]) {
      const data = bucketToGeometryData(bucket)
      if (data) {
        const geo = new THREE.BufferGeometry()
        geo.setAttribute('position', new THREE.BufferAttribute(data.position, 3))
        geo.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3))
        geo.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2))
        geo.setAttribute('color', new THREE.BufferAttribute(data.color, 3))
        geo.setIndex(new THREE.BufferAttribute(data.index, 1))
        geo.computeBoundingSphere()
        if (entry[key]) {
          entry[key].geometry.dispose()
          entry[key].geometry = geo
        } else {
          const mesh = new THREE.Mesh(geo, key === 'opaque' ? this.matOpaque : this.matTransparent)
          mesh.matrixAutoUpdate = false
          mesh.updateMatrix()
          this.scene.add(mesh)
          entry[key] = mesh
        }
      } else if (entry[key]) {
        this.scene.remove(entry[key])
        entry[key].geometry.dispose()
        entry[key] = null
      }
    }
  }

  add(object) {
    this.scene.add(object)
  }

  remove(object) {
    this.scene.remove(object)
  }

  render() {
    this.renderer.render(this.scene, this.camera)
  }

  countTriangles() {
    let n = 0
    for (const entry of this.chunks.values()) {
      for (const mesh of [entry.opaque, entry.transparent]) {
        if (mesh) n += mesh.geometry.index.count / 3
      }
    }
    this.triangles = n
    return n
  }

  dispose() {
    window.removeEventListener('resize', this._onResize)
    for (const entry of this.chunks.values()) {
      for (const mesh of [entry.opaque, entry.transparent]) {
        if (!mesh) continue
        this.scene.remove(mesh)
        mesh.geometry.dispose()
      }
    }
    this.chunks.clear()
    this.matOpaque.dispose()
    this.matTransparent.dispose()
    this.atlas.dispose()
    this.renderer.dispose()
  }
}
