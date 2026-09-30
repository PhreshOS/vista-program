import type { DesktopOffset, DesktopSize, Program, Transaction } from "@phreshos/core"

/** Where the view is: its offset from the plane's center, its size, and the plane's, in pixels. */
export type Place = Readonly<{ offset: DesktopOffset, view: DesktopSize, plane: DesktopSize }>

/**
 * A scene drawn behind the windows. It follows the view across the plane on the motion the
 * Desktop gives it, turns to night with the dark theme, and draws a frame when asked.
 */
export interface Scene {
    /** Goes to where the view went, on its motion, or at once when there is none. */
    look(place: Place, timing: Transaction | null): void
    /** Turns to night, or back to day, over a few seconds. */
    nightfall(night: boolean): void
    /** Whether it is on its way somewhere and needs every frame drawn. */
    walking(): boolean
    /** Arrives where it is going at once, for a still frame. */
    settle(): void
    draw(time: number): void
}

/** Makes a scene on a canvas; a scene that keeps something, such as what was planted, keeps it in the Program. */
export type SceneMaker = (canvas: HTMLCanvasElement, program: Program) => Scene | Promise<Scene>
