// Test harness: boots the real server in-process on an ephemeral port and
// speaks the real wire protocol with a bare `ws` client. No mocks anywhere.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { startServer } from '../server/index.js'
import { C2S, S2C, encode } from '../shared/protocol.js'

export function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-test-'))
}

export async function startTestServer(options = {}) {
  const dataDir = options.dataDir || tempDataDir()
  const server = startServer({
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    saveIntervalMs: 1000,
    dataDir,
    ...options,
  })
  const port = await server.ready
  return { server, dataDir, url: `ws://127.0.0.1:${port}` }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class TestClient {
  constructor(url) {
    this.url = url
    this.messages = []
    this.waiters = []
    this.closed = null
    this._cursor = 0
  }

  static async connect(url, name) {
    const c = new TestClient(url)
    await c.open()
    if (name !== undefined) {
      c.send(C2S.HELLO, { name })
      await c.waitFor(S2C.INIT)
    }
    return c
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
      this.ws.on('message', (raw) => this._onMessage(raw.toString()))
      this.ws.on('close', (code, reason) => {
        this.closed = { code, reason: reason.toString() }
        for (const w of this.waiters.splice(0)) w.reject(new Error('connection closed'))
      })
    })
  }

  _onMessage(text) {
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    this.messages.push(msg)
    for (const w of [...this.waiters]) {
      if (w.predicate(msg)) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        clearTimeout(w.timer)
        this._cursor = this.messages.length
        w.resolve(msg)
      }
    }
  }

  send(type, payload) {
    this.ws.send(encode(type, payload))
  }

  sendRaw(text) {
    this.ws.send(text)
  }

  /**
   * Wait for the next message satisfying `predicate`.
   *
   * Anything already buffered but not yet consumed counts — a message that
   * arrived while the test was busy asserting is still the next one it wants.
   * `consume()` drops everything up to the returned message.
   */
  waitFor(predicate, timeout = 4000) {
    if (typeof predicate === 'string') {
      const type = predicate
      predicate = (m) => m.type === type
    }
    const buffered = this.messages.slice(this._cursor).find(predicate)
    if (buffered) {
      const at = this.messages.indexOf(buffered)
      this._cursor = at + 1
      return Promise.resolve(buffered)
    }
    return new Promise((resolve, reject) => {
      const w = { predicate, resolve, reject }
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w)
        reject(new Error(`timed out waiting for ${typeof predicate === 'string' ? predicate : 'predicate'}`))
      }, timeout)
      this.waiters.push(w)
    })
  }

  /** Everything received so far, optionally filtered. */
  all(type) {
    return type ? this.messages.filter((m) => m.type === type) : [...this.messages]
  }

  clear() {
    this.messages = []
  }

  waitClose(timeout = 4000) {
    if (this.closed) return Promise.resolve(this.closed)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for close')), timeout)
      const poll = setInterval(() => {
        if (this.closed) {
          clearTimeout(t)
          clearInterval(poll)
          resolve(this.closed)
        }
      }, 20)
    })
  }

  close() {
    if (this.closed) return Promise.resolve()
    return new Promise((resolve) => {
      this.ws.on('close', resolve)
      this.ws.close()
    })
  }
}

/**
 * Walk a headless client along a straight line at a rate the server's speed
 * clamp accepts (0.6 m per 50 ms tick is well under the ~0.79 m budget).
 *
 * The opening sleep matters: the server measures dt from the previous input,
 * and the very first one would otherwise be only milliseconds after `hello`
 * and get clamped as a teleport.
 *
 * NOTE: snapshots carry {id,x,y,z,yaw,pitch} only — names come from
 * init/playerJoin — so match players by id, not by name.
 */
export async function walkTo(client, from, to, { perTick = 0.6, interval = 50, maxTicks = 80 } = {}) {
  await sleep(interval)
  let pos = { x: from.x, y: from.y, z: from.z }
  let seq = 1
  for (let i = 0; i < maxTicks; i++) {
    const dx = to.x - pos.x
    const dz = to.z - pos.z
    const dist = Math.hypot(dx, dz)
    if (dist < 0.05) break
    const step = Math.min(perTick, dist)
    pos = { x: pos.x + (dx / dist) * step, y: pos.y, z: pos.z + (dz / dist) * step }
    client.send(C2S.INPUT, { seq: seq++, x: pos.x, y: pos.y, z: pos.z, yaw: 0, pitch: 0, t: Date.now() })
    await sleep(interval)
  }
  return pos
}

/** The server allows 5 edits/s with a 60 ms floor; keep tests inside that. */
export const EDIT_GAP_MS = 90

export { sleep, C2S, S2C }
