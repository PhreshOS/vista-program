import Meadow from "../meadow/meadow"

/** A spring meadow seen from the sky, with wildflowers and bees; the pointer parts the grass. */
export default function make(canvas: HTMLCanvasElement) {
    return new Meadow(canvas)
}
