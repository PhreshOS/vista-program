import type { SceneMaker } from "../scene"

/**
 * Every scene Vista holds. Each is loaded only when it is shown: the wallpaper imports the one
 * chosen, and the others are never downloaded.
 */
export const scenes = [
    { id: "garden", name: "Garden", description: "Tall grass and daisies under an old tree, in the morning light.", load: () => import("./garden") },
    { id: "lavender", name: "Lavender", description: "Rows of lavender running to the hills, with a lane of cypresses.", load: () => import("./lavender") },
    { id: "seedbeds", name: "Seedbeds", description: "Garden beds seen from above: click to plant a seed, and watch it grow.", load: () => import("./seedbeds") },
    { id: "meadow", name: "Meadow", description: "A spring meadow from the sky, with wildflowers and bees; the grass parts under the pointer.", load: () => import("./meadow") }
] as const satisfies readonly Readonly<{ id: string, name: string, description: string, load: () => Promise<{ default: SceneMaker }> }>[]

export type SceneId = (typeof scenes)[number]["id"]

/** The scene shown until the person chooses one. */
export const firstScene: SceneId = "garden"

/** The scene with an id, or the first one when that id is no longer held. */
export function sceneOf(id: unknown) {
    return scenes.find(scene => scene.id === id) ?? scenes.find(scene => scene.id === firstScene)!
}
