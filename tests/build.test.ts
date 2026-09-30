import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import config from "../phresh.config"
import manifest from "../package.json" with { type: "json" }
import { test } from "vitest"

test("Vista is one Client with no Server, opened as a window and started as the wallpaper", async () => {
  assert.equal(config.identity, "vista")
  assert.equal(config.version, manifest.version)
  assert.equal(config.server, undefined)
  assert.equal(config.client?.layer, undefined)
  assert.deepEqual(config.permissions?.layers, ["wallpaper"])
  assert.equal(config.client?.location, "dist/client")

  assert(readFileSync("dist/client/index.html", "utf8").length > 0)
  // Each scene is its own piece, loaded only when it is shown.
  const pieces = readdirSync("dist/client/assets")
  assert(pieces.some(piece => piece.startsWith("garden-")))
  assert(pieces.some(piece => piece.startsWith("lavender-")))
  assert(pieces.some(piece => piece.startsWith("seedbeds-")))
  assert(pieces.some(piece => piece.startsWith("meadow-")))
}, 120_000)
