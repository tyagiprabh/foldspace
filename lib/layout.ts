/**
 * Derived layout. Nothing in the registry carries a coordinate.
 *
 * Why hash-derived and not index-derived: with index-derived angles, inserting
 * a world at position 3 rotates every world after it, so a map someone
 * screenshotted last month no longer matches. Hashing the id pins a world to
 * its arc forever. A deterministic relaxation pass then pushes apart any pair
 * that hashed too close, so crowding degrades gracefully instead of stacking.
 *
 * Shells: one ring holds ~9 worlds comfortably. Past that, worlds spill into
 * outer shells with a slight plane tilt, which is what turns a flat wheel into
 * something you fly through.
 */

export const WORLDS_PER_SHELL = 9
export const SHELL_R = 16
export const SHELL_STEP = 8.5
export const SHELL_TILT = 0.19
/** Radius of a world's moon cluster. */
export const MOON_R = 3.0
/** Flatten the moon cluster in Y so it reads as a disc, not a globe. */
export const MOON_SQUASH = 0.46

/** FNV-1a → [0,1). Stable across runs, platforms and versions. */
export function hash01(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 100000) / 100000
}

/**
 * Spread `ids` around a circle at their hashed angles, then relax until no two
 * neighbours sit closer than most of their fair share of the circle.
 */
export function relaxedAngles(ids: string[]): Map<string, number> {
  const n = ids.length
  const out = new Map<string, number>()
  if (n === 0) return out
  if (n === 1) {
    out.set(ids[0], hash01(ids[0]))
    return out
  }

  const items = ids.map((id) => ({ id, a: hash01(id) })).sort((x, y) => x.a - y.a)
  // Near-perfect even spacing: at 0.72 neighbouring moon clusters overlapped.
  const minGap = (1 / n) * 0.95

  for (let pass = 0; pass < 240; pass++) {
    let moved = false
    for (let i = 0; i < n; i++) {
      const cur = items[i]
      const nxt = items[(i + 1) % n]
      // Forward gap on the circle.
      let gap = nxt.a - cur.a
      if (gap < 0) gap += 1
      if (gap < minGap) {
        const push = (minGap - gap) / 2
        cur.a = (cur.a - push + 1) % 1
        nxt.a = (nxt.a + push) % 1
        moved = true
      }
    }
    if (!moved) break
  }

  for (const it of items) out.set(it.id, it.a)
  return out
}

export interface Shell {
  index: number
  radius: number
  tilt: number
}

export function shellFor(index: number): Shell {
  const i = Math.floor(index / WORLDS_PER_SHELL)
  return {
    index: i,
    radius: SHELL_R + i * SHELL_STEP,
    // Alternate the tilt direction so shells read as distinct planes.
    tilt: i === 0 ? 0 : SHELL_TILT * (i % 2 === 0 ? 1 : -1) * i,
  }
}

/** How far a world may sit off its shell plane. Without this the ring collapses
 *  into a line under a low camera and worlds visually stack. */
export const INCLINATION = 3.4

export function orbitPosition(angleTurns: number, shell: Shell, inclineTurns = 0) {
  const a = angleTurns * Math.PI * 2
  const x = Math.cos(a) * shell.radius
  const z = Math.sin(a) * shell.radius
  // Rotate the ring plane about X by the shell tilt, then lift the world off it.
  const y = -z * Math.sin(shell.tilt) + Math.sin(inclineTurns * Math.PI * 2) * INCLINATION
  return { x, y, z: z * Math.cos(shell.tilt) }
}

/**
 * Golden-angle points on a squashed sphere. Deterministic, evenly spaced for
 * any count, and never leaves the moons coplanar.
 */
export function moonOffset(i: number, n: number) {
  if (n === 1) return { x: MOON_R, y: MOON_R * 0.22, z: 0 }
  const y = 1 - (i / (n - 1)) * 2
  const r = Math.sqrt(Math.max(0, 1 - y * y))
  const theta = i * Math.PI * (3 - Math.sqrt(5))
  return {
    x: Math.cos(theta) * r * MOON_R,
    y: y * MOON_R * MOON_SQUASH,
    z: Math.sin(theta) * r * MOON_R,
  }
}

/**
 * Vivid, well-separated hues. A world's slot is still derived from its id so a
 * new world gets a stable colour without anyone picking one — only the values
 * changed, not the mechanism.
 */
const BAND: string[] = [
  '#3B82F6', // blue
  '#10B981', // emerald
  '#8B5CF6', // violet
  '#F97316', // orange
  '#EC4899', // pink
  '#EF4444', // red
  '#06B6D4', // cyan
  '#6366F1', // indigo
  '#84CC16', // lime
  '#9CA3AF', // grey
]

/**
 * Each world hashes to a preferred slot, then collisions walk to the next free
 * one. Worlds are processed in id order, so adding a world only recolours one
 * it actually collides with — never the whole map. Past `BAND.length` worlds the
 * band wraps and lightness carries the difference.
 */
export function assignColors(ids: string[]): Map<string, string> {
  const taken = new Map<number, number>()
  const out = new Map<string, string>()

  for (const id of [...ids].sort()) {
    const pref = Math.floor(hash01(id + '#hue') * BAND.length) % BAND.length
    let slot = pref
    for (let step = 0; step < BAND.length; step++) {
      const cand = (pref + step) % BAND.length
      slot = cand
      if (!taken.has(cand)) break
    }
    const wrap = taken.get(slot) ?? 0
    taken.set(slot, wrap + 1)
    out.set(id, wrap === 0 ? BAND[slot] : lighten(BAND[slot], wrap * 16))
  }
  return out
}

/** Push a hex colour toward white by `amount` percent. */
function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const mix = (c: number) => Math.round(c + (255 - c) * (amount / 100))
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
