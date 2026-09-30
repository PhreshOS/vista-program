/**
 * The plan of the seedbeds: where the beds lie in each view, what can grow in them, and what has
 * been planted. Everything is placed within its view, in shares of the view from its top-left
 * corner, so a Desktop of any size keeps each plant in its bed.
 */

/** A view of the plane, counted from the center one: x to the right, y downward. */
export type Cell = Readonly<{ x: number, y: number }>

/** A bed within a view: its rectangle in shares of the view, and how round its corners are. */
export type Bed = Readonly<{ left: number, top: number, right: number, bottom: number }>

/** Something growing: in which view, where in it, of which kind, and when it was planted (ms since the epoch, 0 for always). */
export type Planting = Readonly<{ cell: Cell, at: Readonly<{ u: number, v: number }>, kind: number, planted: number }>

/** One kind of plant, as seen from above: its leaves, and the flower that opens over them, if any. */
export type Kind = Readonly<{
    name: string
    /** How wide it grows, in shares of the view's height. */
    size: number
    leaves: number
    leaf: string
    petals: number
    petal: string
    heart: string
}>

/**
 * Many colours, none leading: warm coral and orange, cool violet and blue, magenta, white, and
 * greens from teal to lime.
 */
export const kinds: readonly Kind[] = [
    { name: "coral poppy", size: 0.073, leaves: 5, leaf: "#4f8f4a", petals: 5, petal: "#ff7564", heart: "#3b2233" },
    { name: "violet aster", size: 0.064, leaves: 6, leaf: "#3f8a5a", petals: 14, petal: "#9a74ff", heart: "#ffd45c" },
    { name: "cornflower", size: 0.062, leaves: 5, leaf: "#5c9a6a", petals: 10, petal: "#5b9dff", heart: "#2f3f8f" },
    { name: "magenta tulip", size: 0.067, leaves: 4, leaf: "#3e9474", petals: 6, petal: "#ff5aad", heart: "#ffe08a" },
    { name: "marigold", size: 0.05, leaves: 7, leaf: "#4a8a3a", petals: 16, petal: "#ff9e2f", heart: "#c2561a" },
    { name: "white daisy", size: 0.063, leaves: 6, leaf: "#5b9a4f", petals: 18, petal: "#fff3e6", heart: "#ffc93c" },
    { name: "fern", size: 0.06, leaves: 8, leaf: "#2f8f7a", petals: 0, petal: "#000000", heart: "#000000" },
    { name: "rose succulent", size: 0.04, leaves: 8, leaf: "#86b89a", petals: 0, petal: "#000000", heart: "#e98aa6" }
]

/** How long a seed takes to become a plant in flower, in seconds. */
export const growing = 180

/** How close two plants may stand, in shares of the view's height. */
export const spacing = 0.075

/** The most plantings kept; the oldest give way to new ones. */
export const most = 600

/** Where the plantings are kept, for every Process of Vista and every Desktop to see. */
export const plantingsKey = "seedbeds"

/** The beds of a view: a few layouts, chosen for each view, so walking the plane passes different gardens. */
export function bedsOf(cell: Cell): readonly Bed[] {
    const layouts: readonly (readonly Bed[])[] = [
        // Two long beds.
        [{ left: 0.1, top: 0.16, right: 0.9, bottom: 0.42 }, { left: 0.1, top: 0.58, right: 0.9, bottom: 0.84 }],
        // Four square beds around a crossing.
        [{ left: 0.1, top: 0.14, right: 0.46, bottom: 0.44 }, { left: 0.54, top: 0.14, right: 0.9, bottom: 0.44 },
            { left: 0.1, top: 0.56, right: 0.46, bottom: 0.86 }, { left: 0.54, top: 0.56, right: 0.9, bottom: 0.86 }],
        // Three beds across.
        [{ left: 0.08, top: 0.14, right: 0.34, bottom: 0.86 }, { left: 0.38, top: 0.14, right: 0.62, bottom: 0.86 }, { left: 0.66, top: 0.14, right: 0.92, bottom: 0.86 }],
        // One wide bed, and two small ones below it.
        [{ left: 0.1, top: 0.14, right: 0.9, bottom: 0.5 }, { left: 0.1, top: 0.6, right: 0.44, bottom: 0.86 }, { left: 0.56, top: 0.6, right: 0.9, bottom: 0.86 }]
    ]
    return layouts[Math.floor(hash(cell.x * 7.1 + cell.y * 3.3 + 1.7) * layouts.length)]!
}

/** The bed a point falls in, if any, with a little room kept from its edge. */
export function bedAt(cell: Cell, u: number, v: number): Bed | null {
    return bedsOf(cell).find(bed => u > bed.left + 0.02 && u < bed.right - 0.02 && v > bed.top + 0.03 && v < bed.bottom - 0.03) ?? null
}

/** What grows in a bed before anyone plants anything: a few plants of a few kinds, the same every time. */
export function sownOf(cell: Cell): readonly Planting[] {
    const out: Planting[] = []
    for (const [index, bed] of bedsOf(cell).entries()) {
        const random = seeded(cell.x * 101 + cell.y * 37 + index * 13 + 5)
        // About half of what a bed holds, so there is always room left to plant.
        const count = Math.round((bed.right - bed.left) * (bed.bottom - bed.top) * 45) + 2
        let sown = 0
        for (let tries = 0; tries < count * 4 && sown < count; tries++) {
            const at = { u: bed.left + 0.05 + random() * (bed.right - bed.left - 0.1), v: bed.top + 0.06 + random() * (bed.bottom - bed.top - 0.12) }
            if (out.some(other => Math.hypot(other.at.u - at.u, other.at.v - at.v) < spacing * 1.3)) continue
            out.push({ cell, at, kind: kindFor(random), planted: 0 })
            sown++
        }
    }
    return out
}

/** Reads the kept plantings, dropping any that are not whole. */
export function readPlantings(value: unknown): readonly Planting[] {
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is Planting => !!entry && typeof entry === "object"
        && Number.isFinite(entry.cell?.x) && Number.isFinite(entry.cell?.y)
        && Number.isFinite(entry.at?.u) && Number.isFinite(entry.at?.v)
        && Number.isInteger(entry.kind) && entry.kind >= 0 && entry.kind < kinds.length
        && Number.isFinite(entry.planted))
}

/** A kind for a seed: mostly flowers, of any colour, and now and then a plant grown for its leaves. */
export function kindFor(random: () => number) {
    const flowering = kinds.flatMap((kind, index) => kind.petals > 0 ? [index] : [])
    const leafy = kinds.flatMap((kind, index) => kind.petals > 0 ? [] : [index])
    const from = random() < 0.82 ? flowering : leafy
    return from[Math.floor(random() * from.length)]!
}

function hash(value: number) {
    const x = Math.sin(value * 127.1) * 43758.5453
    return x - Math.floor(x)
}

export function seeded(seed: number) {
    let state = Math.floor(Math.abs(seed) * 9301 + 49297) % 233280 || 1
    return () => {
        state = (state * 9301 + 49297) % 233280
        return state / 233280
    }
}
