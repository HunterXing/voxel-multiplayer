// Client side of the authoritative block-edit protocol.
//
// Local edits are applied optimistically and tracked per cell. Whatever the
// server says afterwards (echoed blockChanged, or editRejected after losing a
// race) overwrites the cell, so a client can never drift away from the server.

const cellKey = (x, y, z) => `${x},${y},${z}`

export class Reconciler {
  constructor({ world, renderer, send }) {
    this.world = world
    this.renderer = renderer
    this.send = send
    this.pending = new Map()
    this.seq = 1
  }

  /** Drop optimistic state (used on join / reconnect). */
  reset() {
    this.pending.clear()
  }

  /**
   * Apply locally right away, remember what we believed was there, then ask
   * the server to confirm.
   * @returns {number} request seq
   */
  requestEdit(x, y, z, block) {
    const expected = this.world.get(x, y, z)
    const seq = this.seq++
    this.world.set(x, y, z, block)
    this.renderer.markDirtyAt(x, z)
    this.pending.set(cellKey(x, y, z), { x, y, z, from: expected, to: block, seq })
    this.send(x, y, z, block, expected, seq)
    return seq
  }

  /** An edit landed (ours echoed back, or another player's). */
  onBlockChanged({ x, y, z, block }) {
    this.world.set(x, y, z, block)
    this.renderer.markDirtyAt(x, z)
    this.pending.delete(cellKey(x, y, z))
  }

  /** We lost a race: roll the cell back to the server's truth. */
  onEditRejected({ x, y, z, actual }) {
    this.world.set(x, y, z, actual)
    this.renderer.markDirtyAt(x, z)
    this.pending.delete(cellKey(x, y, z))
  }

  get pendingCount() {
    return this.pending.size
  }
}
