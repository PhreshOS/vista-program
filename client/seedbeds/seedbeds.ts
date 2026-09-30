import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"
import { progressAt, type Program, type Transaction } from "@phreshos/core"
import type { Place, Scene } from "../scene"
import { bedAt, bedsOf, growing, kindFor, kinds, most, plantingsKey, readPlantings, seeded, sownOf, spacing, type Cell, type Planting } from "./plan"

// The garden is laid out in rooms a view in size, a hundred pixels of the Desktop to one unit. The
// camera looks down on it from high enough that it lies well below the windows: it shows it at
// this share of that size, and it moves at this share of the windows' pace, so the windows glide
// over the garden instead of seeming stuck to the ground.
const pixels = 100
const zoom = 0.75
const depth = 0.4
// The pixels of the screen one unit of the garden covers, from that height.
const shown = pixels * zoom

/**
 * Garden beds seen from straight above. A click in a bed plants a seed, which sprouts and grows into
 * a plant in flower over a few minutes; what is planted is kept, so the garden fills over the days.
 * The pointer is felt: plants lean away from it, and at night it carries a small light.
 */
export default class Seedbeds implements Scene {

    private readonly renderer: THREE.WebGLRenderer
    private readonly scene = new THREE.Scene()
    private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    private readonly composer: EffectComposer
    private readonly bloom: UnrealBloomPass
    private readonly grade: ShaderPass

    private readonly start = performance.now()
    private readonly startedAt = Date.now()

    private readonly shared = {
        time: { value: 0 },
        night: { value: 0 },
        pointer: { value: new THREE.Vector2(0, 0) },
        pointerOn: { value: 0 }
    }

    /** The size of a view, in units. */
    private view = { width: 0, height: 0 }
    private cells = 5

    private position = { x: 0, y: 0 }
    private walk: Readonly<{ from: { x: number, y: number }, to: { x: number, y: number }, start: number, duration: number, timing: Transaction }> | null = null
    private placed = false

    private night = 0
    private nightTarget = 0
    private last = 0

    private kept: readonly Planting[] = []
    private garden: THREE.Group | null = null
    private readonly bursts: { mesh: THREE.Mesh, born: number }[] = []

    /** Where the pointer is on the canvas, in pixels, and how present it is. */
    private pointer: { x: number, y: number } | null = null
    private pointerPresence = 0

    private constructor(private readonly canvas: HTMLCanvasElement, private readonly program: Program) {
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" })
        this.renderer.toneMapping = THREE.NoToneMapping
        this.camera.position.set(0, 0, 10)

        this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType }))
        this.composer.addPass(new RenderPass(this.scene, this.camera))
        // A soft glow over what is bright: the flowers, the lights at night, a new seed.
        this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.7, 0.72)
        this.composer.addPass(this.bloom)
        this.grade = new ShaderPass(gradeShader())
        this.composer.addPass(this.grade)
        this.composer.addPass(new OutputPass())

        this.scene.add(air(this.shared))

        canvas.addEventListener("pointermove", event => { this.pointer = { x: event.offsetX, y: event.offsetY } })
        canvas.addEventListener("pointerleave", () => { this.pointer = null })
        let down: { x: number, y: number, at: number } | null = null
        canvas.addEventListener("pointerdown", event => { if (event.button === 0) down = { x: event.offsetX, y: event.offsetY, at: performance.now() } })
        canvas.addEventListener("pointerup", event => {
            // A click plants; a press that wanders or lingers does not.
            if (down && Math.hypot(event.offsetX - down.x, event.offsetY - down.y) < 6 && performance.now() - down.at < 500) this.plant(event.offsetX, event.offsetY)
            down = null
        })
    }

    public static async make(canvas: HTMLCanvasElement, program: Program) {
        const seedbeds = new Seedbeds(canvas, program)
        seedbeds.kept = readPlantings(await program.store.get(plantingsKey))
        program.store.subscribe(plantingsKey, value => { seedbeds.kept = readPlantings(value); seedbeds.plantGarden() })
        return seedbeds
    }

    public look(place: Place, timing: Transaction | null) {
        const view = { width: place.view.width / pixels, height: place.view.height / pixels }
        const cells = Math.max(1, Math.round(place.plane.width / Math.max(place.view.width, 1)))
        if (view.width !== this.view.width || view.height !== this.view.height || cells !== this.cells) {
            this.view = view
            this.cells = cells
            this.plantGarden()
        }
        const to = { x: place.offset.x * depth / shown, y: -place.offset.y * depth / shown }
        if (timing === null) {
            this.walk = null
            this.position = to
            this.placed = true
            return
        }
        this.walk = { from: { ...this.position }, to, start: performance.now(), duration: timing.duration, timing }
    }

    public nightfall(night: boolean) {
        this.nightTarget = night ? 1 : 0
    }

    public walking() {
        return this.walk !== null || this.placed || this.bursts.length > 0
    }

    public settle() {
        if (this.walk) this.position = { ...this.walk.to }
        this.walk = null
        this.night = this.nightTarget
    }

    public draw(time: number) {
        const scale = Math.min(window.devicePixelRatio, 1.5)
        const width = Math.max(1, Math.round(this.canvas.clientWidth * scale))
        const height = Math.max(1, Math.round(this.canvas.clientHeight * scale))
        const size = this.renderer.getSize(new THREE.Vector2())
        if (size.x !== width || size.y !== height) {
            this.renderer.setPixelRatio(1)
            this.renderer.setSize(width, height, false)
            this.composer.setSize(width, height)
            this.bloom.resolution.set(width, height)
        }

        const step = this.last ? Math.min((time - this.last) / 1000, 0.1) : 0
        this.last = time
        if (this.walk) {
            const elapsed = time - this.walk.start
            const along = progressAt(this.walk.timing, elapsed)
            this.position = { x: this.walk.from.x + (this.walk.to.x - this.walk.from.x) * along, y: this.walk.from.y + (this.walk.to.y - this.walk.from.y) * along }
            if (elapsed >= this.walk.duration) this.walk = null
        }
        this.placed = false
        this.night += (this.nightTarget - this.night) * (1 - Math.exp(-step * 0.8))

        // The camera shows exactly one view, straight down, where the view is.
        const halfWidth = this.canvas.clientWidth / shown / 2, halfHeight = this.canvas.clientHeight / shown / 2
        Object.assign(this.camera, { left: -halfWidth, right: halfWidth, top: halfHeight, bottom: -halfHeight })
        this.camera.updateProjectionMatrix()
        this.camera.position.set(this.position.x, this.position.y, 10)

        // The pointer, in the garden, where it is now under a camera that may be moving.
        const target = this.pointer ? 1 : 0
        this.pointerPresence += (target - this.pointerPresence) * (1 - Math.exp(-step * 6))
        if (this.pointer) this.shared.pointer.value.set(this.position.x - halfWidth + this.pointer.x / shown, this.position.y + halfHeight - this.pointer.y / shown)

        this.shared.time.value = (performance.now() - this.start) / 1000
        this.shared.night.value = this.night
        this.shared.pointerOn.value = this.pointerPresence
        this.grade.uniforms.night!.value = this.night
        // By night the lights carry the scene, so they glow more.
        this.bloom.strength = 0.22 + this.night * 0.33
        this.bloom.threshold = 0.9 - this.night * 0.5

        for (const burst of [...this.bursts]) {
            const age = (performance.now() - burst.born) / 1000
            ;(burst.mesh.material as THREE.ShaderMaterial).uniforms.age!.value = age
            if (age > 1.6) {
                this.scene.remove(burst.mesh)
                burst.mesh.geometry.dispose()
                this.bursts.splice(this.bursts.indexOf(burst), 1)
            }
        }

        this.composer.render()
    }

    /** Plants a seed where the pointer is, in a bed, with room around it. */
    private plant(x: number, y: number) {
        const halfWidth = this.canvas.clientWidth / shown / 2, halfHeight = this.canvas.clientHeight / shown / 2
        const world = { x: this.position.x - halfWidth + x / shown, y: this.position.y + halfHeight - y / shown }
        const cell = { x: Math.round(world.x / this.view.width), y: Math.round(-world.y / this.view.height) }
        const reach = (this.cells - 1) / 2
        if (Math.abs(cell.x) > reach || Math.abs(cell.y) > reach) return
        const u = (world.x - (cell.x * this.view.width - this.view.width / 2)) / this.view.width
        const v = ((-cell.y * this.view.height + this.view.height / 2) - world.y) / this.view.height
        if (!bedAt(cell, u, v)) return
        const near = [...sownOf(cell), ...this.kept.filter(planting => planting.cell.x === cell.x && planting.cell.y === cell.y)]
        if (near.some(planting => Math.hypot((planting.at.u - u) * this.view.width / this.view.height, planting.at.v - v) < spacing)) return

        const planting: Planting = { cell, at: { u, v }, kind: kindFor(Math.random), planted: Date.now() }
        this.kept = [...this.kept, planting].slice(-most)
        this.plantGarden()
        this.burst(world)
        void this.program.store.set(plantingsKey, this.kept)
    }

    /** Lays out the whole garden again: the lawn, every bed, and everything growing in them. */
    private plantGarden() {
        if (!this.view.width) return
        if (this.garden) {
            this.scene.remove(this.garden)
            this.garden.traverse(object => { if (object instanceof THREE.Mesh) object.geometry.dispose() })
        }
        const garden = new THREE.Group()
        const reach = (this.cells - 1) / 2
        const cells: Cell[] = []
        for (let y = -reach; y <= reach; y++) for (let x = -reach; x <= reach; x++) cells.push({ x, y })

        garden.add(lawn(this.shared, (this.cells + 2) * this.view.width, (this.cells + 2) * this.view.height))
        garden.add(beds(this.shared, cells.flatMap(cell => bedsOf(cell).map(bed => this.rectOf(cell, bed)))))
        const plantings = [...cells.flatMap(cell => sownOf(cell)), ...this.kept]
        garden.add(plants(this.shared, plantings.map(planting => this.plantOf(planting))))
        this.garden = garden
        this.scene.add(garden)
    }

    private rectOf(cell: Cell, bed: ReturnType<typeof bedsOf>[number]) {
        const left = cell.x * this.view.width - this.view.width / 2, top = -cell.y * this.view.height + this.view.height / 2
        const x0 = left + bed.left * this.view.width, x1 = left + bed.right * this.view.width
        const y0 = top - bed.bottom * this.view.height, y1 = top - bed.top * this.view.height
        return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, halfWidth: (x1 - x0) / 2, halfHeight: (y1 - y0) / 2 }
    }

    private plantOf(planting: Planting) {
        const left = planting.cell.x * this.view.width - this.view.width / 2, top = -planting.cell.y * this.view.height + this.view.height / 2
        const kind = kinds[planting.kind]!
        return {
            x: left + planting.at.u * this.view.width,
            y: top - planting.at.v * this.view.height,
            radius: kind.size * this.view.height,
            kind,
            // Planted before this scene opened is a negative age; sown with the garden is long grown.
            born: planting.planted === 0 ? -growing * 4 : (planting.planted - this.startedAt) / 1000,
            seed: seeded(planting.at.u * 997 + planting.at.v * 613 + planting.kind)()
        }
    }

    /** A ring of light where a seed goes in. */
    private burst(at: { x: number, y: number }) {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.ShaderMaterial({
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
            uniforms: { age: { value: 0 }, night: this.shared.night },
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
            fragmentShader: /* glsl */`
                uniform float age; uniform float night; varying vec2 vUv;
                void main() {
                    float d = length(vUv - 0.5) * 2.0;
                    float radius = 0.15 + age * 0.55;
                    float ring = smoothstep(0.1, 0.0, abs(d - radius)) * max(0.0, 1.0 - age / 1.6);
                    float core = smoothstep(0.25, 0.0, d) * max(0.0, 1.0 - age * 1.4);
                    gl_FragColor = vec4(vec3(1.0, 0.86, 0.6) * (ring * 0.9 + core * 1.4) * (0.8 + night * 0.6), 1.0);
                }`
        }))
        mesh.position.set(at.x, at.y, 3)
        this.scene.add(mesh)
        this.bursts.push({ mesh, born: performance.now() })
    }
}

type Shared = Record<string, THREE.IUniform>

// Shared GLSL: a little noise, and the light every surface takes, the sun by day, the moon and the
// pointer's small light by night.
const common = /* glsl */`
uniform float night; uniform vec2 pointer; uniform float pointerOn; uniform float time;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec3 lit(vec3 color, vec2 world) {
    vec2 d = world - pointer;
    float lantern = exp(-dot(d, d) / 1.1) * pointerOn;
    vec3 day = color * (1.0 + lantern * 0.06);
    // By night a surface keeps some of its colour, cooled a little, and the pointer's light warms it.
    vec3 moon = color * vec3(0.2, 0.21, 0.3) + color * lantern * vec3(1.0, 0.78, 0.5) * 1.3;
    return mix(day, moon, night);
}
`

const worldVertex = /* glsl */`
varying vec2 vWorld;
void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xy;
    gl_Position = projectionMatrix * viewMatrix * w;
}`

/** The lawn between the beds, mown in stripes, with clover in patches. */
function lawn(shared: Shared, width: number, height: number) {
    const material = new THREE.ShaderMaterial({
        uniforms: { ...shared },
        vertexShader: worldVertex,
        fragmentShader: common + /* glsl */`
            varying vec2 vWorld;
            void main() {
                vec2 w = vWorld;
                // Colours here are linear light, as the renderer blends them, not the display's values.
                vec3 lawn = mix(vec3(0.05, 0.15, 0.035), vec3(0.085, 0.21, 0.06), noise(w * 0.35));
                // Mown in stripes, the way a lawn looks from above.
                float stripe = step(0.5, fract(w.x / 0.9)) * 2.0 - 1.0;
                lawn *= 1.0 + stripe * 0.04;
                lawn *= 0.88 + noise(w * 2.4) * 0.14 + noise(w * 16.0) * 0.1;
                // Clover, a bluer green, in loose patches.
                lawn = mix(lawn, vec3(0.045, 0.17, 0.09), smoothstep(0.6, 0.72, noise(w * 2.2 + 5.0)) * 0.3);
                gl_FragColor = vec4(lit(lawn, w), 1.0);
            }`
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
    mesh.renderOrder = 0
    return mesh
}

/** Raised beds of dark soil in timber frames, each casting a soft shadow on the lawn. */
function beds(shared: Shared, rects: readonly { x: number, y: number, halfWidth: number, halfHeight: number }[]) {
    const margin = 0.2
    const geometry = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    geometry.index = quad.index
    geometry.setAttribute("position", quad.attributes.position!)
    geometry.setAttribute("rect", new THREE.InstancedBufferAttribute(new Float32Array(rects.flatMap(rect => [rect.x, rect.y, rect.halfWidth, rect.halfHeight])), 4))
    geometry.instanceCount = rects.length
    const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { margin: { value: margin }, ...shared },
        vertexShader: /* glsl */`
            attribute vec4 rect; uniform float margin; varying vec2 vLocal; varying vec2 vHalf; varying vec2 vWorld;
            void main() {
                vHalf = rect.zw;
                vLocal = position.xy * 2.0 * (rect.zw + margin);
                vWorld = rect.xy + vLocal;
                gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0, 1.0);
            }`,
        fragmentShader: common + /* glsl */`
            varying vec2 vLocal; varying vec2 vHalf; varying vec2 vWorld;
            float box(vec2 p, vec2 extent, float r) { vec2 q = abs(p) - extent + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
            void main() {
                float d = box(vLocal, vHalf, 0.08);
                // Light from the upper left: the shadow falls down and to the right.
                float shadow = (1.0 - smoothstep(-0.02, 0.16, box(vLocal - vec2(0.07, -0.09), vHalf, 0.08))) * 0.42;
                if (d > 0.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, shadow * (1.0 - night * 0.5)); return; }
                float frame = 0.09;
                vec3 color;
                if (d > -frame) {
                    // Timber, with its grain along the frame, lit on its upper edge.
                    float grain = noise(vec2(vWorld.x * 3.0 + vWorld.y * 3.0, (vWorld.x - vWorld.y) * 40.0));
                    color = mix(vec3(0.3, 0.15, 0.065), vec3(0.42, 0.23, 0.11), grain) * (0.85 + smoothstep(-frame, 0.0, d) * 0.25);
                } else {
                    // Soil, dark and crumbly, in rows along the bed, darker near the frame.
                    bool wide = vHalf.x > vHalf.y;
                    float across = wide ? vLocal.y : vLocal.x;
                    float furrow = 0.5 + 0.5 * sin(across * 6.2831 / 0.26);
                    color = vec3(0.1, 0.055, 0.032) * (0.8 + noise(vWorld * 9.0) * 0.35 + noise(vWorld * 40.0) * 0.2) * (0.85 + furrow * 0.22);
                    // A little darker in the frame's shadow along its inner edge.
                    color *= 0.7 + smoothstep(-frame, -frame - 0.3, d) * 0.3;
                }
                gl_FragColor = vec4(lit(color, vWorld), 1.0);
            }`
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 1
    return mesh
}

type PlantPlacing = Readonly<{ x: number, y: number, radius: number, kind: typeof kinds[number], born: number, seed: number }>

/**
 * Every plant, seen from above, drawn by one shader on one quad each: a rosette of leaves that
 * grows from a seed, and the flower that opens over it last. A plant leans away from the pointer
 * and sways a little in the air.
 */
function plants(shared: Shared, placings: readonly PlantPlacing[]) {
    const geometry = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    geometry.index = quad.index
    geometry.setAttribute("position", quad.attributes.position!)
    const color = (hex: string) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b] }
    geometry.setAttribute("place", new THREE.InstancedBufferAttribute(new Float32Array(placings.flatMap(p => [p.x, p.y, p.radius])), 3))
    geometry.setAttribute("shape", new THREE.InstancedBufferAttribute(new Float32Array(placings.flatMap(p => [p.kind.leaves, p.kind.petals, p.born, p.seed])), 4))
    geometry.setAttribute("leafColor", new THREE.InstancedBufferAttribute(new Float32Array(placings.flatMap(p => color(p.kind.leaf))), 3))
    geometry.setAttribute("petalColor", new THREE.InstancedBufferAttribute(new Float32Array(placings.flatMap(p => color(p.kind.petal))), 3))
    geometry.setAttribute("heartColor", new THREE.InstancedBufferAttribute(new Float32Array(placings.flatMap(p => color(p.kind.heart))), 3))
    geometry.instanceCount = placings.length

    const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { growing: { value: growing }, ...shared },
        vertexShader: /* glsl */`
            attribute vec3 place; attribute vec4 shape; attribute vec3 leafColor; attribute vec3 petalColor; attribute vec3 heartColor;
            uniform float time; uniform vec2 pointer; uniform float pointerOn; uniform float growing;
            varying vec2 vLocal; varying vec2 vWorld; varying vec4 vShape; varying float vGrowth; varying vec2 vLean;
            varying vec3 vLeaf; varying vec3 vPetal; varying vec3 vHeart;
            void main() {
                float room = 1.45;
                vLocal = position.xy * 2.0 * room;
                vWorld = place.xy + vLocal * place.z;
                vShape = shape;
                vGrowth = clamp((time - shape.z) / growing, 0.0, 1.0);
                // Away from the pointer, most when it is near, and a little with the air.
                vec2 away = place.xy - pointer;
                float near = exp(-dot(away, away) / 0.5) * pointerOn;
                vLean = (length(away) > 0.0001 ? normalize(away) : vec2(0.0)) * near * 0.28
                    + vec2(sin(time * 1.1 + shape.w * 40.0), cos(time * 0.8 + shape.w * 23.0)) * 0.035;
                vLeaf = leafColor; vPetal = petalColor; vHeart = heartColor;
                gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 2.0, 1.0);
            }`,
        fragmentShader: common + /* glsl */`
            varying vec2 vLocal; varying vec2 vWorld; varying vec4 vShape; varying float vGrowth; varying vec2 vLean;
            varying vec3 vLeaf; varying vec3 vPetal; varying vec3 vHeart;
            vec2 turn(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x + s * p.y, -s * p.x + c * p.y); }
            // How far inside the leaves a point is (negative inside), and how far along its leaf.
            vec2 leavesAt(vec2 p, float count, float span, float spin) {
                float best = 10.0, along = 0.0;
                for (int i = 0; i < 8; i++) {
                    if (float(i) >= count) break;
                    vec2 q = turn(p, spin + float(i) * 6.2831 / count);
                    vec2 r = vec2(span * 0.5, span * 0.19);
                    float d = (length((q - vec2(span * 0.5, 0.0)) / r) - 1.0) * r.y;
                    if (d < best) { best = d; along = q.x / max(span, 0.001); }
                }
                return vec2(best, along);
            }
            // The same for the petals, and how far out along its petal.
            vec2 petalsAt(vec2 p, float count, float radius, float spin) {
                float best = 10.0, along = 0.0;
                for (int i = 0; i < 18; i++) {
                    if (float(i) >= count) break;
                    vec2 q = turn(p, spin + float(i) * 6.2831 / count);
                    vec2 r = vec2(radius * 0.5, radius * (count > 8.0 ? 0.13 : 0.27));
                    float d = (length((q - vec2(radius * 0.52, 0.0)) / r) - 1.0) * r.y;
                    if (d < best) { best = d; along = q.x / max(radius, 0.001); }
                }
                return vec2(best, along);
            }
            void main() {
                float g = vGrowth;
                float seed = vShape.w;
                float spin = seed * 6.2831 + sin(time * 0.6 + seed * 30.0) * 0.05;
                // A sprout has two leaves; the rosette fills in as it grows.
                float count = g < 0.3 ? 2.0 : vShape.x;
                float span = mix(0.28, 1.0, smoothstep(0.08, 0.7, g));
                float open = vShape.y > 0.0 ? smoothstep(0.7, 1.0, g) : 0.0;
                float radius = 0.66 * open;
                vec2 head = vLocal - vLean * g * 3.0;

                // The shadow of the whole plant, cast down and to the right.
                vec2 fall = vec2(0.14, -0.18) * (0.4 + g);
                float shadowLeaves = leavesAt(vLocal - fall, count, span, spin).x;
                float shadowPetals = open > 0.0 ? petalsAt(head - fall, vShape.y, radius, spin * 1.7).x : 10.0;
                float shade = (1.0 - smoothstep(-0.02, 0.12, min(shadowLeaves, shadowPetals))) * 0.35 * smoothstep(0.05, 0.2, g);

                vec4 color = vec4(0.0, 0.0, 0.0, shade * (1.0 - night * 0.4));
                // How much of this point is flower, for the glow a flower keeps by night.
                float flowering = 0.0;

                // A seed not yet up: a small mound of turned soil, and the seed in it.
                if (g < 0.1) {
                    float mound = smoothstep(0.3, 0.2, length(vLocal));
                    color = mix(color, vec4(0.14, 0.08, 0.045, 1.0), mound);
                    color = mix(color, vec4(0.5, 0.38, 0.2, 1.0), smoothstep(0.08, 0.05, length(vLocal - vec2(0.03, 0.02))));
                }

                vec2 leaf = leavesAt(vLocal, count, span, spin);
                if (leaf.x < 0.02 && g >= 0.06) {
                    float inside = smoothstep(0.02, -0.01, leaf.x);
                    vec3 green = vLeaf * (0.72 + leaf.y * 0.45);
                    // The rib down each leaf, and a darker edge.
                    green *= 1.0 - smoothstep(-0.05, 0.0, leaf.x) * 0.25;
                    color = mix(color, vec4(green, 1.0), inside);
                }
                if (open > 0.0) {
                    vec2 petal = petalsAt(head, vShape.y, radius, spin * 1.7);
                    if (petal.x < 0.02) {
                        float inside = smoothstep(0.02, -0.01, petal.x);
                        vec3 bloom = vPetal * (0.78 + petal.y * 0.35) * (1.0 - smoothstep(-0.04, 0.0, petal.x) * 0.18);
                        color = mix(color, vec4(bloom, 1.0), inside);
                        flowering = inside;
                    }
                    float heart = length(head) - radius * 0.26;
                    color = mix(color, vec4(vHeart * (0.85 + noise(head * 30.0) * 0.3), 1.0), smoothstep(0.02, -0.01, heart));
                }
                if (color.a < 0.004) discard;
                vec3 shown = color.rgb;
                // Lit like everything else, but a flower keeps a little glow of its own by night.
                // Pale flowers need less of it, or they shine instead of glowing.
                float pale = min(min(vPetal.r, vPetal.g), vPetal.b);
                vec3 glow = vPetal * (0.26 - pale * 0.2) * night * flowering;
                // Every part is lit, its soft edges too, or they would show as bright lines by night.
                gl_FragColor = vec4(lit(shown, vWorld) + glow, color.a);
            }`
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.renderOrder = 2
    return mesh
}

/** Pollen in the light by day; by night, fireflies in many colours. They drift over wherever the camera is. */
function air(shared: Shared) {
    const random = seeded(29)
    const count = 180
    const places = new Float32Array(count * 2), seeds = new Float32Array(count)
    for (let i = 0; i < count; i++) {
        places.set([(random() - 0.5) * 32, (random() - 0.5) * 22], i * 2)
        seeds[i] = random()
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    geometry.setAttribute("spot", new THREE.BufferAttribute(places, 2))
    geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 1))
    const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { ...shared },
        vertexShader: /* glsl */`
            attribute vec2 spot; attribute float seed; uniform float time;
            varying float vSeed; varying float vPulse;
            void main() {
                vSeed = seed;
                vec2 drift = vec2(sin(time * 0.21 + seed * 40.0) * 0.8 + time * 0.04, cos(time * 0.17 + seed * 23.0) * 0.6);
                // They fill a wide box around the camera, wrapping at its edges, so they are always about.
                vec2 around = cameraPosition.xy;
                vec2 p = spot + drift;
                p = around + mod(p - around + vec2(16.0, 11.0), vec2(32.0, 22.0)) - vec2(16.0, 11.0);
                vPulse = pow(max(0.0, sin(time * (0.4 + seed * 0.6) + seed * 50.0)), 2.0);
                gl_PointSize = (3.0 + seed * 4.0) * (1.0 + vPulse * 1.5);
                gl_Position = projectionMatrix * viewMatrix * vec4(p, 4.0, 1.0);
            }`,
        fragmentShader: /* glsl */`
            uniform float night; varying float vSeed; varying float vPulse;
            void main() {
                float d = length(gl_PointCoord - 0.5);
                float soft = smoothstep(0.5, 0.0, d);
                vec3 pollen = vec3(1.0, 0.95, 0.8) * soft * 0.18;
                // Fireflies in four colours: green-gold, rose, sky, and amber.
                vec3 hue = vSeed < 0.25 ? vec3(0.75, 1.0, 0.4) : vSeed < 0.5 ? vec3(1.0, 0.55, 0.8) : vSeed < 0.75 ? vec3(0.45, 0.85, 1.0) : vec3(1.0, 0.78, 0.35);
                vec3 fly = hue * (soft * soft * 1.2 + smoothstep(0.15, 0.0, d) * 1.6) * vPulse;
                gl_FragColor = vec4(mix(pollen * (1.0 - vPulse * 0.5), fly, night), 1.0);
            }`
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    points.renderOrder = 4
    return points
}

/** The last touch: the light falls from the upper left by day, and the edges darken by night. */
function gradeShader() {
    return {
        uniforms: { tDiffuse: { value: null }, night: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
            uniform sampler2D tDiffuse; uniform float night; varying vec2 vUv;
            void main() {
                vec3 color = texture2D(tDiffuse, vUv).rgb;
                float sun = 1.0 - distance(vUv, vec2(0.1, 0.95)) * 0.35;
                float edge = 1.0 - pow(distance(vUv, vec2(0.5)) * 1.25, 2.4);
                vec3 day = color * mix(0.92, 1.08, sun) + vec3(1.0, 0.9, 0.75) * max(0.0, sun - 0.8) * 0.12;
                vec3 dark = color * mix(0.55, 1.0, clamp(edge, 0.0, 1.0));
                gl_FragColor = vec4(mix(day, dark, night), 1.0);
            }`
    }
}
