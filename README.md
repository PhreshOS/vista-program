# Vista

Living scenes behind the windows, built by hand in 3D for PhreshOS.

## What it holds

- **Garden:** tall grass and daisies under an old tree, in the morning light.
- **Lavender:** rows of lavender running to the hills, with a lane of cypresses.
- **Seedbeds:** garden beds seen from above. A click in a bed plants a seed that
  grows into a plant in flower over a few minutes; what is planted is kept in the
  Program store, so the garden fills over the days. Plants lean away from the
  pointer, and at night it carries a small light.
- **Meadow:** a spring meadow from the sky, seen from high up, so it moves
  slowly under the windows. Grass the wind combs in waves, wildflowers in
  drifts, cloud shadows, and bees going from flower to flower. The pointer parts
  the grass, and the bees keep clear of it; by night fireflies rise.

Every scene follows the Desktop: the camera walks across it with the view, on
the same motion, and turns to night with the dark theme.

## How it runs

Vista is one Client that runs in two ways, by its `view` option:

- **The wallpaper:** a Process named `wallpaper` in the `wallpaper` layer,
  drawing the chosen scene. Vista records it as its startup launch, so it comes
  back every time the System starts.
- **The window:** opened from the Start menu, it shows every scene; choosing
  one puts it on the wallpaper at once.

The chosen scene is kept in the Program store under `scene`, so every Process
follows it.

Each mode and each scene is its own piece: the window never loads the 3D
engine, the wallpaper never loads React, and only the chosen scene is loaded.

## Add a scene

A scene is a module in `client/scenes/` whose default export makes a `Scene`
(`client/scene.ts`) on a canvas. Scenes with a horizon describe a `Landscape` for
the shared engine in `client/world.ts`: its morning and night colours, its lawn,
its camera, its hills, and what it plants. Scenes seen from above, like
Seedbeds, bring their own engine. List it in `client/scenes/index.ts` with a
picture in `client/previews/`.

## Development

```sh
bun install
bun run check
bun run build
bun run test
```
