// WebSocket client: connect, heartbeat, and automatic reconnect with backoff.
//
// The resume token lives in sessionStorage (one per tab), so reloading a tab
// or losing the connection keeps the same player id, name and colour.

import { C2S, encode, S2C } from '../../shared/protocol.js'
import {
  RECONNECT_BASE_MS, RECONNECT_MAX_MS, PING_INTERVAL_MS, SERVER_PORT,
} from '../../shared/constants.js'

const TOKEN_KEY = 'voxel.resumeToken'
const NAME_KEY = 'voxel.playerName'

export function resolveServerUrl() {
  const fromQuery = new URLSearchParams(location.search).get('server')
  const fromEnv = import.meta.env?.VITE_SERVER_URL
  if (fromQuery) return fromQuery
  if (fromEnv) return fromEnv
  return `ws://${location.hostname}:${SERVER_PORT}`
}

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

function writeToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* private mode: play on without resume support */
  }
}

export class Connection {
  constructor({ url = resolveServerUrl(), name = 'Player', onMessage, onStatus, onOpen, onClose } = {}) {
    this.url = url
    this.name = name
    this.onMessage = onMessage || (() => {})
    this.onStatus = onStatus || (() => {})
    this.onOpen = onOpen || (() => {})
    this.onClose = onClose || (() => {})

    this.ws = null
    this.attempt = 0
    this.rtt = null
    this.clockOffset = 0
    this.reconnectTimer = null
    this.pingTimer = null
    this.state = 'idle'
  }

  get connected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  setState(state) {
    this.state = state
    this.onStatus(state)
  }

  connect() {
    if (this.ws) return
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting')
    const ws = new WebSocket(this.url)
    ws._intentional = false
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      const token = readToken()
      this.send(C2S.HELLO, { name: this.name, resumeToken: token || undefined })
      this.setState('connected')
      this.startPing()
      this.onOpen()
    }

    ws.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === S2C.PONG) {
        const now = Date.now()
        this.rtt = now - msg.t
        this.clockOffset = msg.serverTime + this.rtt / 2 - now
        return
      }
      if (msg.type === S2C.INIT && msg.resumeToken) writeToken(msg.resumeToken)
      this.onMessage(msg)
    }

    ws.onclose = () => {
      this.stopPing()
      if (this.ws === ws) this.ws = null
      this.onClose()
      if (ws._intentional) {
        this.setState('idle')
        return
      }
      this.scheduleReconnect()
    }

    ws.onerror = () => { /* onclose always follows and drives the retry */ }
  }

  /** Drop the current socket and open a fresh one (used when the name changes). */
  reconnect() {
    const old = this.ws
    if (old) {
      old._intentional = true
      try {
        old.close(1000, 'rejoin')
      } catch {
        /* already closed */
      }
    }
    this.ws = null
    this.attempt = 0
    this.connect()
  }

  scheduleReconnect() {
    this.stopPing()
    if (this.reconnectTimer) return
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS)
    const jitter = Math.random() * 250
    this.attempt++
    this.setState('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, backoff + jitter)
  }

  startPing() {
    this.stopPing()
    const beat = () => {
      if (this.connected) this.send(C2S.PING, { t: Date.now() })
    }
    beat()
    this.pingTimer = setInterval(beat, PING_INTERVAL_MS)
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  send(type, payload) {
    if (!this.connected) return false
    this.ws.send(encode(type, payload))
    return true
  }

  /** Best estimate of the server's clock, in server epoch ms. */
  serverTime() {
    return Date.now() + this.clockOffset
  }

  close() {
    this.stopPing()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.ws) {
      this.ws._intentional = true
      this.ws.close(1000, 'bye')
      this.ws = null
    }
    this.setState('closed')
  }
}

export { NAME_KEY }
