import { context } from "@phreshos/client"

// Vista runs in two ways, by its `view` option: as the wallpaper, drawing the chosen scene, and as
// a window to choose it. Each loads only what it needs: the window never loads the 3D engine, and
// the wallpaper never loads React.
if (await context.options("view") === "wallpaper") await (await import("./wallpaper")).default()
else await (await import("./chooser")).default()
