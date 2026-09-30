import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"
import { progressAt, type Transaction } from "@phreshos/core"
import type { Place, Scene } from "../scene"
import { seeded } from "../seedbeds/plan"

// The camera stands this high over the meadow, looking straight down: high enough that the
// ground moves slowly under it while the windows glide past close by.
const height = 10
const fieldOfView = 40
// The ground moves at this share of the windows' pace: the meadow is far below them.
const depth = 0.35
// How far the meadow reaches from its middle, in units; the camera never nears its edge.
const reach = 16
const trailLength = 24
// Each pixel drawn covers this many pixels of the screen: a soft pixel look, and a quarter of the
// work at twice the density, which is what keeps the meadow light behind the windows.
const pixel = 3

/**
 * A spring meadow seen from the sky: grass that the wind combs in waves, wildflowers in loose
 * patches, cloud shadows drifting over, and bees going from flower to flower. The pointer parts
 * the grass as it passes, and the bees keep clear of it; by night they rest and fireflies rise.
 */
export default class Meadow implements Scene {

    private readonly renderer: THREE.WebGLRenderer
    private readonly scene = new THREE.Scene()
    private readonly camera = new THREE.PerspectiveCamera(fieldOfView, 1, 0.1, 100)
    private readonly composer: EffectComposer
    private readonly bloom: UnrealBloomPass
    private readonly grade: ShaderPass

    private readonly start = performance.now()
    private readonly shared = {
        time: { value: 0 },
        night: { value: 0 },
        pointer: { value: new THREE.Vector2(0, 0) },
        pointerOn: { value: 0 },
        // Where the pointer has passed lately, and when: the grass it parted rises again slowly.
        // Where the pointer has passed lately: the place and time (x, y, z), and how hard it swept (w).
        trail: { value: Array.from({ length: trailLength }, () => new THREE.Vector4(0, 0, -100, 0)) },
        // Which way it was going there.
        sweep: { value: Array.from({ length: trailLength }, () => new THREE.Vector2(1, 0)) }
    }

    /** Where the view is, in Desktop pixels; turned into the camera's place when drawn. */
    private position = { x: 0, y: 0 }
    private walk: Readonly<{ from: { x: number, y: number }, to: { x: number, y: number }, start: number, duration: number, timing: Transaction }> | null = null

    private night = 0
    private nightTarget = 0
    private last = 0

    private pointer: { x: number, y: number } | null = null
    private lastPointer = 0
    private pointerPresence = 0
    private trailIndex = 0
    private lastTrailTime = 0
    private lastTrail = new THREE.Vector2(1e9, 1e9)

    private readonly bees: Bees

    public constructor(private readonly canvas: HTMLCanvasElement) {
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "low-power" })
        // Drawn small and shown large, with its pixels kept square rather than smeared.
        canvas.style.imageRendering = "pixelated"
        this.renderer.toneMapping = THREE.NoToneMapping
        this.camera.up.set(0, 1, 0)

        this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }))
        this.composer.addPass(new RenderPass(this.scene, this.camera))
        this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.7, 0.9)
        this.composer.addPass(this.bloom)
        this.grade = new ShaderPass(gradeShader())
        this.composer.addPass(this.grade)
        this.composer.addPass(new OutputPass())

        const flowerField = flowers(this.shared)
        this.bees = new Bees(this.shared, flowerField.spots)
        this.scene.add(ground(this.shared), grass(this.shared), flowerField.mesh, this.bees.mesh, fireflies(this.shared))

        canvas.addEventListener("pointermove", event => { this.pointer = { x: event.offsetX, y: event.offsetY }; this.lastPointer = performance.now() })
        canvas.addEventListener("pointerleave", () => { this.pointer = null })
    }

    public look(place: Place, timing: Transaction | null) {
        const to = { x: place.offset.x, y: place.offset.y }
        if (timing === null) {
            this.walk = null
            this.position = to
            return
        }
        this.walk = { from: { ...this.position }, to, start: performance.now(), duration: timing.duration, timing }
    }

    public nightfall(night: boolean) {
        this.nightTarget = night ? 1 : 0
    }

    // Every frame while the view moves or the pointer is in the grass, so both stay smooth; the
    // bees and the wind are content with the wallpaper's calmer pace otherwise.
    public walking() {
        return this.walk !== null || performance.now() - this.lastPointer < 1500
    }

    public settle() {
        if (this.walk) this.position = { ...this.walk.to }
        this.walk = null
        this.night = this.nightTarget
    }

    public draw(time: number) {
        const width = Math.max(1, Math.ceil(this.canvas.clientWidth / pixel))
        const heightPixels = Math.max(1, Math.ceil(this.canvas.clientHeight / pixel))
        const size = this.renderer.getSize(new THREE.Vector2())
        if (size.x !== width || size.y !== heightPixels) {
            this.renderer.setPixelRatio(1)
            this.renderer.setSize(width, heightPixels, false)
            this.composer.setSize(width, heightPixels)
            this.bloom.resolution.set(width, heightPixels)
            this.camera.aspect = width / heightPixels
            this.camera.updateProjectionMatrix()
        }

        const step = this.last ? Math.min((time - this.last) / 1000, 0.1) : 0
        this.last = time
        if (this.walk) {
            const elapsed = time - this.walk.start
            const along = progressAt(this.walk.timing, elapsed)
            this.position = { x: this.walk.from.x + (this.walk.to.x - this.walk.from.x) * along, y: this.walk.from.y + (this.walk.to.y - this.walk.from.y) * along }
            if (elapsed >= this.walk.duration) this.walk = null
        }
        this.night += (this.nightTarget - this.night) * (1 - Math.exp(-step * 0.8))

        // How many Desktop pixels one unit of the ground covers on screen, from this height.
        const groundHeight = 2 * height * Math.tan(THREE.MathUtils.degToRad(fieldOfView / 2))
        const unitPixels = this.canvas.clientHeight / groundHeight
        const x = this.position.x * depth / unitPixels, y = -this.position.y * depth / unitPixels
        this.camera.position.set(x, y, height)
        this.camera.lookAt(x, y, 0)

        const seconds = (performance.now() - this.start) / 1000
        const target = this.pointer ? 1 : 0
        this.pointerPresence += (target - this.pointerPresence) * (1 - Math.exp(-step * 6))
        if (this.pointer) {
            // Straight down, a point on the screen falls on the ground this far from the camera's foot.
            const ground = new THREE.Vector2(x + (this.pointer.x / this.canvas.clientWidth - 0.5) * groundHeight * this.camera.aspect, y - (this.pointer.y / this.canvas.clientHeight - 0.5) * groundHeight)
            this.shared.pointer.value.copy(ground)
            const moved = ground.distanceTo(this.lastTrail)
            if (moved > 0.08) {
                // A fast sweep presses the grass harder than a slow pass; a jump (the pointer coming
                // back from elsewhere) is no sweep at all.
                const speed = moved / Math.max(seconds - this.lastTrailTime, 0.016)
                const strength = moved > 1.5 ? 0 : Math.min(1, Math.max(0.3, speed / 3))
                this.shared.trail.value[this.trailIndex]!.set(ground.x, ground.y, seconds, strength)
                this.shared.sweep.value[this.trailIndex]!.copy(ground.clone().sub(this.lastTrail).normalize())
                this.trailIndex = (this.trailIndex + 1) % trailLength
                this.lastTrail.copy(ground)
                this.lastTrailTime = seconds
            }
        }

        this.shared.time.value = seconds
        this.shared.night.value = this.night
        this.shared.pointerOn.value = this.pointerPresence
        this.grade.uniforms.night!.value = this.night
        this.bloom.strength = 0.2 + this.night * 0.35
        this.bloom.threshold = 0.9 - this.night * 0.45

        this.bees.update(step, seconds, this.pointer ? this.shared.pointer.value : null, this.night)
        this.composer.render()
    }
}

type Shared = Record<string, THREE.IUniform>

const common = /* glsl */`
uniform float time; uniform float night; uniform vec2 pointer; uniform float pointerOn;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
// The wind, as the brightness of the grass it combs: long waves running across the meadow.
float wave(vec2 w) {
    vec2 along = normalize(vec2(1.0, 0.35));
    float phase = dot(w, along) * 0.55 - time * 0.9 + fbm(w * 0.18) * 3.0;
    return pow(0.5 + 0.5 * sin(phase), 3.0);
}
// The shadows of clouds high above, drifting slowly over.
float cloud(vec2 w) {
    return smoothstep(0.48, 0.7, fbm(w * 0.045 + vec2(time * 0.012, time * 0.006)));
}
vec3 moonlit(vec3 color) {
    return color * vec3(0.09, 0.12, 0.2);
}
`

/** The meadow floor: grass in its many greens, combed by the wind, parted where the pointer passed. */
function ground(shared: Shared) {
    const material = new THREE.ShaderMaterial({
        uniforms: { ...shared },
        vertexShader: /* glsl */`varying vec2 vWorld; void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xy; gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: common + /* glsl */`
            uniform vec4 trail[${trailLength}];
            varying vec2 vWorld;
            void main() {
                vec2 w = vWorld;
                // The floor under the blades: dark, earthy green, seen only between them.
                // Close to the grass's own green, so the fewer, wider blades still read as a full meadow.
                vec3 grass = mix(vec3(0.06, 0.15, 0.03), vec3(0.1, 0.22, 0.04), fbm(w * 0.5)) * (0.8 + noise(w * 30.0) * 0.4);
                // Where the wind presses the blades over, their paler sides show.
                float gust = wave(w);
                grass *= 1.0 + gust * 0.2;
                // Where the pointer passed, the grass lies flattened a while, and rises again.
                float parted = 0.0;
                for (int i = 0; i < ${trailLength}; i++) {
                    vec4 t = trail[i];
                    float age = time - t.z;
                    if (age < 0.0 || age > 3.0) continue;
                    vec2 d = w - t.xy;
                    parted = max(parted, exp(-dot(d, d) / 0.03) * exp(-age * 1.6) * t.w);
                }
                vec2 d = w - pointer;
                parted = max(parted, exp(-dot(d, d) / 0.03) * pointerOn * 0.4);
                // Where the blades are pressed aside, the floor is lit a little more.
                grass *= 1.0 + parted * 0.5;
                vec3 day = grass * (1.0 - cloud(w) * 0.32);
                gl_FragColor = vec4(mix(day, moonlit(grass) * (1.0 + gust * 0.3), night), 1.0);
            }`
    })
    return new THREE.Mesh(new THREE.PlaneGeometry(reach * 2 + 24, reach * 2 + 24), material)
}

/**
 * The grass itself: a few hundred thousand blades standing up from the floor, each leaning its own
 * way, bent by the wind in waves and pressed aside where the pointer passes. They fill a tile around
 * the camera, and a blade that leaves it on one side comes back on the other, so the meadow never
 * ends and each blade still stands still on the ground.
 */
function grass(shared: Shared) {
    const tile = { x: 18, y: 12 }
    const random = seeded(71)
    const count = 240000
    const spots = new Float32Array(count * 3), shapes = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
        spots.set([(random() - 0.5) * tile.x, (random() - 0.5) * tile.y, 0.14 + random() * random() * 0.22], i * 3)
        shapes.set([random() * Math.PI * 2, 0.45 + random() * 0.6, 0.04 + random() * 0.03, random()], i * 4)
    }
    const blade = new THREE.PlaneGeometry(1, 1, 1, 3).translate(0, 0.5, 0)
    const geometry = new THREE.InstancedBufferGeometry()
    geometry.index = blade.index
    geometry.setAttribute("position", blade.attributes.position!)
    geometry.setAttribute("uv", blade.attributes.uv!)
    geometry.setAttribute("spot", new THREE.InstancedBufferAttribute(spots, 3))
    geometry.setAttribute("shape", new THREE.InstancedBufferAttribute(shapes, 4))
    geometry.instanceCount = count
    const material = new THREE.ShaderMaterial({
        side: THREE.DoubleSide,
        uniforms: { tile: { value: new THREE.Vector2(tile.x, tile.y) }, ...shared },
        vertexShader: common + /* glsl */`
            uniform vec2 tile; uniform vec4 trail[${trailLength}]; uniform vec2 sweep[${trailLength}];
            attribute vec3 spot; attribute vec4 shape;
            varying float vUp; varying float vSeed; varying vec2 vWorld; varying float vGust; varying float vPressed;
            void main() {
                float h = uv.y;
                vec2 around = cameraPosition.xy;
                vec2 base = around + mod(spot.xy - around + tile * 0.5, tile) - tile * 0.5;
                // Its own lean, the wind's waves, and the pointer pressing it aside.
                vec2 lean = vec2(cos(shape.x), sin(shape.x)) * shape.y;
                float gust = wave(base);
                // The wind, and the tip's own flutter, quicker and smaller.
                vec2 wind = vec2(1.0, 0.35) * (0.06 + gust * 0.38)
                    + vec2(sin(time * 2.3 + shape.w * 40.0), cos(time * 1.9 + shape.w * 30.0)) * 0.08
                    + vec2(sin(time * 5.1 + shape.w * 70.0), cos(time * 4.3 + shape.w * 55.0)) * 0.03;
                vec2 press = vec2(0.0);
                for (int i = 0; i < ${trailLength}; i++) {
                    vec4 t = trail[i];
                    float age = time - t.z;
                    if (age < 0.0 || age > 3.0) continue;
                    vec2 d = base - t.xy;
                    float touch = exp(-dot(d, d) / 0.045);
                    if (touch < 0.01) continue;
                    // Swept along with the hand more than pushed out from it, and springing back with a
                    // little swing past upright before it settles.
                    vec2 way = normalize(mix(sweep[i], normalize(d + 0.0001), 0.3));
                    // A soft spring: it gives way at once, and rises again slowly, with a small swing.
                    float spring = exp(-age * 1.5) * cos(age * 4.2);
                    press += way * touch * spring * t.w * 3.0;
                }
                // Where the pointer rests, the blades only part a little around it.
                vec2 near = base - pointer;
                press += normalize(near + 0.0001) * exp(-dot(near, near) / 0.03) * pointerOn * 0.9;
                vec2 bend = lean + wind + press;
                float tall = spot.z;
                // A blade keeps its length: bending lays it over along an arc, more toward the tip,
                // and never carries the tip farther than the blade is long.
                float angle = min(1.45, length(bend) * 0.9);
                vec2 way = normalize(bend + 0.0001);
                float along = angle * h;
                float outward = along > 0.001 ? tall * (1.0 - cos(along)) / angle : 0.0;
                float up = along > 0.001 ? tall * sin(along) / angle : tall * h;
                vec2 across = vec2(-way.y, way.x);
                vec2 laid = base + way * outward + across * position.x * shape.z * (1.0 - h * 0.85);
                vUp = h; vSeed = shape.w; vWorld = base; vGust = gust; vPressed = min(1.0, length(press) * 0.5);
                gl_Position = projectionMatrix * viewMatrix * vec4(laid, up, 1.0);
            }`,
        fragmentShader: common + /* glsl */`
            varying float vUp; varying float vSeed; varying vec2 vWorld; varying float vGust; varying float vPressed;
            void main() {
                // Deep at the foot, fresh toward the tip; each blade its own green, some yellower, some bluer.
                vec3 foot = vec3(0.03, 0.08, 0.015);
                vec3 tip = mix(vec3(0.14, 0.4, 0.05), vec3(0.27, 0.47, 0.08), vSeed);
                tip = mix(tip, vec3(0.06, 0.26, 0.1), step(0.82, fract(vSeed * 7.3)) * 0.6);
                vec3 color = mix(foot, tip, smoothstep(0.0, 0.9, vUp)) * (0.85 + fbm(vWorld * 0.25) * 0.3);
                // Blades pressed over by the wind show their paler side.
                color *= 1.0 + vGust * 0.35 * vUp;
                // Blades pressed flat catch more light, so a path swept through the grass shows as a paler streak.
                color = mix(color, color * vec3(1.45, 1.4, 1.15) + vec3(0.02, 0.03, 0.0), vPressed * 0.7);
                vec3 day = color * (1.0 - cloud(vWorld) * 0.35);
                gl_FragColor = vec4(mix(day, moonlit(color) * (1.0 + vGust * 0.4), night), 1.0);
            }`
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    return mesh
}

/** Wildflowers of a spring meadow, as seen from above: a head of petals over the grass, and its shadow. */
const wildflowers = [
    { name: "dandelion", share: 0.24, size: 0.075, petals: 22, petal: "#ffcf1f", heart: "#f2a500" },
    { name: "daisy", share: 0.24, size: 0.06, petals: 16, petal: "#fbf7ef", heart: "#f5c21a" },
    { name: "clover", share: 0.18, size: 0.055, petals: 30, petal: "#c78ad6", heart: "#a45cb8" },
    { name: "buttercup", share: 0.14, size: 0.05, petals: 5, petal: "#ffd83a", heart: "#e7a91e" },
    { name: "speedwell", share: 0.14, size: 0.035, petals: 4, petal: "#6f93ff", heart: "#ffffff" },
    { name: "poppy", share: 0.06, size: 0.085, petals: 4, petal: "#f0402c", heart: "#231519" }
] as const

function flowers(shared: Shared) {
    const random = seeded(41)
    const spots: THREE.Vector2[] = []
    const places: number[] = [], shapes: number[] = [], petals: number[] = [], hearts: number[] = []
    const colour = (hex: string) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b] }
    const pick = () => { let r = random(); for (const kind of wildflowers) { if ((r -= kind.share) <= 0) return kind } return wildflowers[0] }
    // Wildflowers grow in drifts: dense where the ground suits them, sparse between.
    for (let tries = 0; tries < 60000 && places.length / 3 < 9000; tries++) {
        const x = (random() - 0.5) * reach * 2.4, y = (random() - 0.5) * reach * 2.4
        const drift = Math.sin(x * 0.7 + Math.sin(y * 0.5) * 1.5) * Math.cos(y * 0.6 + Math.sin(x * 0.4)) * 0.5 + 0.5
        if (random() > drift * drift * 0.9 + 0.04) continue
        const kind = pick()
        places.push(x, y, kind.size * 1.3 * (0.8 + random() * 0.4))
        shapes.push(kind.petals, random(), kind.name === "clover" ? 1 : 0, random())
        petals.push(...colour(kind.petal))
        hearts.push(...colour(kind.heart))
        if (kind.name !== "poppy" && random() < 0.2) spots.push(new THREE.Vector2(x, y))
    }
    const geometry = new THREE.InstancedBufferGeometry()
    const quad = new THREE.PlaneGeometry(1, 1)
    geometry.index = quad.index
    geometry.setAttribute("position", quad.attributes.position!)
    geometry.setAttribute("place", new THREE.InstancedBufferAttribute(new Float32Array(places), 3))
    geometry.setAttribute("shape", new THREE.InstancedBufferAttribute(new Float32Array(shapes), 4))
    geometry.setAttribute("petalColor", new THREE.InstancedBufferAttribute(new Float32Array(petals), 3))
    geometry.setAttribute("heartColor", new THREE.InstancedBufferAttribute(new Float32Array(hearts), 3))
    geometry.instanceCount = places.length / 3
    const material = new THREE.ShaderMaterial({
        uniforms: { ...shared },
        vertexShader: common + /* glsl */`
            attribute vec3 place; attribute vec4 shape; attribute vec3 petalColor; attribute vec3 heartColor;
            varying vec2 vLocal; varying vec2 vWorld; varying vec4 vShape; varying vec3 vPetal; varying vec3 vHeart; varying float vGust;
            void main() {
                vLocal = position.xy * 2.0 * 1.6;
                vGust = wave(place.xy);
                // The wind tips each head a little along with the grass, and the pointer pushes it aside.
                vec2 away = place.xy - pointer;
                vec2 push = normalize(away + 0.0001) * exp(-dot(away, away) / 0.08) * pointerOn * 0.06;
                vec2 sway = vec2(1.0, 0.35) * (vGust * 0.02 + sin(time * 2.0 + shape.y * 30.0) * 0.004) + push;
                vWorld = place.xy + sway + vLocal * place.z;
                vShape = shape; vPetal = petalColor; vHeart = heartColor;
                // Each head stands at its own height, so some rise clear of the grass and some are half in it.
                gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 0.16 + shape.w * 0.3, 1.0);
            }`,
        fragmentShader: common + /* glsl */`
            varying vec2 vLocal; varying vec2 vWorld; varying vec4 vShape; varying vec3 vPetal; varying vec3 vHeart; varying float vGust;
            vec2 turn(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x + s * p.y, -s * p.x + c * p.y); }
            float head(vec2 p, float count, float spin, bool clover) {
                if (clover) {
                    // A clover head is a ball of tiny florets.
                    float ball = length(p) - 0.62;
                    return ball + (noise(p * 9.0 + vShape.y * 20.0) - 0.5) * 0.12;
                }
                float best = 10.0;
                for (int i = 0; i < 22; i++) {
                    if (float(i) >= count) break;
                    vec2 q = turn(p, spin + float(i) * 6.2831 / count);
                    vec2 r = vec2(0.36, count > 8.0 ? 0.075 : 0.24);
                    best = min(best, (length((q - vec2(0.4, 0.0)) / r) - 1.0) * r.y);
                }
                return best;
            }
            void main() {
                float spin = vShape.y * 6.2831;
                bool clover = vShape.z > 0.5;
                float body = head(vLocal, vShape.x, spin, clover);
                vec4 color = vec4(0.0);
                float inside = smoothstep(0.02, -0.01, body);
                vec3 shade = vPetal * (0.8 + 0.25 * noise(vLocal * 6.0 + vShape.y * 9.0)) * (1.0 - smoothstep(-0.05, 0.0, body) * 0.2);
                color = mix(color, vec4(shade, 1.0), inside);
                float heart = length(vLocal) - (clover ? 0.0 : 0.2);
                color = mix(color, vec4(vHeart * (0.85 + noise(vLocal * 25.0) * 0.3), 1.0), smoothstep(0.02, -0.01, heart) * (clover ? 0.0 : 1.0));
                if (color.a < 0.5) discard;
                vec3 day = color.rgb * (1.0 - cloud(vWorld) * 0.3) * (1.0 + vGust * 0.12);
                vec3 dark = moonlit(color.rgb) + vPetal * inside * 0.05;
                gl_FragColor = vec4(mix(day, dark, night), 1.0);
            }`
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    return { mesh, spots }
}

/**
 * Bees, each on its own errand: it flies to a flower, lingers there, and goes to another near
 * it. Their wings blur as they beat, and each casts a small shadow on the grass below. They keep
 * clear of the pointer, and by night they are home.
 */
class Bees {

    public readonly mesh: THREE.Mesh

    private readonly count = 16
    private readonly state: { at: THREE.Vector3, to: THREE.Vector2, heading: number, linger: number, speed: number }[] = []
    private readonly places: THREE.InstancedBufferAttribute
    private readonly random = seeded(57)

    public constructor(shared: Shared, private readonly flowers: readonly THREE.Vector2[]) {
        for (let i = 0; i < this.count; i++) {
            const from = this.flowerNear(new THREE.Vector2((this.random() - 0.5) * 12, (this.random() - 0.5) * 8))
            this.state.push({ at: new THREE.Vector3(from.x, from.y, 0.4), to: this.flowerNear(from), heading: 0, linger: this.random() * 2, speed: 1.1 + this.random() * 0.5 })
        }
        const geometry = new THREE.InstancedBufferGeometry()
        const quad = new THREE.PlaneGeometry(1, 1)
        geometry.index = quad.index
        geometry.setAttribute("position", quad.attributes.position!)
        this.places = new THREE.InstancedBufferAttribute(new Float32Array(this.count * 4), 4)
        this.places.setUsage(THREE.DynamicDrawUsage)
        geometry.setAttribute("bee", this.places)
        geometry.setAttribute("seed", new THREE.InstancedBufferAttribute(new Float32Array(Array.from({ length: this.count }, () => this.random())), 1))
        geometry.instanceCount = this.count
        const material = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: { ...shared },
            vertexShader: /* glsl */`
                attribute vec4 bee; attribute float seed; uniform float night;
                varying vec2 vLocal; varying float vSeed; varying float vHeight;
                void main() {
                    // A bee is small: a body a few centimetres long, drawn larger only by its blurred wings.
                    float size = 0.16;
                    vec2 local = position.xy * 2.0;
                    float c = cos(bee.w), s = sin(bee.w);
                    vec2 turned = vec2(c * local.x - s * local.y, s * local.x + c * local.y);
                    vLocal = local; vSeed = seed; vHeight = bee.z;
                    // Hidden when resting by night.
                    float shown = 1.0 - night;
                    gl_Position = projectionMatrix * viewMatrix * vec4(bee.xy + turned * size * shown, bee.z, 1.0);
                }`,
            fragmentShader: common + /* glsl */`
                varying vec2 vLocal; varying float vSeed; varying float vHeight;
                float ellipse(vec2 p, vec2 c, vec2 r) { return length((p - c) / r) - 1.0; }
                void main() {
                    vec2 p = vLocal;
                    // Striped body along x, a darker head at its front.
                    float body = ellipse(p, vec2(0.0), vec2(0.42, 0.24));
                    float headDot = ellipse(p, vec2(0.46, 0.0), vec2(0.15, 0.15));
                    float beat = 0.5 + 0.5 * sin(time * 90.0 + vSeed * 50.0);
                    float wings = min(ellipse(p, vec2(0.05, 0.36), vec2(0.28, 0.2 + beat * 0.06)), ellipse(p, vec2(0.05, -0.36), vec2(0.28, 0.2 + beat * 0.06)));
                    vec4 color = vec4(0.0);
                    color = mix(color, vec4(0.85, 0.9, 1.0, 0.45), smoothstep(0.1, -0.1, wings) * step(0.05, vHeight));
                    float stripes = step(0.5, fract(p.x * 4.2 + 0.2));
                    vec3 fur = mix(vec3(0.02, 0.015, 0.01), vec3(0.95, 0.62, 0.08), stripes);
                    color = mix(color, vec4(fur, 1.0), smoothstep(0.06, -0.06, body));
                    color = mix(color, vec4(0.03, 0.025, 0.02, 1.0), smoothstep(0.08, -0.08, headDot));
                    if (color.a < 0.01) discard;
                    gl_FragColor = color;
                }`
        })
        this.mesh = new THREE.Mesh(geometry, material)
        this.mesh.frustumCulled = false
        this.mesh.add(this.shadows(shared))
    }

    public update(step: number, time: number, pointer: THREE.Vector2 | null, night: number) {
        for (const [index, bee] of this.state.entries()) {
            const flat = new THREE.Vector2(bee.at.x, bee.at.y)
            const toward = bee.to.clone().sub(flat)
            const distance = toward.length()
            let height = 1.2
            if (distance < 0.05) {
                // At the flower: it settles on it, and stays a moment before the next.
                bee.linger -= step
                height = 0.5
                if (bee.linger <= 0) { bee.to = this.flowerNear(bee.to); bee.linger = 1.5 + this.random() * 3 }
            } else {
                const heading = Math.atan2(toward.y, toward.x) + Math.sin(time * 3 + index) * 0.35
                bee.heading += Math.atan2(Math.sin(heading - bee.heading), Math.cos(heading - bee.heading)) * Math.min(1, step * 5)
                const move = Math.min(distance, bee.speed * step)
                flat.add(new THREE.Vector2(Math.cos(bee.heading), Math.sin(bee.heading)).multiplyScalar(move))
                // Lower as it nears the flower, and higher in open grass.
                height = 0.5 + Math.min(1, distance) * 0.7
            }
            // The pointer: a bee near it swerves away, and seeks another flower.
            if (pointer) {
                const away = flat.clone().sub(pointer)
                const near = away.length()
                if (near < 0.9) {
                    flat.add(away.normalize().multiplyScalar((0.9 - near) * step * 6))
                    if (distance < 0.3) { bee.to = this.flowerNear(pointer.clone().add(away.multiplyScalar(3))); bee.linger = 0 }
                    height = Math.max(height, 1.2)
                }
            }
            bee.at.set(flat.x, flat.y, bee.at.z + (height - bee.at.z) * Math.min(1, step * 4))
            this.places.setXYZW(index, bee.at.x, bee.at.y, bee.at.z, bee.heading)
        }
        this.places.needsUpdate = true
        this.mesh.visible = night < 0.99
    }

    private flowerNear(from: THREE.Vector2) {
        let best = this.flowers[0]!, bestScore = Infinity
        for (let i = 0; i < 24; i++) {
            const candidate = this.flowers[Math.floor(this.random() * this.flowers.length)]!
            const d = candidate.distanceTo(from)
            const score = Math.abs(d - (0.6 + this.random() * 1.8))
            if (score < bestScore && d > 0.2) { best = candidate; bestScore = score }
        }
        return best.clone()
    }

    /** The bees' shadows on the grass, farther from them the higher they fly. */
    private shadows(shared: Shared) {
        const geometry = new THREE.InstancedBufferGeometry()
        const quad = new THREE.PlaneGeometry(1, 1)
        geometry.index = quad.index
        geometry.setAttribute("position", quad.attributes.position!)
        geometry.setAttribute("bee", this.places)
        geometry.instanceCount = this.count
        const material = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: { ...shared },
            vertexShader: /* glsl */`
                attribute vec4 bee; uniform float night; varying vec2 vLocal;
                void main() {
                    vLocal = position.xy * 2.0;
                    vec2 fall = vec2(0.25, -0.32) * bee.z;
                    gl_Position = projectionMatrix * viewMatrix * vec4(bee.xy + fall + vLocal * 0.1 * (1.0 + bee.z * 0.6) * (1.0 - night), 0.02, 1.0);
                }`,
            fragmentShader: /* glsl */`
                varying vec2 vLocal;
                void main() {
                    float d = length(vLocal * vec2(1.0, 1.6));
                    float a = smoothstep(1.0, 0.2, d) * 0.28;
                    if (a < 0.01) discard;
                    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
                }`
        })
        const mesh = new THREE.Mesh(geometry, material)
        mesh.frustumCulled = false
        mesh.renderOrder = -1
        return mesh
    }
}

/** By night, fireflies rise from the grass, in warm gold and green. */
function fireflies(shared: Shared) {
    const random = seeded(63)
    const count = 240
    const spots = new Float32Array(count * 2), seeds = new Float32Array(count)
    for (let i = 0; i < count; i++) { spots.set([(random() - 0.5) * 20, (random() - 0.5) * 14], i * 2); seeds[i] = random() }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    geometry.setAttribute("spot", new THREE.BufferAttribute(spots, 2))
    geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 1))
    const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { ...shared },
        vertexShader: /* glsl */`
            attribute vec2 spot; attribute float seed; uniform float time; varying float vSeed; varying float vPulse;
            void main() {
                vSeed = seed;
                vec2 drift = vec2(sin(time * 0.2 + seed * 40.0) * 0.9 + time * 0.03, cos(time * 0.16 + seed * 23.0) * 0.7);
                vec2 around = cameraPosition.xy;
                vec2 p = around + mod(spot + drift - around + vec2(10.0, 7.0), vec2(20.0, 14.0)) - vec2(10.0, 7.0);
                vPulse = pow(max(0.0, sin(time * (0.35 + seed * 0.5) + seed * 50.0)), 2.0);
                gl_PointSize = (3.0 + seed * 3.0) * (1.0 + vPulse);
                gl_Position = projectionMatrix * viewMatrix * vec4(p, 0.6 + seed * 0.8, 1.0);
            }`,
        fragmentShader: /* glsl */`
            uniform float night; varying float vSeed; varying float vPulse;
            void main() {
                float d = length(gl_PointCoord - 0.5);
                vec3 hue = vSeed < 0.6 ? vec3(0.8, 1.0, 0.4) : vec3(1.0, 0.8, 0.35);
                vec3 fly = hue * (smoothstep(0.5, 0.0, d) * 0.9 + smoothstep(0.14, 0.0, d) * 1.8) * vPulse * night;
                gl_FragColor = vec4(fly, 1.0);
            }`
    })
    const points = new THREE.Points(geometry, material)
    points.frustumCulled = false
    return points
}

/** Sunlight from the upper left by day, a soft darkening of the edges by night. */
function gradeShader() {
    return {
        uniforms: { tDiffuse: { value: null }, night: { value: 0 } },
        vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */`
            uniform sampler2D tDiffuse; uniform float night; varying vec2 vUv;
            void main() {
                vec3 color = texture2D(tDiffuse, vUv).rgb;
                float sun = 1.0 - distance(vUv, vec2(0.12, 0.95)) * 0.4;
                float edge = clamp(1.0 - pow(distance(vUv, vec2(0.5)) * 1.3, 2.2), 0.0, 1.0);
                vec3 day = color * mix(0.9, 1.1, sun) * mix(0.85, 1.0, edge);
                vec3 dark = color * mix(0.5, 1.0, edge);
                gl_FragColor = vec4(mix(day, dark, night), 1.0);
            }`
    }
}
