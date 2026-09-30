import { defineConfig } from "@phreshos/core"

export default defineConfig({
    identity: "vista",
    name: "Vista",
    description: "Living scenes behind the windows, built by hand in 3D: a garden, a lavender field, and more to come.",
    website: "https://github.com/PhreshOS/vista-program",
    version: "0.1.0",
    // Drawn from icon.svg: an apricot garden arch, and through it a low sun over green hills and a cypress.
    icon: "icon.png",
    categories: ["Wallpaper"],
    keywords: ["wallpaper", "scenes", "living", "3d"],
    // The wallpaper is a Process of Vista started in the `wallpaper` layer; the window chooses its scene.
    permissions: { layers: ["wallpaper"] },
    buildCommand: "vite-node scripts/build.ts",
    // Vista is drawn only in the browser: it has no Server.
    client: {
        location: "dist/client",
        title: "Vista",
        size: { width: 860, height: 560 },
        devCommand: "vite --config vite.client.ts"
    }
})
