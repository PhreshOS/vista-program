import type { Launch } from "@phreshos/core"

/** The wallpaper: one Process by this name, in the `wallpaper` layer, drawing the chosen scene. */
export const wallpaperLaunch = { name: "wallpaper", server: false, client: { layer: "wallpaper", title: "Vista" }, options: { view: "wallpaper" } } as const satisfies Launch & { name: string }

/** Where the chosen scene is kept, for every Process of Vista to follow. */
export const sceneKey = "scene"
