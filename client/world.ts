import * as THREE from "three"
import type { Place, Scene } from "./scene"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"
import { progressAt, type Transaction } from "@phreshos/core"

/** Where the camera looks, from -1 to 1 across the plane in each direction. */
type Camera = Readonly<{ x: number, y: number }>

// The low morning sun, a little to the left, behind the tree.
const sunDirection = new THREE.Vector3(-0.3, 0.17, -1).normalize()

// The moon at night, higher and to the right: the light that edges everything once the sun is gone.
const moonDirection = new THREE.Vector3(0.35, 0.3, -1).normalize()

/** The colours of one hour; each scene has a morning and a night, and the world turns between them. */
export type Palette = Readonly<{
    zenith: THREE.Color, horizon: THREE.Color, sun: THREE.Color, fog: THREE.Color, grassBase: THREE.Color,
    grassTip: THREE.Color, leaf: THREE.Color, glow: THREE.Color, ground: THREE.Color
}>

/** How the lawn grows: how many blades, how tall and wide, and whether they stand in rows. */
export type Lawn = Readonly<{
    count: number
    height: readonly [number, number]
    width: readonly [number, number]
    /** The distance between rows running away from the camera, or 0 for an open lawn. */
    rows: number
    /** Within a row, the blades gather in bushes this far apart, or 0 to run along it evenly. */
    bushes: number
    /** How far each blade leans out from the middle of its bush, making the bush a dome; 0 stands them straight. */
    dome: number
    /** Where along a blade its flower begins, from 0 to 1; 0 for grass, which only lightens toward its tip. */
    bloom: number
    /** The share of blades that grow taller than the rest, as tufts. */
    tufts: number
}>

/**
 * One scene: its hours, its lawn and hills, and what grows in it. The engine draws what every scene
 * shares, the sky, the ground, the lawn, the hills and the air, and the scene plants the rest.
 */
export type Landscape = Readonly<{
    palettes: Readonly<{ morning: Palette, night: Palette }>
    lawn: Lawn
    /** How high the camera stands above the ground, and how far above its own height it looks at the horizon. */
    camera: Readonly<{ eye: number, lift: number }>
    hills: readonly [string, string, string]
    plant: (shared: Shared) => readonly THREE.Object3D[]
}>



/**
 * A scene built by hand in three dimensions: a lawn and whatever grows in it, hills in a warm haze,
 * under a low sun whose beams cross the air. Everything shares one set of uniforms, so the time,
 * the wind and the hour reach the whole world at once.
 */
export default class World implements Scene {

    private readonly renderer: THREE.WebGLRenderer

    private readonly scene = new THREE.Scene()

    private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.05, 900)

    private readonly composer: EffectComposer

    private readonly rays: ShaderPass

    /** Shared by every material: the clock, the hour, and the colours of that hour. */
    private readonly shared = {
        time: { value: 0 },
        night: { value: 0 },
        sunDirection: { value: sunDirection.clone() },
        fogColor: { value: new THREE.Color() },
        fogDensity: { value: 0.0065 },
        zenith: { value: new THREE.Color() },
        horizon: { value: new THREE.Color() },
        sunColor: { value: new THREE.Color() },
        grassBase: { value: new THREE.Color() },
        grassTip: { value: new THREE.Color() },
        leaf: { value: new THREE.Color() },
        glow: { value: new THREE.Color() },
        ground: { value: new THREE.Color() }
    }

    private readonly sunLight = new THREE.DirectionalLight("#ffd29a", 2.4)

    private readonly skyLight = new THREE.HemisphereLight("#ffd9b0", "#2d3a1c", 0.9)

    /** Where the camera stands, and its walk toward where the view went. */
    private position: Camera = { x: 0, y: 0 }

    private walk: Readonly<{ from: Camera, to: Camera, start: number, duration: number, progress: (t: number) => number }> | null = null

    /** Whether the camera was placed somewhere and has not been drawn there yet. */
    private placed = false

    private night = 0

    private nightTarget = 0

    private last = 0

    public constructor(private readonly canvas: HTMLCanvasElement, private readonly landscape: Landscape) {
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" })
        this.renderer.toneMapping = THREE.NeutralToneMapping
        this.renderer.toneMappingExposure = 0.95

        this.scene.add(this.sunLight, this.skyLight)
        this.sunLight.position.copy(sunDirection).multiplyScalar(50)

        this.scene.add(sky(this.shared), ground(this.shared), hills(this.shared, landscape.hills), grass(this.shared, landscape.lawn), ...landscape.plant(this.shared))
        this.scene.add(air(this.shared))

        // Four samples a pixel: thin blades far away would otherwise flicker and draw moiré rings.
        this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }))
        this.composer.addPass(new RenderPass(this.scene, this.camera))
        this.rays = new ShaderPass(raysShader())
        this.composer.addPass(this.rays)
        this.composer.addPass(new OutputPass())

        this.paint(landscape.palettes.morning)
    }

    /**
     * Walks the camera to where the view went, on the motion the view takes; with none, as under a
     * hand dragging the view, it stands there at once, so it stops the moment the hand stops. The
     * camera stands from -1 at one edge of the plane to 1 at the other, in each direction.
     */
    public look(place: Place, timing: Transaction | null) {
        const reach = { x: (place.plane.width - place.view.width) / 2, y: (place.plane.height - place.view.height) / 2 }
        const along = (value: number, limit: number) => limit > 0 ? Math.max(-1, Math.min(1, value / limit)) : 0
        const camera: Camera = { x: along(place.offset.x, reach.x), y: along(place.offset.y, reach.y) }
        if (timing === null) {
            this.walk = null
            this.position = camera
            this.placed = true
            return
        }
        this.walk = { from: { ...this.position }, to: camera, start: performance.now(), duration: timing.duration, progress: (t: number) => progressAt(timing, t * timing.duration) }
    }

    /** 0 is the morning, 1 the night; the world turns between them over a few seconds. */
    public nightfall(night: boolean) {
        this.nightTarget = night ? 1 : 0
    }

    /** Whether the camera is on its way somewhere, or waits to be drawn where it was placed. */
    public walking() {
        return this.walk !== null || this.placed
    }

    /** Snaps to where it is going, for a still frame with no motion before it. */
    public settle() {
        if (this.walk) this.position = { ...this.walk.to }
        this.walk = null
        this.night = this.nightTarget
    }

    public draw(time: number) {
        const scale = Math.min(window.devicePixelRatio, 2) * 0.75
        const width = Math.max(1, Math.round(this.canvas.clientWidth * scale))
        const height = Math.max(1, Math.round(this.canvas.clientHeight * scale))
        const size = this.renderer.getSize(new THREE.Vector2())
        if (size.x !== width || size.y !== height) {
            this.renderer.setPixelRatio(1)
            this.renderer.setSize(width, height, false)
            this.composer.setSize(width, height)
            this.camera.aspect = width / height
            this.camera.updateProjectionMatrix()
        }

        const step = this.last ? Math.min((time - this.last) / 1000, 0.1) : 0
        this.last = time
        if (this.walk) {
            const t = this.walk.duration > 0 ? Math.min(1, (time - this.walk.start) / this.walk.duration) : 1
            const p = this.walk.progress(t)
            this.position = { x: this.walk.from.x + (this.walk.to.x - this.walk.from.x) * p, y: this.walk.from.y + (this.walk.to.y - this.walk.from.y) * p }
            if (t >= 1) this.walk = null
        }
        this.placed = false
        this.night += (this.nightTarget - this.night) * (1 - Math.exp(-step * 0.8))

        // The plane is flat, so the camera only slides across it, always facing the same way: sideways
        // across the plane, and up and down with it, from just above the ground to over the grass.
        const x = this.position.x * 7
        const standing = this.landscape.camera.eye
        const eye = this.position.y > 0 ? standing - this.position.y * standing * 0.44 : standing - this.position.y * 0.8
        this.camera.position.set(x, eye, 0)
        this.camera.lookAt(x, eye + this.landscape.camera.lift, -30)

        this.shared.time.value = time / 1000
        this.shared.night.value = this.night
        this.paint(mix(this.landscape.palettes.morning, this.landscape.palettes.night, this.night))
        // The light turns from the sun to the moon: every edge and tip lit from behind follows it.
        const light = sunDirection.clone().lerp(moonDirection, this.night).normalize()
        this.shared.sunDirection.value.copy(light)
        this.sunLight.position.copy(light).multiplyScalar(50)
        this.sunLight.intensity = 2.4 * (1 - this.night * 0.8)
        this.skyLight.intensity = 0.9 * (1 - this.night * 0.7)

        // The beams start where the light is on screen, and fade as it leaves the view; the moon's are faint.
        const source = this.camera.position.clone().add(light.clone().multiplyScalar(500)).project(this.camera)
        this.rays.uniforms.sun.value.set(source.x * 0.5 + 0.5, source.y * 0.5 + 0.5)
        this.rays.uniforms.strength.value = (source.z < 1 ? 1 : 0) * (1 - this.night * 0.75)

        this.composer.render()
    }

    private paint(palette: Palette) {
        this.shared.zenith.value.copy(palette.zenith)
        this.shared.horizon.value.copy(palette.horizon)
        this.shared.sunColor.value.copy(palette.sun)
        this.shared.fogColor.value.copy(palette.fog)
        this.shared.grassBase.value.copy(palette.grassBase)
        this.shared.grassTip.value.copy(palette.grassTip)
        this.shared.leaf.value.copy(palette.leaf)
        this.shared.glow.value.copy(palette.glow)
        this.shared.ground.value.copy(palette.ground)
        this.skyLight.color.copy(palette.horizon)
        this.skyLight.groundColor.copy(palette.ground)
    }
}

export type Shared = Record<string, THREE.IUniform>

function mix(a: Palette, b: Palette, t: number): Palette {
    const out = {} as Record<keyof Palette, THREE.Color>
    for (const key of Object.keys(a) as (keyof Palette)[]) out[key] = a[key].clone().lerp(b[key], t)
    return out as Palette
}

/** A palette from hex colours. */
export function palette(colors: Readonly<Record<keyof Palette, string>>): Palette {
    return Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, new THREE.Color(value)])) as Palette
}

// Shared GLSL: the haze every distant thing sinks into, and a little noise.
const haze = /* glsl */`
uniform vec3 fogColor;
uniform float fogDensity;
uniform vec3 sunDirection;
uniform vec3 glow;
vec3 hazed(vec3 color, vec3 world) {
    vec3 toward = world - cameraPosition;
    float distance = length(toward);
    float amount = 1.0 - exp(-pow(distance * fogDensity, 1.35));
    // Toward the sun the haze is lit and glows.
    float sunward = pow(max(dot(normalize(toward), sunDirection), 0.0), 6.0);
    vec3 air = mix(fogColor, glow * 1.25, sunward * 0.7);
    return mix(color, air, amount);
}
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float smoothNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
`

/** Wind: a slow sway with gusts that travel across the garden. */
const wind = /* glsl */`
uniform float time;
vec2 windAt(vec3 world) {
    float gust = sin(time * 0.6 + world.x * 0.08 - world.z * 0.05) * 0.5 + 0.5;
    float sway = sin(time * 1.7 + world.x * 0.9 + world.z * 0.6) * 0.35 + sin(time * 2.9 + world.z * 1.3) * 0.15;
    return vec2(0.55 + sway, 0.25) * (0.35 + gust * 0.9);
}
`

function sky(shared: Shared) {
    const material = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { zenith: shared.zenith, horizon: shared.horizon, sunColor: shared.sunColor, sunDirection: shared.sunDirection, night: shared.night, time: shared.time },
        vertexShader: `varying vec3 direction; void main() { direction = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
            uniform vec3 zenith; uniform vec3 horizon; uniform vec3 sunColor; uniform vec3 sunDirection; uniform float night; uniform float time;
            varying vec3 direction;
            float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
            void main() {
                vec3 d = normalize(direction);
                float up = clamp(d.y, 0.0, 1.0);
                vec3 color = mix(horizon, zenith, pow(up, 0.55));
                float toward = max(dot(d, sunDirection), 0.0);
                // The sun by day; by night the moon, a smaller, sharper disc with a cold halo.
                float disc = pow(toward, mix(900.0, 4000.0, night)) * mix(18.0, 3.2, night);
                float halo = pow(toward, mix(40.0, 120.0, night)) * mix(1.4, 0.5, night) + pow(toward, 6.0) * mix(0.35, 0.12, night);
                color += sunColor * (disc + halo);
                // Stars come out at night.
                // Each star a small round point in its own patch of sky, measured in angles so none stretches.
                vec2 grid = vec2(atan(d.x, -d.z), asin(clamp(d.y, -1.0, 1.0))) * 160.0;
                vec2 cell = floor(grid);
                float point = smoothstep(0.32, 0.05, length(fract(grid) - 0.5 - (vec2(hash(cell + 11.0), hash(cell + 13.0)) - 0.5) * 0.4));
                float star = step(0.985, hash(cell)) * point * smoothstep(0.03, 0.3, up) * night * (0.55 + 0.45 * sin(time * 2.0 + hash(cell + 3.0) * 20.0)) * (0.4 + hash(cell + 7.0));
                gl_FragColor = vec4(color + vec3(star), 1.0);
            }`
    })
    return new THREE.Mesh(new THREE.SphereGeometry(800, 32, 16), material)
}

function ground(shared: Shared) {
    const geometry = new THREE.PlaneGeometry(900, 900, 1, 1).rotateX(-Math.PI / 2)
    const material = new THREE.ShaderMaterial({
        uniforms: { ground: shared.ground, grassBase: shared.grassBase, grassTip: shared.grassTip, fogColor: shared.fogColor, fogDensity: shared.fogDensity, sunDirection: shared.sunDirection, glow: shared.glow },
        vertexShader: `varying vec3 world; void main() { vec4 w = modelMatrix * vec4(position, 1.0); world = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: haze + /* glsl */`
            uniform vec3 ground; uniform vec3 grassBase; uniform vec3 grassTip; varying vec3 world;
            void main() {
                // Fine lawn texture that fades with distance, where it would only shimmer.
                float distance = length(world - cameraPosition);
                float fine = mix(smoothNoise(world.xz * 30.0), 0.5, smoothstep(2.0, 12.0, distance));
                float n = fine * 0.35 + smoothNoise(world.xz * 2.0) * 0.15 + smoothNoise(world.xz * 0.25) * 0.2;
                vec3 toward = normalize(world - cameraPosition);
                float back = pow(max(dot(toward, sunDirection), 0.0), 3.0);
                vec3 color = ground * (0.7 + n) + glow * back * fine * 0.35;
                // Farther off, only the tops of the grass are seen: the lawn takes their lit color,
                // so the soil between distant blades never shows through as dark specks.
                vec3 tops = mix(grassBase, grassTip, 0.72) * (0.85 + n * 0.3) + glow * back * 0.45;
                color = mix(color, tops, smoothstep(6.0, 30.0, distance));
                gl_FragColor = vec4(hazed(color, world), 1.0);
            }`
    })
    return new THREE.Mesh(geometry, material)
}

/** Three ranges of hills, each hazier than the one before it. */
function hills(shared: Shared, colors: readonly [string, string, string]) {
    const group = new THREE.Group()
    const ranges = [{ z: -170, height: 14, color: colors[0] }, { z: -260, height: 26, color: colors[1] }, { z: -380, height: 40, color: colors[2] }]
    for (const [index, range] of ranges.entries()) {
        const geometry = new THREE.PlaneGeometry(1400, 1, 280, 1)
        const positions = geometry.attributes.position as THREE.BufferAttribute
        const rises = new Float32Array(positions.count)
        for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i)
            const top = positions.getY(i) > 0
            const rise = (Math.sin(x * 0.008 + index * 2.1) * 0.5 + 0.5) * 0.7 + (Math.sin(x * 0.023 + index) * 0.5 + 0.5) * 0.3
            positions.setY(i, top ? range.height * (0.35 + rise) : -4)
            rises[i] = top ? 1 : 0
        }
        geometry.setAttribute("rise", new THREE.BufferAttribute(rises, 1))
        geometry.translate(0, 0, range.z)
        const material = new THREE.ShaderMaterial({
            uniforms: { tint: { value: new THREE.Color(range.color) }, fogColor: shared.fogColor, fogDensity: shared.fogDensity, sunDirection: shared.sunDirection, glow: shared.glow, night: shared.night },
            vertexShader: `attribute float rise; varying vec3 world; varying float up; void main() { up = rise; vec4 w = modelMatrix * vec4(position, 1.0); world = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
            fragmentShader: haze + /* glsl */`
                uniform vec3 tint; uniform float night; varying vec3 world; varying float up;
                void main() {
                    // Shadowed at their feet and lit along the crest, with rows of trees and fields between.
                    float fields = 0.88 + 0.24 * smoothNoise(vec2(world.x * 0.05, world.y * 0.4)) + 0.1 * smoothNoise(world.xy * 0.6);
                    vec3 color = tint * fields * mix(0.78, 1.12, up) + glow * pow(up, 6.0) * 0.18;
                    gl_FragColor = vec4(hazed(color * (1.0 - night * 0.7), world), 1.0);
                }`
        })
        group.add(new THREE.Mesh(geometry, material))
    }
    return group
}

/**
 * How wide the camera sees the ground at a depth, with room to spare: the grass is that wide there.
 * With rows, it is a whole number of rows wide, so a blade that wraps around lands on a row again.
 */
function span(z: number, rows: number) {
    const wide = 3 + Math.abs(z) * 1.25
    return rows > 0 ? Math.ceil(wide / rows) * rows : wide
}

/**
 * Thousands of blades, each its own instance, bending with the wind and lit from behind. The camera
 * slides sideways across the plane; a blade that leaves the view on one side comes back on the
 * other, so the lawn never ends and each blade still stands still in the world.
 */
function grass(shared: Shared, lawn: Lawn) {
    const segments = 3
    const blade = new THREE.PlaneGeometry(1, 1, 1, segments).translate(0, 0.5, 0)
    // The camera walks across the plane, so the lawn reaches as far as it can go.
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = blade.index
    geometry.setAttribute("position", blade.attributes.position)
    geometry.setAttribute("uv", blade.attributes.uv)

    const random = seeded(7)
    const blades: number[] = [], shapes: number[] = [], leans: number[] = []
    const [lowest, tallest] = lawn.height, [narrowest, widest] = lawn.width
    for (let i = 0; i < lawn.count; i++) {
        // Most blades near the camera and only across what it sees, since far away each covers
        // less of the screen and the ground shows the rest.
        let z = 1.5 - random() ** 2.6 * 55
        let x = (random() - 0.5) * span(z, lawn.rows)
        let lean = [0, 0]
        if (lawn.rows > 0) {
            // In rows, a blade stands on the nearest row, and in a bush along it when there are bushes.
            const along = lawn.bushes > 0 ? Math.round(z / lawn.bushes) * lawn.bushes : z
            const spread = lawn.rows * 0.18
            const row = Math.round(x / lawn.rows) * lawn.rows
            x = row + (random() - 0.5) * spread * 2
            z = along + (random() - 0.5) * (lawn.bushes > 0 ? lawn.bushes * 0.8 : 0)
            lean = [(x - row) / spread * lawn.dome, lawn.bushes > 0 ? (z - along) / (lawn.bushes * 0.4) * lawn.dome : 0]
        }
        leans.push(lean[0]!, lean[1]!)
        const tuft = random() < lawn.tufts
        blades.push(x, 0, z)
        shapes.push(random() * Math.PI * 2, tuft ? tallest + random() * (tallest - lowest) : lowest + random() * (tallest - lowest), (tuft ? widest : narrowest) + random() * (widest - narrowest), random())
    }
    geometry.setAttribute("placement", new THREE.InstancedBufferAttribute(new Float32Array(blades), 3))
    geometry.setAttribute("shape", new THREE.InstancedBufferAttribute(new Float32Array(shapes), 4))
    geometry.setAttribute("lean", new THREE.InstancedBufferAttribute(new Float32Array(leans), 2))
    geometry.instanceCount = blades.length / 3

    const material = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: { rows: { value: lawn.rows }, bloom: { value: lawn.bloom }, ...pick(shared, "time", "fogColor", "fogDensity", "sunDirection", "glow", "grassBase", "grassTip", "night", "ground") },
        vertexShader: wind + /* glsl */`
            attribute vec3 placement; attribute vec4 shape; attribute vec2 lean; uniform float rows;
            varying vec2 vUv; varying vec3 world; varying float seed; varying float far; varying vec3 facing;
            void main() {
                vUv = uv; seed = shape.w;
                far = smoothstep(14.0, 44.0, -placement.z);
                float h = uv.y;
                // The farthest blades sink into the lawn instead of ending in a line.
                float tall = shape.y * (1.0 - smoothstep(38.0, 55.0, -placement.z) * 0.85);
                // A blade narrows to its tip and curves as the wind pushes its upper half.
                float width = shape.z * (1.0 - h * 0.85);
                vec3 local = vec3(position.x * width, h * tall, 0.0);
                float c = cos(shape.x), s = sin(shape.x);
                local = vec3(local.x * c, local.y, local.x * s);
                // Which way the blade faces, leaning back toward the sky as it rises.
                facing = normalize(vec3(-s, 0.35 + h * 0.5, c));
                float wide = 3.0 + abs(placement.z) * 1.25;
                if (rows > 0.0) wide = ceil(wide / rows) * rows;
                vec3 base = placement;
                base.x = cameraPosition.x + mod(placement.x - cameraPosition.x + wide * 0.5, wide) - wide * 0.5;
                // Out from the middle of its bush, more toward its tip.
                local.xz += lean * pow(h, 1.5) * tall;
                vec2 push = windAt(base) * h * h * tall * 0.55;
                local.x += push.x; local.z += push.y; local.y -= dot(push, push) * 0.6;
                vec4 w = modelMatrix * vec4(base + local, 1.0);
                world = w.xyz;
                gl_Position = projectionMatrix * viewMatrix * w;
            }`,
        fragmentShader: haze + /* glsl */`
            uniform vec3 grassBase; uniform vec3 grassTip; uniform float time; uniform float night; uniform vec3 ground; uniform float bloom;
            varying vec2 vUv; varying vec3 world; varying float seed; varying float far; varying vec3 facing;
            void main() {
                // A blade thinner than a pixel is shaded at points just beside it, where its height reads
                // a little below 0 or above 1; kept within the blade, no power of it is undefined.
                float up = clamp(vUv.y, 0.0, 1.0);
                // Grass lightens toward its tip; a flowering stem turns to its flower where the flower begins.
                float flower = bloom > 0.0 ? smoothstep(bloom, bloom + 0.08, up) : pow(up, 1.2);
                vec3 color = mix(bloom > 0.0 ? grassBase * (1.0 + up) : grassBase, grassTip, flower) * (0.8 + seed * 0.4);
                // Patches across the lawn: some drier and warmer, some greener.
                float dryness = smoothNoise(world.xz * 0.35) * 0.7 + smoothNoise(world.xz * 1.7) * 0.3;
                // Only the leaves dry and warm; a flower keeps its own colour.
                color *= mix(mix(vec3(0.9, 1.04, 0.86), vec3(1.18, 1.0, 0.66), dryness), vec3(1.0), bloom > 0.0 ? flower : 0.0);
                // Each blade takes the low sun by the way it faces; both sides let light through.
                float lit = abs(dot(normalize(facing), sunDirection));
                color *= 0.62 + lit * 0.62;
                // Deep in the lawn, near the soil, little light arrives; far off, nobody sees that deep.
                color *= mix(mix(0.4, 1.0, far), 1.0, smoothstep(0.0, 0.55, up));
                // Far away the blades become the lawn they stand on, down to their feet.
                color = mix(color, mix(grassBase, grassTip, 0.72) * (0.85 + dryness * 0.3), far);
                // Lit from behind: toward the sun the blades glow, most at their thin edges and tips.
                vec3 toward = normalize(world - cameraPosition);
                float back = pow(max(dot(toward, sunDirection), 0.0), 3.0);
                float edge = abs(vUv.x - 0.5) * 2.0;
                color += glow * back * up * (0.65 + edge * 0.55) * (bloom > 0.0 ? 1.0 - flower * 0.6 : 1.0) * (1.0 - night * 0.65);
                // Dew: a drop near the tip catches the sun and twinkles.
                float drop = step(0.82, seed) * smoothstep(0.75, 0.95, up) * (0.5 + 0.5 * sin(time * (2.0 + seed * 3.0) + seed * 40.0));
                color += vec3(1.0, 0.92, 0.75) * drop * (0.4 + back * 2.0) * (1.0 - night * 0.97);
                gl_FragColor = vec4(hazed(color, world), 1.0);
            }`
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    return mesh
}

/** Small white flowers in loose clumps, on stems that sway with the grass. */
export function flowers(shared: Shared) {
    const texture = canvasTexture(128, context => {
        context.translate(64, 64)
        for (let i = 0; i < 11; i++) {
            context.rotate((Math.PI * 2) / 11)
            context.fillStyle = "#fffaf0"
            context.beginPath(); context.ellipse(0, -30, 9, 28, 0, 0, Math.PI * 2); context.fill()
        }
        context.fillStyle = "#f2b52e"; context.beginPath(); context.arc(0, 0, 13, 0, Math.PI * 2); context.fill()
    })
    const geometry = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    geometry.index = quad.index
    geometry.setAttribute("position", quad.attributes.position)
    geometry.setAttribute("uv", quad.attributes.uv)
    const random = seeded(11)
    const places: number[] = []
    for (let clump = 0; clump < 26; clump++) {
        const cx = (random() - 0.5) * 30, cz = -2 - random() * 22
        for (let i = 0; i < 18; i++) places.push(cx + (random() - 0.5) * 1.6, 0.14 + random() * 0.22, cz + (random() - 0.5) * 1.6, 0.05 + random() * 0.05)
    }
    geometry.setAttribute("flower", new THREE.InstancedBufferAttribute(new Float32Array(places), 4))
    geometry.instanceCount = places.length / 4
    const material = new THREE.ShaderMaterial({
        transparent: false,
        uniforms: { map: { value: texture }, ...pick(shared, "time", "fogColor", "fogDensity", "sunDirection", "glow", "night") },
        vertexShader: wind + /* glsl */`
            attribute vec4 flower; varying vec2 vUv; varying vec3 world;
            void main() {
                vUv = uv;
                vec3 base = flower.xyz;
                vec2 push = windAt(base) * 0.08;
                // Each head faces the sky and leans toward the camera, so it reads as a flower.
                vec3 center = base + vec3(push.x, 0.0, push.y);
                vec3 toCamera = normalize(vec3(cameraPosition.x - center.x, 0.0, cameraPosition.z - center.z));
                vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCamera));
                vec3 up = normalize(vec3(0.0, 1.0, 0.0) * 0.55 + toCamera * 0.45);
                vec4 w = vec4(center + (right * position.x + up * position.y) * flower.w, 1.0);
                world = w.xyz;
                gl_Position = projectionMatrix * viewMatrix * w;
            }`,
        fragmentShader: haze + /* glsl */`
            uniform sampler2D map; uniform float night; varying vec2 vUv; varying vec3 world;
            void main() {
                vec4 texel = texture2D(map, vUv);
                if (texel.a < 0.5) discard;
                vec3 color = texel.rgb * (0.95 - night * 0.6);
                gl_FragColor = vec4(hazed(color, world), 1.0);
            }`
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    return mesh
}

/** Leaves as clusters on small cards: dark against the sun, glowing at their edges. */
function leafMaterial(shared: Shared, tint: THREE.Color) {
    const texture = canvasTexture(128, context => {
        const random = seeded(5)
        for (let i = 0; i < 22; i++) {
            context.save()
            context.translate(20 + random() * 88, 20 + random() * 88)
            context.rotate(random() * Math.PI * 2)
            context.fillStyle = `rgb(${200 + random() * 55}, ${200 + random() * 55}, ${200 + random() * 55})`
            context.beginPath(); context.ellipse(0, 0, 5, 16, 0, 0, Math.PI * 2); context.fill()
            context.restore()
        }
    })
    return new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: { map: { value: texture }, tint: { value: tint }, ...pick(shared, "time", "fogColor", "fogDensity", "sunDirection", "glow", "leaf", "night") },
        vertexShader: wind + /* glsl */`
            attribute vec4 card; attribute float turn; varying vec2 vUv; varying vec3 world;
            void main() {
                vUv = uv;
                float c = cos(turn), s = sin(turn);
                vec3 local = vec3(position.x * c, position.y, position.x * s) * card.w;
                vec2 push = windAt(card.xyz) * 0.04 * card.y * 0.1;
                vec4 w = modelMatrix * vec4(card.xyz + local + vec3(push.x, 0.0, push.y), 1.0);
                world = w.xyz;
                gl_Position = projectionMatrix * viewMatrix * w;
            }`,
        fragmentShader: haze + /* glsl */`
            uniform sampler2D map; uniform vec3 tint; uniform vec3 leaf; uniform float night; varying vec2 vUv; varying vec3 world;
            void main() {
                vec4 texel = texture2D(map, vUv);
                if (texel.a < 0.45) discard;
                vec3 toward = normalize(world - cameraPosition);
                float back = pow(max(dot(toward, sunDirection), 0.0), 8.0);
                float edge = smoothstep(0.35, 0.5, length(vUv - 0.5));
                vec3 color = leaf * tint * (0.75 + 0.25 * texel.r) + glow * back * (0.12 + edge * 0.9);
                gl_FragColor = vec4(hazed(color, world), 1.0);
            }`
    })
}

/** A cloud of leaf cards in the shape of a crown. */
function crown(shared: Shared, center: THREE.Vector3, radius: THREE.Vector3, count: number, cardSize: number, tint: THREE.Color, seed: number) {
    const quad = new THREE.PlaneGeometry(1, 1)
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = quad.index
    geometry.setAttribute("position", quad.attributes.position)
    geometry.setAttribute("uv", quad.attributes.uv)
    const random = seeded(seed)
    const cards: number[] = [], turns: number[] = []
    for (let i = 0; i < count; i++) {
        // Denser toward the surface, so the crown has a clear edge and gaps within.
        const u = random() * 2 - 1, a = random() * Math.PI * 2, r = Math.cbrt(0.35 + random() * 0.65)
        const s = Math.sqrt(1 - u * u)
        cards.push(center.x + Math.cos(a) * s * r * radius.x, center.y + u * r * radius.y, center.z + Math.sin(a) * s * r * radius.z, cardSize * (0.7 + random() * 0.6))
        turns.push(random() * Math.PI)
    }
    geometry.setAttribute("card", new THREE.InstancedBufferAttribute(new Float32Array(cards), 4))
    geometry.setAttribute("turn", new THREE.InstancedBufferAttribute(new Float32Array(turns), 1))
    geometry.instanceCount = count
    const mesh = new THREE.Mesh(geometry, leafMaterial(shared, tint))
    mesh.frustumCulled = false
    return mesh
}

/**
 * A solid surface in the garden's own light: the low sun wraps around it, the sky lights what
 * faces up, the sun's rim catches its edges, and it sinks into the haze like everything else.
 * `grain` roughens it along its height, as bark or foliage, or leaves it smooth, as clay.
 */
function solid(shared: Shared, color: THREE.Color, grain: number) {
    return new THREE.ShaderMaterial({
        uniforms: { tint: { value: color }, grain: { value: grain }, ...pick(shared, "fogColor", "fogDensity", "sunDirection", "glow", "night") },
        vertexShader: /* glsl */`
            varying vec3 world; varying vec3 normalWorld;
            void main() {
                vec4 w = modelMatrix * vec4(position, 1.0);
                world = w.xyz;
                normalWorld = normalize(mat3(modelMatrix) * normal);
                gl_Position = projectionMatrix * viewMatrix * w;
            }`,
        fragmentShader: haze + /* glsl */`
            uniform vec3 tint; uniform float grain; uniform float night;
            varying vec3 world; varying vec3 normalWorld;
            void main() {
                vec3 n = normalize(normalWorld);
                vec3 view = normalize(cameraPosition - world);
                float sun = max(dot(n, sunDirection) * 0.5 + 0.5, 0.0);
                float sky = n.y * 0.5 + 0.5;
                float rim = pow(1.0 - max(dot(n, view), 0.0), 3.0) * pow(max(dot(-view, sunDirection), 0.0), 2.0);
                float streaks = mix(1.0, 0.72 + 0.5 * smoothNoise(vec2((world.x + world.z) * 9.0, world.y * 1.6)), grain);
                vec3 color = tint * streaks * (0.35 + sun * 0.55 + sky * 0.3) + glow * rim * 1.2;
                // By moonlight colours fade: a surface keeps only its lightness, dim and cool.
                vec3 moonlit = vec3(dot(color, vec3(0.3, 0.59, 0.11))) * vec3(0.3, 0.36, 0.52);
                color = mix(color, moonlit, night);
                gl_FragColor = vec4(hazed(color, world), 1.0);
            }`
    })
}

/** A broad old tree: a leaning trunk that splits into limbs, under a wide crown. */
export function tree(shared: Shared, at: THREE.Vector3, scale: number) {
    const group = new THREE.Group()
    const bark = solid(shared, new THREE.Color("#5a4232"), 1)
    const limb = (points: number[][], radius: number) => {
        const path = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)))
        group.add(new THREE.Mesh(new THREE.TubeGeometry(path, 16, radius, 8), bark))
    }
    limb([[0, 0, 0], [0.3, 1.2, 0], [0.1, 2.4, 0.2], [-0.4, 3.2, 0]], 0.38)
    limb([[-0.4, 3.0, 0], [-1.6, 4.0, 0.3], [-2.8, 4.6, 0]], 0.17)
    limb([[-0.2, 3.1, 0], [0.9, 4.2, -0.3], [2.2, 4.9, 0]], 0.16)
    limb([[-0.3, 3.2, 0], [-0.4, 4.4, -0.4], [-0.2, 5.6, 0]], 0.14)
    // The crown in lobes, with sky between them for the sun to come through.
    for (const [x, y, z, rx, ry, rz, seed] of [[-2.2, 4.7, 0.2, 1.7, 1.0, 1.4, 3], [0.2, 5.4, -0.2, 1.9, 1.1, 1.6, 4], [2.3, 4.9, 0.1, 1.6, 0.9, 1.3, 5], [-0.9, 6.0, 0.4, 1.3, 0.8, 1.1, 6], [1.2, 6.1, -0.4, 1.2, 0.7, 1.0, 7]]) {
        group.add(crown(shared, new THREE.Vector3(x, y, z), new THREE.Vector3(rx, ry, rz), 380, 0.7, new THREE.Color("#c9d3a6"), seed))
    }
    group.position.copy(at)
    group.scale.setScalar(scale)
    return group
}

/** A rounded shrub of small leaves, some with flowers. */
export function shrub(shared: Shared, at: THREE.Vector3, scale: number) {
    const tint = new THREE.Color().setHSL(0.22 + Math.sin(at.x) * 0.04, 0.35, 0.62)
    return crown(shared, new THREE.Vector3(at.x, 0.55 * scale, at.z), new THREE.Vector3(1.1 * scale, 0.7 * scale, 1.0 * scale), Math.round(260 * scale), 0.42 * scale, tint, Math.round(at.x * 13 + at.z * 7))
}

/** A tall cypress: a dense column of foliage, lit round by the low sun. */
export function cypress(shared: Shared, at: THREE.Vector3, height: number) {
    const material = solid(shared, new THREE.Color("#3a4a26"), 0.8)
    const shape = new THREE.LatheGeometry([0, 0.2, 0.45, 0.62, 0.66, 0.6, 0.42, 0.18, 0].map((r, i, all) => new THREE.Vector2(r * height * 0.12, (i / (all.length - 1)) * height)), 24)
    const mesh = new THREE.Mesh(shape, material)
    mesh.position.copy(at)
    return mesh
}

/** A terracotta pot with a young plant: the one warm, made thing in the garden. */
export function pot(shared: Shared, at: THREE.Vector3) {
    const group = new THREE.Group()
    const clay = solid(shared, new THREE.Color("#c46f45"), 0.15)
    const profile = [[0.0, 0], [0.26, 0], [0.3, 0.05], [0.36, 0.55], [0.42, 0.6], [0.42, 0.66], [0.37, 0.66], [0.35, 0.62]].map(([r, y]) => new THREE.Vector2(r, y))
    group.add(new THREE.Mesh(new THREE.LatheGeometry(profile, 32), clay))
    const soil = new THREE.Mesh(new THREE.CircleGeometry(0.35, 24).rotateX(-Math.PI / 2), solid(shared, new THREE.Color("#2e2016"), 0.6))
    soil.position.y = 0.6
    group.add(soil)
    const leaves = solid(shared, new THREE.Color("#3f6130"), 0.3)
    leaves.side = THREE.DoubleSide
    const random = seeded(19)
    for (let i = 0; i < 14; i++) {
        const leaf = new THREE.Mesh(new THREE.CircleGeometry(0.09, 10).scale(0.5, 1, 1), leaves)
        leaf.position.set((random() - 0.5) * 0.3, 0.75 + random() * 0.6, (random() - 0.5) * 0.3)
        leaf.rotation.set(random() * 1.2, random() * Math.PI, random() * 1.2)
        group.add(leaf)
    }
    group.position.copy(at)
    return group
}

/** Motes of moisture and pollen drifting through the light; at night, fireflies. */
function air(shared: Shared) {
    const random = seeded(23)
    const count = 700
    const places = new Float32Array(count * 3), seeds = new Float32Array(count)
    for (let i = 0; i < count; i++) {
        places.set([(random() - 0.5) * 22, random() * 3.2, 2 - random() * 20], i * 3)
        seeds[i] = random()
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.BufferAttribute(places, 3))
    geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 1))
    const material = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: pick(shared, "time", "sunDirection", "night", "glow"),
        vertexShader: /* glsl */`
            uniform float time; uniform vec3 sunDirection; uniform float night;
            attribute float seed; varying float light; varying float firefly;
            void main() {
                vec3 p = position + vec3(sin(time * 0.2 + seed * 40.0) * 0.6 + time * 0.05, sin(time * 0.31 + seed * 17.0) * 0.4, cos(time * 0.17 + seed * 23.0) * 0.5);
                p.x = mod(p.x + 11.0, 22.0) - 11.0;
                vec4 view = viewMatrix * modelMatrix * vec4(p, 1.0);
                vec3 toward = normalize((modelMatrix * vec4(p, 1.0)).xyz - cameraPosition);
                light = 0.2 + pow(max(dot(toward, sunDirection), 0.0), 5.0) * 2.5;
                // By night more of the motes are fireflies, each glowing up and fading slowly.
                firefly = step(0.85 - night * 0.3, seed) * pow(max(0.0, sin(time * (0.35 + seed * 0.5) + seed * 50.0)), 3.0);
                gl_PointSize = (1.0 + seed * 1.8) * (26.0 + firefly * night * 34.0) / -view.z;
                gl_Position = projectionMatrix * view;
            }`,
        fragmentShader: /* glsl */`
            uniform float night; uniform vec3 glow; varying float light; varying float firefly;
            void main() {
                float d = length(gl_PointCoord - 0.5);
                float soft = smoothstep(0.5, 0.0, d);
                vec3 mote = vec3(1.0, 0.88, 0.66) * soft * light * 0.5 * (1.0 - night);
                // A bright core in a wide soft glow.
                float core = smoothstep(0.18, 0.0, d);
                vec3 fly = vec3(0.78, 1.0, 0.42) * (soft * soft * 1.6 + core * 2.4) * firefly * night;
                gl_FragColor = vec4(mote + fly, 1.0);
            }`
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    return points
}

/** Beams: light gathered along the way to the sun, where the sky shows through. */
function raysShader() {
    return {
        uniforms: { tDiffuse: { value: null }, sun: { value: new THREE.Vector2(0.4, 0.6) }, strength: { value: 1 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
            uniform sampler2D tDiffuse; uniform vec2 sun; uniform float strength; varying vec2 vUv;
            void main() {
                vec4 base = texture2D(tDiffuse, vUv);
                vec2 step = (vUv - sun) / 48.0;
                vec2 at = vUv;
                float weight = 1.0, gathered = 0.0;
                for (int i = 0; i < 48; i++) {
                    at -= step;
                    vec3 c = texture2D(tDiffuse, at).rgb;
                    float bright = smoothstep(0.85, 1.4, dot(c, vec3(0.33)));
                    gathered += bright * weight;
                    weight *= 0.965;
                }
                vec3 beams = vec3(1.0, 0.8, 0.55) * gathered / 48.0 * 1.6 * strength;
                gl_FragColor = vec4(base.rgb + beams, base.a);
            }`
    }
}

function pick<Key extends string>(shared: Record<string, THREE.IUniform>, ...keys: Key[]) {
    return Object.fromEntries(keys.map(key => [key, shared[key]])) as Record<Key, THREE.IUniform>
}

function canvasTexture(size: number, draw: (context: CanvasRenderingContext2D) => void) {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = size
    draw(canvas.getContext("2d")!)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    return texture
}

/** A small repeatable random, so the garden is the same garden every time. */
function seeded(seed: number) {
    let state = seed * 9301 + 49297
    return () => {
        state = (state * 9301 + 49297) % 233280
        return state / 233280
    }
}
