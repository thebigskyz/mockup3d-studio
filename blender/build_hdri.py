"""
Renders the bundled HDRI, seen from where the device stands, as a 360°
equirectangular image:

    studio-panels    a dark photo studio with three big softbox panels in
                     front of the device and two white flats at the sides:
                     high contrast, crisp highlights, no windows

Run headless from the project root:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P blender/build_hdri.py

Output:
    env/<name>.exr    4096 x 2048, half float, linear (no tone mapping)

Optional arguments after "--": which one (or "all"), width, samples, e.g.
`-- studio-panels 1024 32` for a quick low-quality test.

Orientation: the app's default camera looks at the device from the front.
The middle of the image (u = 0.5) is to the device's right, u = 0.75 is in
front of it (behind the camera, what the screen reflects) and u = 0.25 is
the background behind it.
"""

import bpy
import math
import os
import sys
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if args and not args[0].isdigit():
    WHICH = args.pop(0)
else:
    WHICH = "all"
WIDTH = int(args[0]) if len(args) > 0 else 4096
SAMPLES = int(args[1]) if len(args) > 1 else 256


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def material(name, color, roughness=0.8, emission=None, strength=0.0, metallic=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = roughness
    b.inputs["Metallic"].default_value = metallic
    if emission:
        b.inputs["Emission Color"].default_value = (*emission, 1)
        b.inputs["Emission Strength"].default_value = strength
    return m


def box(name, size, loc, mat, rot_z=0.0):
    """Box: size (x, y, z) in metres, centred at loc, turned rot_z (radians)."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object
    o.name = name
    o.scale = size
    o.rotation_euler.z = rot_z
    bpy.ops.object.transform_apply(scale=True)
    o.data.materials.append(mat)
    return o


def cylinder(name, radius, depth, loc, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc, rotation=rot, vertices=16)
    o = bpy.context.object
    o.name = name
    o.data.materials.append(mat)
    return o


def shell(w, d, h, wall, floor, ceiling, th=0.2):
    """Floor, ceiling and four walls (boxes, so light can't leak in)."""
    box("Floor", (w + 2 * th, d + 2 * th, th), (0, 0, -th / 2), floor)
    box("Ceiling", (w + 2 * th, d + 2 * th, th), (0, 0, h + th / 2), ceiling)
    box("WallFront", (w, th, h), (0, d / 2 + th / 2, h / 2), wall)
    box("WallBack", (w, th, h), (0, -d / 2 - th / 2, h / 2), wall)
    box("WallLeft", (th, d, h), (-w / 2 - th / 2, 0, h / 2), wall)
    box("WallRight", (th, d, h), (w / 2 + th / 2, 0, h / 2), wall)


# ---------------------------------------------------------------------------
# Studio panels
# ---------------------------------------------------------------------------
def build_studio_panels():
    SW, SD, SH = 16.0, 16.0, 5.5
    eye = 1.2
    shell(SW, SD, SH,
          material("Wall", (0.045, 0.045, 0.047), roughness=0.85),
          material("Concrete", (0.11, 0.11, 0.115), roughness=0.42),
          material("Ceiling", (0.035, 0.035, 0.037), roughness=0.9))

    # Three tall softboxes in a shallow arc in front of the device (+y),
    # each facing it, on dark stands.
    panel = material("Softbox", (0, 0, 0), roughness=1.0, emission=(1.0, 1.0, 1.0), strength=10.0)
    rim = material("SoftboxEdge", (0.02, 0.02, 0.02), roughness=0.5)
    metal = material("Stand", (0.02, 0.02, 0.022), roughness=0.35, metallic=1.0)
    dist = 3.0
    for i, (az, w, h) in enumerate(((-44, 1.4, 2.4), (0, 1.7, 2.8), (44, 1.4, 2.4))):
        a = math.radians(az)
        cx, cy = dist * math.sin(a), dist * math.cos(a)
        zc = eye + 0.3
        box(f"Softbox{i}", (w, 0.03, h), (cx, cy, zc), panel, rot_z=-a)
        # A thin dark rim behind the lit face.
        box(f"SoftboxBack{i}", (w + 0.06, 0.12, h + 0.06), (cx + 0.08 * math.sin(a), cy + 0.08 * math.cos(a), zc), rim, rot_z=-a)
        # Stand: a pole and three legs.
        bottom = zc - h / 2
        cylinder(f"Pole{i}", 0.016, bottom, (cx, cy + 0.15, bottom / 2), metal)
        for k in range(3):
            # Legs from 0.55 m up the pole out to 0.35 m on the floor.
            la = math.radians(90 + k * 120)
            spread, top = 0.35, 0.55
            length = math.hypot(spread, top)
            tilt = math.atan2(spread, top)
            mid = Vector((cx + math.cos(la) * spread / 2, cy + 0.15 + math.sin(la) * spread / 2, top / 2))
            leg = cylinder(f"Leg{i}{k}", 0.012, length, (0, 0, 0), metal)
            leg.matrix_world = (Matrix.Translation(mid) @ Matrix.Rotation(la, 4, "Z")
                                @ Matrix.Rotation(-tilt, 4, "Y"))

    # Two big white flats at the sides, lit (slightly self-lit so they read
    # as bright boards, as in a real studio).
    flat = material("WhiteFlat", (0.85, 0.85, 0.85), roughness=0.9, emission=(1.0, 1.0, 1.0), strength=1.6)
    for side in (-1, 1):
        box(f"Flat{side}", (0.05, 6.5, 3.8), (side * 5.0, -0.5, 1.9), flat)

    # Two strip lights on the ceiling.
    strip = material("Strip", (0, 0, 0), roughness=1.0, emission=(1.0, 0.98, 0.95), strength=6.0)
    for side in (-1, 1):
        box(f"Strip{side}", (2.8, 0.12, 0.04), (side * 2.6, 1.5, SH - 0.3), strip)

    # Turn so the softboxes are in front of the device (u = 0.75), offset so
    # that at the default angle the edge of the middle panel crosses the
    # screen: half bright reflection, half dark, rather than all white.
    return eye, 190


SCENES = {
    "studio-panels": build_studio_panels,
}


# ---------------------------------------------------------------------------
# Render
# ---------------------------------------------------------------------------
def render(name, build):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    eye, yaw = build()

    # Camera: 360° equirectangular, level, where the device stands.
    cam_data = bpy.data.cameras.new("Pano")
    cam_data.type = "PANO"
    cam_data.panorama_type = "EQUIRECTANGULAR"
    cam = bpy.data.objects.new("Pano", cam_data)
    scene.collection.objects.link(cam)
    cam.location = (0, 0, eye)
    cam.rotation_euler = (math.radians(90), 0, math.radians(-90 + yaw))
    scene.camera = cam

    scene.world = bpy.data.worlds.new("Black")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.0

    scene.render.engine = "CYCLES"
    cy = scene.cycles
    cy.samples = SAMPLES
    cy.use_denoising = True
    cy.max_bounces = 8
    cy.diffuse_bounces = 6
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        cy.device = "GPU"
    except Exception as e:  # no GPU: render on the CPU
        print("GPU unavailable:", e)

    scene.view_settings.view_transform = "Standard"  # linear values, no tone mapping
    scene.view_settings.look = "None"
    scene.render.resolution_x = WIDTH
    scene.render.resolution_y = WIDTH // 2
    scene.render.resolution_percentage = 100
    st = scene.render.image_settings
    st.file_format = "OPEN_EXR"
    st.color_depth = "16"
    st.exr_codec = "ZIP"
    st.color_mode = "RGB"
    out = os.path.join(ROOT, "env", f"{name}.exr")
    scene.render.filepath = out
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.render.render(write_still=True)
    print(f"rendered {out} ({os.path.getsize(out) / 1e6:.1f} MB)")


for name, build in SCENES.items():
    if WHICH in ("all", name):
        render(name, build)
