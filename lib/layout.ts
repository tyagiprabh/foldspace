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
 * Dune-flavoured desert palette. Hue is derived from the world id so a new
 * world gets a stable colour without anyone picking one, then pinned into a
 * warm sand-to-spice band with two cool escapes so clusters stay separable.
 */
const BAND: [number, number, number][] = [
  [36, 68, 58], // spice gold
  [16, 62, 48], // rust
  [8, 48, 44], // oxide red
  [28, 42, 62], // copper sand
  [46, 34, 52], // dry olive
  [196, 34, 56], // deep spice blue
  [172, 30, 50], // verdigris
  [280, 22, 56], // dusk violet
  [30, 14, 62], // bone
]

/**
 * Each world hashes to a preferred palette slot, then collisions walk to the
 * next free slot. Worlds are processed in id order, so adding a world only
 * recolours one that it actually collides with — never the whole map. Past
 * `BAND.length` worlds the band wraps and lightness carries the difference.
 */
export function assignColors(ids: string[]): Map<string, string> {
  const taken = new Map<number, number>()
  const out = new Map<string, string>()

  for (const id of [...ids].sort()) {
    const pref = Math.floor(hash01(id + '#hue') * BAND.length) % BAND.length
    let slot = pref
    for (let step = 0; step < BAND.length; step++) {
      const cand = (pref + step) % BAND.length
      if (!taken.has(cand)) {
        slot = cand
        break
      }
      slot = cand
    }
    const wrap = taken.get(slot) ?? 0
    taken.set(slot, wrap + 1)

    const [h, s, l] = BAND[slot]
    // Wrapped worlds step lighter; unwrapped ones get a small stable jitter.
    const dl = wrap * 11 + (hash01(id + '#l') - 0.5) * 5
    out.set(id, hslToHex(h, s, Math.max(28, Math.min(78, l + dl))))
  }
  return out
}

export function hslToHex(h: number, s: number, l: number): string {
  const S = s / 100
  const L = l / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = S * Math.min(L, 1 - L)
  const f = (n: number) => L - a * Math.max(-1, Math.min(Math.min(k(n) - 3, 9 - k(n)), 1))
  const to = (v: number) =>
    Math.round(255 * v)
      .toString(16)
      .padStart(2, '0')
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`
}
