import { context, desktop } from "@phreshos/client"
import type { Transaction, DesktopOffset, DesktopSize } from "@phreshos/core"
import { sceneKey } from "./launch"
import { sceneOf } from "./scenes"
import type { Place } from "./scene"

// A quiet pace for a background: a scene needs no more than thirty frames a second at rest.
const frame = 1000 / 30

/** Draws the chosen scene behind the windows, and follows the view across the plane. */
export default async function start() {

    const program = await context.program()
    const chosen = sceneOf(await program.store.get(sceneKey))
    const make = (await chosen.load()).default

    // Another scene chosen takes this one's place, drawn fresh, with nothing of this one left in memory.
    program.store.subscribe(sceneKey, next => { if (sceneOf(next).id !== chosen.id) location.reload() })

    const canvas = document.createElement("canvas")
    document.getElementById("vista")!.append(canvas)
    const world = await make(canvas, program)

    let view: DesktopSize = await desktop.viewport.size()
    let offset: DesktopOffset = await desktop.viewport.offset()
    let plane: DesktopSize = await desktop.plane.size()
    let animations = (await desktop.preferences.snapshot()).animations

    /** The scene takes the same motion the Desktop gives the view, so it and the windows arrive together. */
    function look(transaction: Transaction | null) {
        const place: Place = { offset, view, plane }
        world.look(place, transaction)
        still()
    }

    /** With animations off, the scene is a still picture: it draws once, where it now is. */
    function still() {
        if (animations) return
        world.settle()
        requestAnimationFrame(time => world.draw(time))
    }

    desktop.viewport.subscribe("resize", size => { view = size; look(null) })
    desktop.viewport.subscribe("move", move => { offset = move.offset; look(move.transaction) })
    desktop.plane.subscribe("resize", size => { plane = size; look(null) })
    desktop.preferences.subscribe("change", preferences => {
        world.nightfall(preferences.theme === "dark")
        animations = preferences.animations
        if (animations) play()
        else still()
    })

    const preferences = await desktop.preferences.snapshot()
    world.nightfall(preferences.theme === "dark")
    // It opens where the view already is, with no walk to get there.
    look(null)
    world.settle()

    let playing = false
    let previous = 0

    function play() {
        if (playing) return
        playing = true
        requestAnimationFrame(tick)
    }

    function tick(time: number) {
        // It rests while nobody can see it, or when the person turned animations off.
        if (!animations || document.hidden) {
            playing = false
            if (!animations) still()
            return
        }
        // While the camera walks it draws every frame, so it moves as smoothly as the windows.
        if (time - previous >= frame || world.walking()) {
            previous = time
            world.draw(time)
        }
        requestAnimationFrame(tick)
    }

    document.addEventListener("visibilitychange", () => { if (!document.hidden) play() })
    window.addEventListener("resize", () => { if (!animations) still() })

    if (animations) play()
    else still()
}
