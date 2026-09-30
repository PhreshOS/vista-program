import * as THREE from "three"
import World, { cypress, flowers, palette, pot, shrub, tree, type Landscape } from "../world"

/** A morning garden: a wide lawn of tall grass and daisies, an old tree, shrubs, and a pot. */
const garden: Landscape = {
    palettes: {
        morning: palette({ zenith: "#e9c9a0", horizon: "#f7a55e", sun: "#fff0c4", fog: "#e79a5c", grassBase: "#12280a", grassTip: "#5f9a2c", leaf: "#2a3f1a", glow: "#ffb867", ground: "#1d3a10" }),
        night: palette({ zenith: "#060b1f", horizon: "#1b2848", sun: "#dfe8ff", fog: "#131c36", grassBase: "#020507", grassTip: "#10201f", leaf: "#0a1414", glow: "#3e5582", ground: "#04090a" })
    },
    lawn: { count: 380000, height: [0.05, 0.14], width: [0.006, 0.012], rows: 0, bushes: 0, dome: 0, bloom: 0, tufts: 0.05 },
    camera: { eye: 0.32, lift: 1.03 },
    hills: ["#6f6a3e", "#8a7152", "#9c7d68"],
    plant: shared => [
        flowers(shared),
        tree(shared, new THREE.Vector3(-5.2, 0, -15), 1),
        tree(shared, new THREE.Vector3(9, 0, -34), 0.8),
        ...[[-2.5, -9, 0.9], [1.5, -11, 1.1], [4.5, -9.5, 1], [-8.5, -10, 1.3], [7.5, -14, 1.2], [-1, -20, 1.4], [3, -24, 1.6]].map(([x, z, s]) => shrub(shared, new THREE.Vector3(x, 0, z), s)),
        ...[[6, -55, 9], [7.5, -58, 11], [-14, -70, 10], [16, -80, 12], [22, -95, 9], [-26, -110, 13], [2, -120, 10]].map(([x, z, h]) => cypress(shared, new THREE.Vector3(x, 0, z), h)),
        pot(shared, new THREE.Vector3(3.2, 0, -6.5))
    ]
}

/** The garden scene, drawn by the engine every scene with a horizon shares. */
export default function make(canvas: HTMLCanvasElement) {
    return new World(canvas, garden)
}
