// All DOM UI. Plain elements + CSS, no framework.

import { BLOCKS, ATLAS_COLS, tileFor } from '../../shared/blocks.js'
import { HOTBAR, TOOL_BY_ID, toolSpeedOn, FAMILY } from '../../shared/items.js'
import { PLAYER_MAX_HP } from '../../shared/constants.js'

const el = (tag, className, html) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (html !== undefined) node.innerHTML = html
  return node
}

/**
 * Tool icons, drawn to fill a 64x64 canvas so they read at 32px in the hotbar
 * instead of turning into hairlines.
 */
const STEEL = '#d7dde6'
const STEEL_DARK = '#9aa3b0'
const WOOD = '#a87c4e'
const WOOD_DARK = '#7a5732'

const TOOL_ICONS = {
  pickaxe: (ctx) => {
    ctx.strokeStyle = WOOD
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.moveTo(12, 52)
    ctx.lineTo(38, 24)
    ctx.stroke()
    ctx.strokeStyle = STEEL
    ctx.lineWidth = 8
    ctx.beginPath()
    ctx.moveTo(20, 12)
    ctx.quadraticCurveTo(44, 10, 54, 30)
    ctx.stroke()
    ctx.strokeStyle = STEEL_DARK
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(26, 13)
    ctx.quadraticCurveTo(44, 13, 51, 27)
    ctx.stroke()
    ctx.fillStyle = WOOD_DARK
    ctx.beginPath()
    ctx.arc(11, 53, 5, 0, Math.PI * 2)
    ctx.fill()
  },
  axe: (ctx) => {
    ctx.strokeStyle = WOOD
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.moveTo(18, 54)
    ctx.lineTo(30, 26)
    ctx.stroke()
    ctx.fillStyle = STEEL
    ctx.beginPath()
    ctx.moveTo(26, 6)
    ctx.lineTo(54, 14)
    ctx.lineTo(48, 34)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = STEEL_DARK
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(30, 9)
    ctx.lineTo(50, 15)
    ctx.stroke()
  },
  shovel: (ctx) => {
    ctx.strokeStyle = WOOD
    ctx.lineWidth = 7
    ctx.beginPath()
    ctx.moveTo(32, 22)
    ctx.lineTo(32, 54)
    ctx.stroke()
    ctx.fillStyle = STEEL
    ctx.beginPath()
    ctx.moveTo(18, 4)
    ctx.lineTo(46, 4)
    ctx.lineTo(38, 24)
    ctx.lineTo(26, 24)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = STEEL_DARK
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.moveTo(22, 8)
    ctx.lineTo(42, 8)
    ctx.stroke()
  },
  sword: (ctx) => {
    ctx.strokeStyle = STEEL
    ctx.lineWidth = 8
    ctx.beginPath()
    ctx.moveTo(12, 52)
    ctx.lineTo(46, 16)
    ctx.stroke()
    ctx.strokeStyle = STEEL_DARK
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(14, 49)
    ctx.lineTo(44, 17)
    ctx.stroke()
    ctx.strokeStyle = WOOD
    ctx.lineWidth = 6
    ctx.beginPath()
    ctx.moveTo(8, 40)
    ctx.lineTo(20, 56)
    ctx.stroke()
    ctx.fillStyle = WOOD_DARK
    ctx.beginPath()
    ctx.arc(7, 57, 5, 0, Math.PI * 2)
    ctx.fill()
  },
}

function toolIcon(name) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  TOOL_ICONS[name]?.(ctx)
  return canvas
}

export class Hud {
  constructor(root) {
    this.root = root
    this.selected = 0
    this.toastTimer = null

    const ui = el('div')
    ui.id = 'ui'
    root.appendChild(ui)
    this.ui = ui

    this.crosshair = el('div')
    this.crosshair.id = 'crosshair'
    ui.appendChild(this.crosshair)

    // --- roster ------------------------------------------------------------
    this.roster = el('div', 'panel')
    this.roster.id = 'roster'
    ui.appendChild(this.roster)

    // --- stats -------------------------------------------------------------
    this.stats = el('div', 'panel')
    this.stats.id = 'stats'
    ui.appendChild(this.stats)

    // --- hotbar ------------------------------------------------------------
    this.hotbar = el('div')
    this.hotbar.id = 'hotbar'
    ui.appendChild(this.hotbar)
    this.slots = HOTBAR.map((item, i) => {
      const slot = el('div', `slot ${item.kind === 'tool' ? 'tool' : ''}`)
      slot.appendChild(el('span', 'num', String(i + 1)))
      if (item.kind === 'tool') {
        const icon = toolIcon(TOOL_BY_ID.get(item.id).key)
        slot.appendChild(icon)
      } else {
        slot.appendChild(el('canvas'))
      }
      slot.appendChild(el('span', 'name', item.kind === 'tool'
        ? TOOL_BY_ID.get(item.id).name
        : BLOCKS[item.id].name))
      slot.addEventListener('click', () => this.select(i))
      this.hotbar.appendChild(slot)
      return slot
    })

    // --- health / combat ---------------------------------------------------
    this.health = el('div')
    this.health.id = 'health'
    this.health.innerHTML = `<div class="hp-bar"><div class="hp-fill"></div></div><div class="hp-text"></div>`
    ui.appendChild(this.health)
    this.hpFill = this.health.querySelector('.hp-fill')
    this.hpText = this.health.querySelector('.hp-text')

    this.hurtFlash = el('div')
    this.hurtFlash.id = 'hurt-flash'
    ui.appendChild(this.hurtFlash)

    this.swingBar = el('div')
    this.swingBar.id = 'swing'
    ui.appendChild(this.swingBar)

    this.deathOverlay = el('div', 'hidden')
    this.deathOverlay.id = 'death'
    this.deathOverlay.innerHTML = '<div class="death-card"><h2>You died</h2><p class="respawn">respawning…</p></div>'
    root.appendChild(this.deathOverlay)

    this.toastEl = el('div')
    this.toastEl.id = 'toast'
    ui.appendChild(this.toastEl)

    this.hint = el('div')
    this.hint.id = 'hint'
    ui.appendChild(this.hint)

    this.targetInfo = el('div')
    this.targetInfo.id = 'target-info'
    ui.appendChild(this.targetInfo)

    // --- join overlay ------------------------------------------------------
    this.overlay = el('div')
    this.overlay.id = 'overlay'
    this.overlay.innerHTML = `
      <div class="card">
        <h1>Voxel Sandbox</h1>
        <p class="sub">Authoritative node server &middot; three.js client &middot; up to 8 players</p>
        <div class="field">
          <input id="name-input" maxlength="16" placeholder="Your name" autocomplete="off" />
          <button class="primary" id="join-btn" disabled>Connecting&hellip;</button>
        </div>
        <div class="actions" id="overlay-status"></div>
        <div class="keys">
          <table>
            <tr><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd></td><td>Move</td></tr>
            <tr><td><kbd>Space</kbd></td><td>Jump / swim up</td></tr>
            <tr><td><kbd>Shift</kbd></td><td>Sprint</td></tr>
            <tr><td>Left click</td><td>Hit a mob or player, else break a block</td></tr>
            <tr><td>Right click</td><td>Place a block</td></tr>
            <tr><td><kbd>1</kbd>&ndash;<kbd>8</kbd> / wheel</td><td>Select tool or block</td></tr>
            <tr><td><kbd>Esc</kbd></td><td>Release mouse</td></tr>
          </table>
        </div>
      </div>`
    root.appendChild(this.overlay)

    this.nameInput = this.overlay.querySelector('#name-input')
    this.joinBtn = this.overlay.querySelector('#join-btn')
    this.overlayStatus = this.overlay.querySelector('#overlay-status')

    this.onSelect = null
    this.select(0)
  }

  /** 32x32 block swatch cropped straight out of the runtime atlas. */
  swatch(id, atlasImage) {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    if (atlasImage) {
      const tile = tileFor(id, 'side')
      const col = tile % ATLAS_COLS
      const row = Math.floor(tile / ATLAS_COLS)
      ctx.drawImage(atlasImage, col * 16, row * 16, 16, 16, 0, 0, 32, 32)
    } else {
      ctx.fillStyle = '#3d444d'
      ctx.fillRect(0, 0, 32, 32)
    }
    return canvas
  }

  /** Re-draw the block swatches once the atlas exists. */
  attachAtlas(atlasImage) {
    this.slots.forEach((slot, i) => {
      const item = HOTBAR[i]
      if (item.kind !== 'block') return
      const old = slot.querySelector('canvas')
      if (old) slot.replaceChild(this.swatch(item.id, atlasImage), old)
    })
  }

  select(index) {
    this.selected = ((index % HOTBAR.length) + HOTBAR.length) % HOTBAR.length
    this.slots.forEach((s, i) => s.classList.toggle('active', i === this.selected))
    const item = HOTBAR[this.selected]
    this.onSelect?.(item)
    return item
  }

  get selectedItem() {
    return HOTBAR[this.selected]
  }

  get selectedTool() {
    const item = HOTBAR[this.selected]
    return item.kind === 'tool' ? item.id : 0
  }

  get selectedBlock() {
    const item = HOTBAR[this.selected]
    return item.kind === 'block' ? item.id : 0
  }

  cycle(delta) {
    return this.select(this.selected + delta)
  }

  setHint(text) {
    this.hint.textContent = text || ''
    this.hint.style.display = text ? '' : 'none'
  }

  /** Red vignette when the local player is hit. */
  flashHurt(strength = 1) {
    this.hurtFlash.style.opacity = String(Math.min(0.55, 0.28 * strength))
    clearTimeout(this._hurtTimer)
    this._hurtTimer = setTimeout(() => { this.hurtFlash.style.opacity = '0' }, 180)
  }

  setHealth(hp, maxHp = PLAYER_MAX_HP) {
    const pct = Math.max(0, Math.min(1, hp / maxHp))
    this.hpFill.style.width = `${pct * 100}%`
    this.hpFill.style.background = pct > 0.5 ? '#7ee787' : pct > 0.25 ? '#e3b341' : '#f85149'
    this.hpText.textContent = `${Math.ceil(hp)} / ${maxHp}`
  }

  setDead(dead) {
    this.deathOverlay.classList.toggle('hidden', !dead)
  }

  setSwing(progress) {
    if (progress <= 0) {
      this.swingBar.style.opacity = '0'
      return
    }
    this.swingBar.style.opacity = '1'
    this.swingBar.style.transform = `translateX(-50%) scaleX(${Math.min(1, progress)})`
  }

  /** Small label under the crosshair when a tool speeds this block up. */
  setTargetInfo(text) {
    if (this._targetText === text) return
    this._targetText = text
    this.targetInfo.textContent = text || ''
  }

  toast(text, kind = 'error') {
    this.toastEl.textContent = text
    this.toastEl.className = kind
    this.toastEl.classList.add('show')
    clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => this.toastEl.classList.remove('show'), 2600)
  }

  setStatus(state) {
    const labels = {
      idle: 'idle',
      connecting: 'connecting to the server…',
      connected: 'connected — pick a name and join',
      reconnecting: 'connection lost, retrying…',
      closed: 'disconnected',
    }
    this.overlayStatus.innerHTML = `<span style="color:#8b98a8">${labels[state] || state}</span>`
  }

  showOverlay(show) {
    this.overlay.classList.toggle('hidden', !show)
  }

  setJoinEnabled(enabled, label) {
    this.joinBtn.disabled = !enabled
    this.joinBtn.textContent = label || (enabled ? 'Join' : 'Connecting…')
  }

  updateRoster(selfId, players) {
    const rows = players
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((p) => {
        const me = p.id === selfId ? ' me' : ''
        return `<div class="row${me}"><span class="dot" style="background:${p.color}"></span>${escapeHtml(p.name)}</div>`
      })
      .join('')
    this.roster.innerHTML = `<h3>Players · ${players.length}</h3>${rows || '<div class="row">alone</div>'}`
  }

  updateStats({ state, rtt, ping, count, mobs, tris, pos }) {
    const ok = state === 'connected'
    this.stats.innerHTML = `
      <div><span class="k">server</span> <span class="${ok ? 'dot-ok' : 'dot-bad'}">${state}</span></div>
      <div><span class="k">rtt</span> <span class="v">${rtt === null ? '—' : `${rtt} ms`}</span></div>
      <div><span class="k">online</span> <span class="v">${count}</span></div>
      <div><span class="k">mobs</span> <span class="v">${mobs ?? 0}</span></div>
      <div><span class="k">tris</span> <span class="v">${tris.toLocaleString()}</span></div>
      <div><span class="k">pos</span> <span class="v">${pos}</span></div>`
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}
