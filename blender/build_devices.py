"""
Builds the device models for the mockup app, from scratch, and exports them as .glb.

Run headless from the project root:
    /Applications/Blender.app/Contents/MacOS/Blender -b -P blender/build_devices.py

Outputs:
    models/<device>.glb      one file per device, loaded by the web app
    blender/devices.blend    every device in one file, for editing by hand

Conventions shared with the web app (js/devices.js):
    - Real-world size in metres, origin at the device centre.
    - Front of the device faces -Y in Blender, which is +Z in glTF / three.js.
    - The screen is a separate mesh named "Screen" with UVs 0..1 across the
      whole display (u = left->right, v = bottom->top, seen from the front).
    - Recolourable materials are named "Frame", "BackPanel" and "FrameAccent";
      the front glass material is "Glass". Blender may append ".001" etc. to
      keep names unique, so the app ignores a trailing ".NNN".
    - The root node carries extras: device, label, screenW, screenH (metres),
      screenPxW, screenPxH.
"""

import bpy
import bmesh
import math
import os
import tempfile
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
MODELS_DIR = os.path.join(ROOT, "models")
MM = 0.001

# ---------------------------------------------------------------------------
# Device specs (from Apple's published tech specs)
# ---------------------------------------------------------------------------
IPHONES = [
    dict(device="iphone-18-pro", label="iPhone 18 Pro",
         w=71.9, h=150.0, d=8.75, px=(1206, 2622), pt_w=402),
]
IPHONE_SCREEN_CORNER_PT = 62  # display corner radius in points

IPADS = [
    dict(device="ipad-pro-11", label="iPad Pro 11\"",
         w=177.5, h=249.7, d=5.3, px=(1668, 2420), pt_w=834),
]
IPAD_SCREEN_CORNER_PT = 18

# Dynamic Island in points (width, height, gap from the top of the display).
DYNAMIC_ISLAND_PT = (125, 37, 11)

# The logo on the back, as an SVG path in a 24 x 24 box.
LOGO_SVG_PATH = (
    "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 "
    "1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 "
    "1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857"
    "-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09z"
    "M15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 "
    "3.714 1.338.104 2.715-.688 3.559-1.701"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def new_material(name, color, metallic=0.0, roughness=0.5, alpha=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Alpha"].default_value = alpha
    if alpha < 1.0:
        mat.surface_render_method = "BLENDED"
    return mat


def rounded_rect_points(w, h, r, seg=24):
    """Counter-clockwise outline of a rounded rectangle centred at 0, as (x, z)."""
    r = min(r, w / 2, h / 2)
    corners = [(w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90),
               (-w / 2 + r, -h / 2 + r, 180), (w / 2 - r, -h / 2 + r, 270)]
    pts = []
    for cx, cz, a0 in corners:
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    return pts


def make_flat_rounded_rect(name, w, h, r, y, material, seg=32):
    """Flat rounded rectangle in the XZ plane at depth y, facing -Y, UVs 0..1."""
    pts = rounded_rect_points(w, h, r, seg)
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    centre = bm.verts.new((0, y, 0))
    ring = [bm.verts.new((x, y, z)) for x, z in pts]
    for i in range(len(ring)):
        a, b = ring[i], ring[(i + 1) % len(ring)]
        face = bm.faces.new((centre, a, b))  # CCW in XZ -> normal -Y
        for loop in face.loops:
            co = loop.vert.co
            loop[uv].uv = ((co.x + w / 2) / w, (co.z + h / 2) / h)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(material)
    obj = bpy.data.objects.new(name, me)
    return obj


def make_rounded_slab(name, w, h, d, corner_r, edge_r, seg=24, edge_seg=5):
    """Solid rounded-rect slab: w along X, h along Z, d along Y, centred at 0."""
    pts = rounded_rect_points(w, h, corner_r, seg)
    bm = bmesh.new()
    front = [bm.verts.new((x, -d / 2, z)) for x, z in pts]
    back = [bm.verts.new((x, d / 2, z)) for x, z in pts]
    f_front = bm.faces.new(front)
    f_back = bm.faces.new(list(reversed(back)))
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], back[i], back[j], front[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    if edge_r > 0:
        rim = [e for e in bm.edges if (f_front in e.link_faces) or (f_back in e.link_faces)]
        bmesh.ops.bevel(bm, geom=rim, offset=edge_r, segments=edge_seg,
                        profile=0.5, affect="EDGES", clamp_overlap=True)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    return obj


def make_lozenge(name, length, width, height, out_axis, len_axis, bevel, seg=16):
    """Pill-shaped (stadium) hardware button.

    Seen from the side of the device it's a rounded slot: `length` along
    `len_axis`, `width` across the device's depth (Y) with fully round ends.
    It sticks out `height` along `out_axis` (centred at 0, so half of it sits
    inside the body), and both rims are softened by `bevel`.
    Axes: 0 = X, 1 = Y, 2 = Z.
    """
    pts = rounded_rect_points(width, length, width / 2, seg)  # (across, along)
    # Fully round ends make neighbouring arcs meet: drop the repeated points.
    clean = []
    for p in pts:
        if not clean or (abs(p[0] - clean[-1][0]) + abs(p[1] - clean[-1][1])) > 1e-9:
            clean.append(p)
    if (abs(clean[0][0] - clean[-1][0]) + abs(clean[0][1] - clean[-1][1])) <= 1e-9:
        clean.pop()

    def co(across, along, out):
        v = [0.0, 0.0, 0.0]
        v[1] = across
        v[len_axis] = along
        v[out_axis] = out
        return v

    bm = bmesh.new()
    lo = [bm.verts.new(co(a, l, -height / 2)) for a, l in clean]
    hi = [bm.verts.new(co(a, l, height / 2)) for a, l in clean]
    cap_lo = bm.faces.new(lo)
    cap_hi = bm.faces.new(list(reversed(hi)))
    n = len(clean)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], hi[i], hi[j], lo[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    rims = [e for e in bm.edges if cap_lo in e.link_faces or cap_hi in e.link_faces]
    bmesh.ops.bevel(bm, geom=rims, offset=bevel, segments=4, profile=0.5,
                    affect="EDGES", clamp_overlap=True)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return bpy.data.objects.new(name, me)


def largest_island(me):
    """Vertex indices of the mesh's largest connected piece."""
    links = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        links[a].append(b)
        links[b].append(a)
    seen, best = set(), []
    for start in range(len(me.vertices)):
        if start in seen:
            continue
        seen.add(start)
        island, stack = [], [start]
        while stack:
            v = stack.pop()
            island.append(v)
            for n in links[v]:
                if n not in seen:
                    seen.add(n)
                    stack.append(n)
        if len(island) > len(best):
            best = island
    return best


def make_logo(name, height, material):
    """The logo as a flat mesh on the back of a device: centred at 0, `height`
    tall (along Z), facing +Y and reading correctly when seen from the back."""
    with tempfile.TemporaryDirectory() as tmp:
        svg = os.path.join(tmp, "logo.svg")
        with open(svg, "w") as f:
            f.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="{LOGO_SVG_PATH}"/></svg>')
        before = set(bpy.data.objects)
        bpy.ops.import_curve.svg(filepath=svg)
    curve = next(o for o in bpy.data.objects if o not in before)
    curve.data.resolution_u = 24
    # Curve -> mesh without touching the selection or the active object.
    depsgraph = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(curve.evaluated_get(depsgraph))
    me.name = name
    me.transform(curve.matrix_world)
    # Remove the imported curve and the collection / material the importer made.
    svg_cols = list(curve.users_collection)
    old_mats = list(curve.data.materials)
    curve_data = curve.data
    bpy.data.objects.remove(curve)
    bpy.data.curves.remove(curve_data)
    for c in svg_cols:
        if not c.objects and c.name.startswith("logo"):
            bpy.data.collections.remove(c)
    for m in old_mats:
        if m and m.users == 0:
            bpy.data.materials.remove(m)
    # Centre on the main body (the largest connected piece, so the leaf
    # doesn't pull it down), scale the whole logo to size, then lay it on
    # the back: SVG x/y -> -X / Z.
    ys = [v.co.y for v in me.vertices]
    body = largest_island(me)
    bx = [me.vertices[i].co.x for i in body]
    by = [me.vertices[i].co.y for i in body]
    centre = Vector(((min(bx) + max(bx)) / 2, (min(by) + max(by)) / 2, 0))
    k = height / (max(ys) - min(ys))
    me.transform(Matrix.Rotation(math.pi, 4, "Z") @ Matrix.Rotation(math.pi / 2, 4, "X")
                 @ Matrix.Diagonal((k, k, k, 1)) @ Matrix.Translation(-centre))
    me.materials.clear()
    me.materials.append(material)
    return bpy.data.objects.new(name, me)


def make_cylinder_y(name, radius, depth, seg=48):
    """Cylinder whose axis runs along Y, centred at 0."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                          radius1=radius, radius2=radius, depth=depth)
    bmesh.ops.rotate(bm, verts=bm.verts[:], cent=(0, 0, 0),
                     matrix=Matrix.Rotation(math.radians(90), 3, "X"))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return bpy.data.objects.new(name, me)


def smooth_by_angle(obj, degrees=35):
    me = obj.data
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(degrees))


def link(obj, collection, parent=None):
    collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent


def make_root(spec, collection, screen_w, screen_h):
    root = bpy.data.objects.new(spec["device"], None)
    root.empty_display_size = 0.05
    collection.objects.link(root)
    root["device"] = spec["device"]
    root["label"] = spec["label"]
    root["screenW"] = screen_w
    root["screenH"] = screen_h
    root["screenPxW"] = spec["px"][0]
    root["screenPxH"] = spec["px"][1]
    return root


def screen_material():
    # Placeholder only: the app replaces it with the dropped image/video.
    return new_material("Screen", (0.02, 0.02, 0.025), roughness=0.3)


# ---------------------------------------------------------------------------
# iPhone: built from scratch
# ---------------------------------------------------------------------------
def make_phone_body(name, w, h, d, corner_r, front_r, back_r, seg=32):
    """Rounded-rect slab like make_rounded_slab, but with a small rounding on
    the front rim (flat glass almost to the edge) and a larger, softer one on
    the back rim (the aluminium unibody curving into the back)."""
    pts = rounded_rect_points(w, h, corner_r, seg)
    bm = bmesh.new()
    front = [bm.verts.new((x, -d / 2, z)) for x, z in pts]
    back = [bm.verts.new((x, d / 2, z)) for x, z in pts]
    f_front = bm.faces.new(front)
    f_back = bm.faces.new(list(reversed(back)))
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], back[i], back[j], front[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    back_rim = [e for e in bm.edges if f_back in e.link_faces]
    bmesh.ops.bevel(bm, geom=back_rim, offset=back_r, segments=10,
                    profile=0.5, affect="EDGES", clamp_overlap=True)
    f_front = max((f for f in bm.faces if f.normal.y < -0.99), key=lambda f: f.calc_area())
    front_rim = [e for e in f_front.edges]
    bmesh.ops.bevel(bm, geom=front_rim, offset=front_r, segments=4,
                    profile=0.5, affect="EDGES", clamp_overlap=True)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return bpy.data.objects.new(name, me)


def make_disc_down(name, w, d, r, z, material, seg=16):
    """Flat rounded rect facing -Z (on the bottom edge), w along X, d along Y."""
    obj = make_flat_rounded_rect(name, w, d, r, 0, material, seg)
    obj.rotation_euler.x = math.radians(90)  # -Y facing -> -Z facing
    obj.location.z = z
    return obj


def build_iphone(spec, collection):
    W, H, D = spec["w"] * MM, spec["h"] * MM, spec["d"] * MM
    front_r, back_r = 0.7 * MM, 2.6 * MM  # rim roundings (front: thin metal lip)
    aspect = spec["px"][1] / spec["px"][0]
    pw, ph = W - 2 * front_r, H - 2 * front_r  # flat front: black glass panel
    # Uniform black border b so the display matches the real pixel aspect ratio.
    b = (aspect * pw - ph) / (2 * (aspect - 1))
    sw, sh = pw - 2 * b, (pw - 2 * b) * aspect
    screen_r = IPHONE_SCREEN_CORNER_PT / spec["pt_w"] * sw
    body_r = screen_r + b + front_r

    frame = new_material("Frame", (0.17, 0.17, 0.18), metallic=1.0, roughness=0.32)
    back = new_material("BackPanel", (0.2, 0.2, 0.21), metallic=0.6, roughness=0.5)
    accent = new_material("FrameAccent", (0.09, 0.09, 0.1), metallic=1.0, roughness=0.25)
    panel = new_material("DisplayBlack", (0.004, 0.004, 0.004), metallic=0.4, roughness=0.05)
    glass = new_material("Glass", (1, 1, 1), roughness=0.05, alpha=0.08)
    lens = new_material("Lens", (0.005, 0.006, 0.012), metallic=1.0, roughness=0.06)
    lens_core = new_material("LensCore", (0.02, 0.03, 0.09), metallic=1.0, roughness=0.04)
    flash = new_material("Flash", (0.85, 0.82, 0.7), roughness=0.4)
    black = new_material("CameraBlack", (0.01, 0.01, 0.012), metallic=0.3, roughness=0.35)
    back_glass = new_material("BackGlass", (0.24, 0.24, 0.25), metallic=0.2, roughness=0.55)
    logo_mat = new_material("Logo", (0.2, 0.2, 0.21), metallic=1.0, roughness=0.18)

    root = make_root(spec, collection, sw, sh)

    # Body: black glass front, aluminium sides, back panel.
    body = make_phone_body(spec["device"] + "-body", W, H, D, body_r, front_r, back_r)
    me = body.data
    for m in (frame, back, panel):
        me.materials.append(m)
    for p in me.polygons:
        if p.normal.y < -0.98:
            p.material_index = 2
        elif p.normal.y > 0.98:
            p.material_index = 1
        else:
            p.material_index = 0
    smooth_by_angle(body, 35)
    link(body, collection, root)

    front_y = -D / 2
    g = make_flat_rounded_rect("FrontGlass", pw, ph, body_r - front_r, front_y - 0.00006, glass)
    link(g, collection, root)
    screen = make_flat_rounded_rect("Screen", sw, sh, screen_r, front_y - 0.00003, screen_material())
    link(screen, collection, root)

    # Dynamic Island, just in front of the screen.
    pt = sw / spec["pt_w"]
    iw, ih, gap = (v * pt for v in DYNAMIC_ISLAND_PT)
    island = make_flat_rounded_rect("DynamicIsland", iw, ih, ih / 2, front_y - 0.00004,
                                    new_material("IslandBlack", (0.0, 0.0, 0.0), roughness=0.2))
    island.location.z = sh / 2 - gap - ih / 2
    link(island, collection, root)

    # Camera bar across the top of the back, in the frame's aluminium.
    # Seen from the back, +X is on the left.
    margin = 3.0 * MM
    ring_r, ring_d = 8.1 * MM, 1.3 * MM
    pad = 4.4 * MM  # space between the lenses and the bar's edge
    step = 2 * ring_r + 1.1 * MM  # lens centre spacing
    bar_w, bar_h, bar_d = W - 2 * margin, 2 * (ring_r + pad) + step, 1.5 * MM
    bar_top = H / 2 - margin
    bar_cz = bar_top - bar_h / 2
    bar = make_rounded_slab("CameraBar", bar_w, bar_h, bar_d, body_r - margin, 0.6 * MM,
                            seg=24, edge_seg=4)
    bar.location = (0, D / 2 + bar_d / 2 - 0.2 * MM, bar_cz)
    bar.data.materials.append(frame)
    smooth_by_angle(bar, 35)
    link(bar, collection, root)
    bar_back = D / 2 + bar_d - 0.2 * MM

    # Three lenses in a triangle on the left (seen from the back).
    lx = W / 2 - margin - pad - ring_r
    top_z = bar_top - pad - ring_r
    lenses = [(lx, top_z), (lx, top_z - step), (lx - step * 0.87, top_z - step / 2)]
    for i, (x, z) in enumerate(lenses):
        ring = make_cylinder_y(f"LensRing{i}", ring_r, ring_d, seg=64)
        ring.location = (x, bar_back + ring_d / 2 - 0.1 * MM, z)
        ring.data.materials.append(accent)
        smooth_by_angle(ring, 30)
        link(ring, collection, root)
        top = bar_back + ring_d - 0.1 * MM
        cover = make_cylinder_y(f"Lens{i}", ring_r - 1.1 * MM, 0.1 * MM, seg=64)
        cover.location = (x, top + 0.02 * MM, z)
        cover.data.materials.append(lens)
        smooth_by_angle(cover, 30)
        link(cover, collection, root)
        core = make_cylinder_y(f"LensCore{i}", 2.6 * MM, 0.1 * MM, seg=48)
        core.location = (x, top + 0.04 * MM, z)
        core.data.materials.append(lens_core)
        link(core, collection, root)

    # Flash, sensor and microphone on the right of the bar.
    rx = -(W / 2 - margin - pad - 4.0 * MM)
    for name, r, z, mat in (("Flash", 2.6 * MM, top_z, flash),
                            ("Sensor", 2.6 * MM, top_z - step, black),
                            ("Mic", 0.5 * MM, top_z - step / 2, black)):
        o = make_cylinder_y(name, r, 0.1 * MM, seg=40)
        o.location = (rx, bar_back + 0.03 * MM, z)
        o.data.materials.append(mat)
        link(o, collection, root)

    # Buttons on the flat band of the sides. Seen from the front, -X is left.
    side_y = (-D / 2 + front_r + D / 2 - back_r) / 2
    band = D - front_r - back_r

    def button(name, x_sign, length, z, mat=frame, proud=0.45 * MM):
        btn = make_lozenge(name, length, band * 0.62, proud * 2, out_axis=0, len_axis=2,
                           bevel=proud * 0.7)
        btn.location = (x_sign * W / 2, side_y, z)
        btn.data.materials.append(mat)
        smooth_by_angle(btn, 35)
        link(btn, collection, root)

    top = H / 2
    button("ActionButton", -1, 7.5 * MM, top - 31 * MM)
    button("VolumeUp", -1, 11 * MM, top - 46 * MM)
    button("VolumeDown", -1, 11 * MM, top - 61 * MM)
    button("SideButton", 1, 17 * MM, top - 50 * MM)
    button("CameraControl", 1, 16 * MM, top - 50 * MM - spec["h"] * 0.25 * MM,
           mat=accent, proud=0.15 * MM)

    # MagSafe panel: a glass window in the back below the camera bar, with
    # the logo's body in the middle of it.
    panel_top = bar_cz - bar_h / 2 - margin
    panel_bottom = -H / 2 + margin
    panel_h = panel_top - panel_bottom
    panel_d = 0.08 * MM
    panel = make_rounded_slab("MagSafePanel", bar_w, panel_h, panel_d, body_r - margin, 0.04 * MM,
                              seg=24, edge_seg=3)
    panel.location = (0, D / 2 + panel_d / 2 - 0.02 * MM, (panel_top + panel_bottom) / 2)
    panel.data.materials.append(back_glass)
    smooth_by_angle(panel, 35)
    link(panel, collection, root)
    logo = make_logo("Logo", 18.0 * MM * W / (78.0 * MM), logo_mat)
    logo.location = (0, D / 2 + panel_d + 0.01 * MM, (panel_top + panel_bottom) / 2)
    link(logo, collection, root)

    # Bottom edge: USB-C port and speaker / microphone holes.
    bottom = -H / 2 - 0.02 * MM
    port = make_disc_down("Port", 8.9 * MM, 3.0 * MM, 1.5 * MM, bottom, black)
    port.location.y = side_y
    link(port, collection, root)
    for side in (-1, 1):
        for i in range(6):
            hole = make_disc_down(f"Speaker{side}_{i}", 1.1 * MM, 1.1 * MM, 0.55 * MM, bottom, black, seg=8)
            hole.location.x = side * (9.5 + i * 2.1) * MM
            hole.location.y = side_y
            link(hole, collection, root)

    print(f"[{spec['device']}] body {W/MM:.1f}x{H/MM:.1f}x{D/MM:.2f} mm, border {b/MM:.2f} mm, "
          f"screen {sw/MM:.2f}x{sh/MM:.2f} mm, r {screen_r/MM:.2f} mm, body r {body_r/MM:.2f} mm")
    return root


# ---------------------------------------------------------------------------
# iPad: built from scratch
# ---------------------------------------------------------------------------
def build_ipad(spec, collection):
    W, H, D = spec["w"] * MM, spec["h"] * MM, spec["d"] * MM
    aspect = spec["px"][1] / spec["px"][0]
    # Uniform bezel so the display matches the real pixel aspect ratio.
    b = (aspect * W - H) / (2 * (aspect - 1))
    sw, sh = W - 2 * b, (W - 2 * b) * aspect
    screen_r = IPAD_SCREEN_CORNER_PT / spec["pt_w"] * sw
    body_r = screen_r + b
    edge_r = min(1.2 * MM, D * 0.3)

    frame = new_material("Frame", (0.62, 0.63, 0.65), metallic=1.0, roughness=0.35)
    back = new_material("BackPanel", (0.62, 0.63, 0.65), metallic=1.0, roughness=0.45)
    accent = new_material("FrameAccent", (0.4, 0.4, 0.42), metallic=1.0, roughness=0.4)
    bezel = new_material("DisplayBlack", (0.004, 0.004, 0.004), metallic=0.4, roughness=0.05)
    glass = new_material("Glass", (1, 1, 1), roughness=0.05, alpha=0.08)
    lens = new_material("Lens", (0.0, 0.001, 0.02), metallic=1.0, roughness=0.08)
    flash = new_material("Flash", (0.85, 0.82, 0.7), roughness=0.4)
    black = new_material("CameraBlack", (0.01, 0.01, 0.012), metallic=0.5, roughness=0.3)
    logo_mat = new_material("Logo", (0.62, 0.63, 0.65), metallic=1.0, roughness=0.18)

    root = make_root(spec, collection, sw, sh)

    # Body: aluminium sides and back, black glass front.
    body = make_rounded_slab(spec["device"] + "-body", W, H, D, body_r, edge_r, seg=24, edge_seg=6)
    me = body.data
    for m in (frame, back, bezel):
        me.materials.append(m)
    for p in me.polygons:
        if p.normal.y < -0.95:
            p.material_index = 2
        elif p.normal.y > 0.95:
            p.material_index = 1
        else:
            p.material_index = 0
    smooth_by_angle(body, 35)
    link(body, collection, root)

    front_y = -D / 2
    # Glass covering the whole front flat area.
    g = make_flat_rounded_rect("FrontGlass", W - 2 * edge_r, H - 2 * edge_r, body_r - edge_r,
                               front_y - 0.00006, glass)
    link(g, collection, root)
    screen = make_flat_rounded_rect("Screen", sw, sh, screen_r, front_y - 0.00003, screen_material())
    link(screen, collection, root)

    # Front camera: in the right-hand bezel, which is the top edge in landscape.
    cam = make_cylinder_y("FrontCamera", 1.1 * MM, 0.02 * MM, seg=32)
    cam.location = (W / 2 - b / 2, front_y - 0.00004, 0)
    cam.data.materials.append(black)
    link(cam, collection, root)

    # Rear camera module, top-left seen from the back (+X, +Z).
    mod_w, mod_h = 14.5 * MM, 26 * MM
    mod = make_rounded_slab("CameraModule", mod_w, mod_h, 1.2 * MM, mod_w / 2 - 0.1 * MM,
                            0.35 * MM, seg=16, edge_seg=3)
    cx, cz = W / 2 - 12 * MM, H / 2 - 18 * MM
    mod.location = (cx, D / 2 + 0.4 * MM, cz)
    mod.data.materials.append(back)
    smooth_by_angle(mod, 35)
    link(mod, collection, root)
    back_y = D / 2 + 1.0 * MM
    for i, (dz, r) in enumerate(((6.0, 5.2), (-6.0, 5.2))):
        ring = make_cylinder_y(f"LensRing{i}", r * MM, 0.5 * MM)
        ring.location = (cx, back_y + 0.25 * MM, cz + dz * MM)
        ring.data.materials.append(accent)
        smooth_by_angle(ring, 30)
        link(ring, collection, root)
        glass_r = make_cylinder_y(f"Lens{i}", (r - 1.2) * MM, 0.52 * MM)
        glass_r.location = ring.location
        glass_r.data.materials.append(lens if i == 0 else black)
        smooth_by_angle(glass_r, 30)
        link(glass_r, collection, root)
    fl = make_cylinder_y("Flash", 1.6 * MM, 0.1 * MM)
    fl.location = (cx - 9.5 * MM, D / 2 + 0.05 * MM, cz + 6 * MM)
    fl.data.materials.append(flash)
    link(fl, collection, root)
    mic = make_cylinder_y("Mic", 0.5 * MM, 0.1 * MM)
    mic.location = (cx - 9.5 * MM, D / 2 + 0.05 * MM, cz - 1 * MM)
    mic.data.materials.append(black)
    link(mic, collection, root)

    # Buttons: top button (top edge, right), volume up/down (right side, top).
    def button(name, length, proud, out_axis, len_axis, loc):
        btn = make_lozenge(name, length, bd, proud * 2, out_axis=out_axis, len_axis=len_axis,
                           bevel=proud * 0.6)
        btn.location = loc
        btn.data.materials.append(frame)
        smooth_by_angle(btn, 35)
        link(btn, collection, root)
        return btn

    bd = D * 0.55
    button("TopButton", 22 * MM, 0.6 * MM, 2, 0, (W / 2 - 30 * MM, 0, H / 2))
    button("VolumeUp", 12 * MM, 0.6 * MM, 0, 2, (W / 2, 0, H / 2 - 30 * MM))
    button("VolumeDown", 12 * MM, 0.6 * MM, 0, 2, (W / 2, 0, H / 2 - 46 * MM))

    # Logo in the middle of the back.
    logo = make_logo("Logo", W * 0.15, logo_mat)
    logo.location = (0, D / 2 + 0.03 * MM, 0)
    link(logo, collection, root)

    print(f"[{spec['device']}] body {W/MM:.1f}x{H/MM:.1f}x{D/MM:.2f} mm, bezel {b/MM:.2f} mm, "
          f"screen {sw/MM:.2f}x{sh/MM:.2f} mm, r {screen_r/MM:.2f} mm")
    return root


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------
def select_tree(root):
    bpy.ops.object.select_all(action="DESELECT")
    stack = [root]
    while stack:
        o = stack.pop()
        o.select_set(True)
        stack.extend(o.children)
    bpy.context.view_layer.objects.active = root


def export_glb(root):
    select_tree(root)
    path = os.path.join(MODELS_DIR, root["device"] + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_extras=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
    )
    print(f"exported {path} ({os.path.getsize(path) / 1024:.0f} KB)")


def main():
    os.makedirs(MODELS_DIR, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "MILLIMETERS"

    roots = []
    for spec in IPHONES + IPADS:
        col = bpy.data.collections.new(spec["label"])
        scene.collection.children.link(col)
        builder = build_iphone if spec in IPHONES else build_ipad
        root = builder(spec, col)
        roots.append(root)

    for root in roots:
        export_glb(root)

    # Lay devices out side by side in the .blend for editing.
    x = 0.0
    for root in roots:
        root.location.x = x
        x += 0.3
    bpy.context.preferences.filepaths.save_version = 0  # no devices.blend1 backups
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(HERE, "devices.blend"))


main()
