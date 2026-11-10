# Publishing the plugin to Figma Community

Everything here is done once, except [Updating it](#updating-it). Publishing has to be done in the Figma desktop app by the account that will own the plugin.

## 1. Before you start

- **Two-factor authentication** must be on for your Figma account (Figma › Settings › Account › Security).
- **A plugin ID from Figma.** `manifest.json` has a made-up ID (`mockup3d-studio-local`), which is fine for testing but not for publishing. To get a real one: in the desktop app choose **Plugins › Development › New plugin…**, make a Figma design plugin with any name, and save it anywhere. Open the `manifest.json` it creates, copy its `"id"` (a long number) into `figma-plugin/manifest.json`, and delete the folder Figma made. If Figma has already linked the imported plugin to that ID, re-import `figma-plugin/manifest.json`.

## 2. Release the app version the plugin uses

A published plugin can't reach your computer's `serve.py` (Figma only allows `localhost` while developing), so it loads the app's renderer, models and lighting from GitHub, at the release tag named by `RELEASE` in `ui.html` (now `plugin-1.0.0`). A tag never changes, so later pushes to the web app can't change or break the published plugin.

Create and push the tag from the commit you want the plugin to use:

```bash
git tag plugin-1.0.0
```

```bash
git push origin plugin-1.0.0
```

Then check the files are there:

```bash
curl -sI https://cdn.jsdelivr.net/gh/thebigskyz/mockup3d-studio@plugin-1.0.0/env/studio-panels-2k.exr | head -1
```

It should say `200`.

## 3. Try it as users will get it

Stop `python3 serve.py`, then run the plugin in Figma. Its panel should show your frame on the device, and the button under **Insert mockup** should read **Web app on GitHub ↗**: it's using the release, as the published plugin will. Insert a mockup, edit it and update it once.

## 4. Publish

In the desktop app, open any design file, then **Figma menu › Plugins › Manage plugins**, click **⋯** next to Mockup3D Studio, and choose **Publish**. Fill in:

**Name**

> Mockup3D Studio

**Tagline**

> 3D iPhone and iPad mockups of your frames, updated when your design changes

**Description**

> Turn any frame into a 3D device mockup without leaving Figma.
>
> Select the frame of a screen design and Mockup3D Studio shows it on an iPhone or iPad in 3D. Pick an angle (or drag the device to turn it), a finish and a soft shadow, then insert: the mockup lands next to your frame as a transparent, high-resolution image.
>
> Mockups stay linked to their frames. Change your design, click Update, and every mockup whose frame changed is rendered again, in place.
>
> • iPhone 18 Pro and iPad Pro 11″, portrait or landscape to match your frame
> • 9 angle presets, or drag to set your own
> • Black, Silver and Grey finishes
> • Soft shadow, 1×, 2× or 3× resolution, transparent background
> • Select a mockup later to change its device, angle or finish
>
> Rendering happens on your computer, inside the plugin: your designs are never uploaded.
>
> For animations, several devices in one scene, and MP4 or PNG-sequence export, use the free Mockup3D Studio web app: https://github.com/thebigskyz/mockup3d-studio
>
> iPhone and iPad are trademarks of Apple Inc. Mockup3D Studio isn't affiliated with or endorsed by Apple.

**Category:** Design tools

**Icon:** `figma-plugin/assets/icon-128.png`

**Thumbnail:** `figma-plugin/assets/thumbnail-1920x1080.png`

**Carousel (optional):** screenshots of the panel and of mockups on the canvas, up to nine.

**Data security (optional form):** the plugin collects no data and has no server. Selected frames are exported and rendered inside the plugin on the user's computer; the only network requests download the renderer (three.js and the app's code, models and lighting) from cdn.jsdelivr.net. Settings are kept with Figma's clientStorage, on the user's computer.

**Support contact:** https://github.com/thebigskyz/mockup3d-studio/issues (or an email address you're happy to publish).

**Network access:** the listing should show **Restricted** (only cdn.jsdelivr.net, from `manifest.json`).

Click **Publish**. Figma reviews new plugins before listing them and emails you the result; there's no fixed time. If it's rejected, fix what the email says and publish again.

## Updating it

- **Plugin-only changes** (`code.js`, `ui.html`, `manifest.json`): test them, then **Manage plugins › ⋯ › Publish** again and describe what changed.
- **When the plugin needs newer app code** (`js/`, `models/`, `env/`): tag a new release (`plugin-1.0.1` …), push the tag, change `RELEASE` in `ui.html` to it, test with `serve.py` stopped, then publish the update.
- Pushing to the web app alone never changes the published plugin.

## What's already been done for publishing

- The renderer comes from a fixed release (`RELEASE` in `ui.html`), not the latest code.
- The plugin loads a 2K copy of the lighting (`env/studio-panels-2k.exr`, 3 MB rather than 12 MB), made by `blender/downscale_hdri.py`.
- The device's back logo is always off in plugin mockups (it's Apple's trademark).
- With Shadow on, the camera pulls back for the render so the shadow isn't cut off at the edges.
- Icon and thumbnail are in `figma-plugin/assets/`. The thumbnail was made with the plugin itself.
