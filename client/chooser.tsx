import { ContextProvider, DesktopProvider, SystemProvider, useDesktopPreferences, useProgram, useProgramStore, useSystemAppearance } from "@phreshos/react"
import { context, desktop, system } from "@phreshos/client"
import { Button, DocumentTheme, Flex, GridList, Heading, Loading, ScrollArea, Text, UIProvider, useAppearance, useRequirement, useScale } from "@phreshos/react-ui"
import { StrictMode, useEffect, useState } from "react"
import client from "react-dom/client"
import { sceneKey, wallpaperLaunch } from "./launch"
import { firstScene, scenes, type SceneId } from "./scenes"
import "./chooser.css"

// A small picture of each scene; only this window loads them.
const previews: Record<SceneId, string> = {
    garden: new URL("./previews/garden.jpg", import.meta.url).href,
    lavender: new URL("./previews/lavender.jpg", import.meta.url).href,
    seedbeds: new URL("./previews/seedbeds.jpg", import.meta.url).href,
    meadow: new URL("./previews/meadow.jpg", import.meta.url).href
}

/** The window to choose the scene: every scene Vista holds, and the one on the wallpaper. */
export default function start() {
    client.createRoot(document.getElementById("vista")!).render(<StrictMode>
        <SystemProvider system={system}>
            <DesktopProvider desktop={desktop}>
                <ContextProvider context={context}>
                    <Themed />
                </ContextProvider>
            </DesktopProvider>
        </SystemProvider>
    </StrictMode>)
}

function Themed() {
    return <UIProvider appearance={useSystemAppearance()} preferences={useDesktopPreferences()}>
        <DocumentTheme />
        <Loading><Chooser /></Loading>
    </UIProvider>
}

function Chooser() {
    const program = useProgram()
    const space = useScale(useAppearance().spacing)
    const [chosen, setChosen] = useProgramStore(sceneKey, firstScene as string)
    // Whether Vista is the wallpaper now: another wallpaper, when started, ends its Process.
    const [showing, setShowing] = useState<boolean>()

    useEffect(() => {
        void program.findProcess(wallpaperLaunch.name).then(process => setShowing(process !== null))
    }, [program])

    useRequirement(chosen !== undefined && showing !== undefined)

    /** Shows a scene on the wallpaper, now and every time the System starts. */
    async function choose(id: string) {
        await setChosen(id)
        await program.findOrCreateProcess(wallpaperLaunch)
        await program.startup.set(wallpaperLaunch)
        setShowing(true)
    }

    /** Takes Vista off the wallpaper, now and at the next start; the Desktop's own wallpaper returns. */
    async function stop() {
        await program.startup.remove()
        await (await program.findProcess(wallpaperLaunch.name))?.exit()
        setShowing(false)
    }

    return <Flex direction="column" gap="medium" style={{ height: "100%", padding: space.medium }}>
        <Flex align="center" gap="small">
            <Heading level={2} size="small" style={{ flex: "1 1 auto", minWidth: 0 }}>{showing ? "On the wallpaper" : "Choose a scene for the wallpaper"}</Heading>
            {showing && <Button size="small" onPress={() => void stop()}>Use the default wallpaper</Button>}
        </Flex>
        <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            <GridList aria-label="Scenes" selectionMode="single" itemWidth={260}
                value={showing && chosen ? chosen : null}
                onChange={id => { if (id !== null) void choose(id) }}>
                {scenes.map(scene => <GridList.Item key={scene.id} id={scene.id} textValue={scene.name}>
                    <Flex direction="column" gap="small">
                        <img src={previews[scene.id]} alt="" style={{ width: "100%", aspectRatio: "16 / 10", objectFit: "cover", borderRadius: "calc(var(--phreshos-ui-radius, 8px) * 0.75)" }} />
                        <Heading level={3} size="small">{scene.name}</Heading>
                        <Text size="small">{scene.description}</Text>
                    </Flex>
                </GridList.Item>)}
            </GridList>
        </ScrollArea>
    </Flex>
}
