import type { Program } from "@phreshos/core"
import Seedbeds from "../seedbeds/seedbeds"

/** Garden beds seen from above, where a click plants a seed that grows; what is planted is kept in the Program. */
export default function make(canvas: HTMLCanvasElement, program: Program) {
    return Seedbeds.make(canvas, program)
}
