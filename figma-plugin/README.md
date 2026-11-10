# Mockup3D Studio for Figma

Put a Figma frame on a 3D iPhone or iPad, right in Figma. The plugin renders the mockup with Mockup3D Studio's own renderer and places it next to the frame as a transparent image. Each mockup stays linked to its frame: change the design, click **Update**, and the mockup is rendered again.

You add it to the Figma desktop app from this folder (a development plugin). To put it on Figma Community, see [PUBLISHING.md](PUBLISHING.md).

## Set it up

1. Start Mockup3D Studio in the repo's folder (see [Run it](../README.md#run-it)):

   ```bash
   python3 serve.py
   ```

   The plugin uses your copy of the app while this runs. When it can't reach it, it uses a release of the app on GitHub instead, so the plugin still works (the button under Insert mockup then reads **Web app on GitHub** instead of **Open web app**).
2. In the **Figma desktop app**, open a design file, then choose **Plugins › Development › Import plugin from manifest…** and pick `figma-plugin/manifest.json` in this repo. You only do this once.
3. Run it from **Plugins › Development › Mockup3D Studio › Mockup a frame**.

Development plugins only run in the desktop app, not in Figma in a browser.

## Use it

- **Select the frame of a screen design** (or a component, instance or group). The panel shows it on the device. With nothing selected, or a layer inside a screen, the preview says what to select.
- Choose the **device** (iPhone 18 Pro or iPad Pro 11″), an **angle** (or drag the preview to turn it), the **finish**, a soft **shadow** and the **resolution**. Landscape frames go on a landscape device.
- **Insert mockup** renders it and places it to the right of the frame, sized so its screen is about the frame's size. 2× resolution (the default) means two image pixels per Figma point.
- **Select a mockup** to edit it: the panel shows its settings. **Update mockup** replaces it; **Insert as new** adds another one. A selected mockup also has **Edit mockup** and **Update mockup** buttons in Figma's right-hand panel.
- **Update all mockups on this page** (in the panel, or **Plugins › … › Update mockups on this page**) renders again every mockup whose frame changed and skips the rest.

**Open web app ↗** (under Insert mockup) opens Mockup3D Studio in your browser: the copy the plugin is using, or its GitHub page when the plugin is using the app from GitHub. Use the web app for what the plugin doesn't do, such as several devices, animation and video.

The plugin remembers your last settings for the next mockup. Your designs never leave Figma and your computer.

## Limits

- Images: one device per mockup, stills only. For several devices, templates, animation and MP4 or PNG-sequence export, use the web app.
- Figma images can be at most 4096 px on a side, so 3× on a large frame is capped there.
- Mockups don't update by themselves: Figma only runs a plugin while it's open, so click Update after changing a frame.
- A frame whose shape differs from the device's screen is cropped to fill it, as in the app.

## How it works

| File | Runs in | Does |
|---|---|---|
| `manifest.json` | Figma | Names the plugin, its menu commands and the buttons on mockups, and the sites the panel may load from |
| `code.js` | Figma's plugin sandbox | Watches the selection, exports the frame as a PNG, and places or replaces the mockup image. Each mockup stores its frame's id, its settings and a fingerprint of the frame (plugin data), so Update can tell what changed |
| `ui.html` | The plugin's panel (a web page) | Loads `js/scene.js`, `js/devices.js` and the rest of the renderer from the app, shows the preview and renders the PNG |
| `dev.html` | A browser | A test bench for working on the plugin without Figma (below) |

Rendering happens in the panel because Figma's side of a plugin has no WebGL. Without the local app (always, once published), the panel loads the app from GitHub through jsDelivr at the release tag in `RELEASE` (`ui.html`), so pushing to the web app can't change the published plugin. It loads a 2K copy of the lighting (`env/studio-panels-2k.exr`, made by `blender/downscale_hdri.py`) and always hides the device's back logo. The two halves talk with messages: the selection's PNG goes to the panel, the rendered mockup comes back.

The app serves its `js/`, `models/` and `env/` folders to the plugin (CORS headers in `serve.py`), and the models and HDRI load relative to `js/` so they're found from the plugin's page too. Commits that only change this folder don't trigger the app's "Update on GitHub" notice.

## Working on the plugin without Figma

With `python3 serve.py` running, open <http://localhost:5173/figma-plugin/dev.html>. It runs `code.js` against a small stand-in for Figma's plugin API and shows the panel beside a pretend canvas with two frames. Click frames to select them, insert and edit mockups, use **Change the selected frame's design** and then **Update all** to check updating. Add `?command=update-all` to the address to start as the menu command does.

The test bench gives the panel an origin of its own. In Figma it has none, and some browsers then block it from reaching `localhost` (it falls back to GitHub); add `?null-origin` to try that.

Edits to `code.js`, `ui.html` or `manifest.json` take effect the next time you run the plugin in Figma (close it and run it again). After editing the manifest, Figma picks it up on the next run too.
