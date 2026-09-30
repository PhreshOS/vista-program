import * as THREE from "three"
import World, { cypress, palette, tree, type Landscape } from "../world"

/**
 * A lavender field in the late light: rows of purple bushes running to the hills, a line of
 * cypresses along a lane, and an old tree at the field's edge.
 */
const lavender: Landscape = {
    palettes: {
        morning: palette({ zenith: "#e7c6c0", horizon: "#f3a07a", sun: "#fff0d0", fog: "#e39a86", grassBase: "#2c3526", grassTip: "#6f45c2", leaf: "#2e3d22", glow: "#ffb27a", ground: "#6b4a34" }),
        night: palette({ zenith: "#070a22", horizon: "#232650", sun: "#e3e6ff", fog: "#181a3c", grassBase: "#03050a", grassTip: "#2a2052", leaf: "#0b1216", glow: "#454a8a", ground: "#0a0912" })
    },
    lawn: { count: 420000, height: [0.3, 0.46], width: [0.012, 0.02], rows: 1.1, bushes: 0.7, dome: 0.35, bloom: 0.62, tufts: 0 },
    // Seen from where one walks, over the rows, looking a little down along them.
    camera: { eye: 1.15, lift: -0.9 },
    hills: ["#6d6a48", "#8c7160", "#9d7f78"],
    plant: shared => [
        ...[[-9, -34], [-9.4, -41], [-9.8, -48], [-10.2, -55], [-10.6, -62], [-11, -69], [-11.4, -76]].map(([x, z], index) => cypress(shared, new THREE.Vector3(x, 0, z), 7 + (index % 3))),
        tree(shared, new THREE.Vector3(12, 0, -40), 1),
        ...[[18, -90, 10], [24, -96, 12], [-30, -120, 11]].map(([x, z, h]) => cypress(shared, new THREE.Vector3(x, 0, z), h))
    ]
}

/** The lavender scene, drawn by the engine every scene with a horizon shares. */
export default function make(canvas: HTMLCanvasElement) {
    return new World(canvas, lavender)
}
