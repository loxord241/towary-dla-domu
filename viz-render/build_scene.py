#!/usr/bin/env python3
"""Deterministic interior scene builder for the wallpaper visualizer spike.

Builds a photo-real room in Blender (4.2 LTS, Cycles) entirely from script:
  * clean feature wall, exactly wall_w x wall_h metres (floor-to-ceiling),
    covered by the wallpaper texture tiled so ONE ROLL = roll_w metres wide
    (vertical strip seams every 0.53 m);
  * wood floor + ceiling + two shadowed return walls (room is exactly as
    wide as the feature wall, so the wallpaper covers the whole front wall);
  * PolyHaven CC0 furniture in front of the wall (real occlusion of the
    wallpaper bottom edge), scaled below max height;
  * big soft area lights + weak world light: even, no hot spots;
  * camera at eye level with a slight side perspective (<= 10 deg yaw).

Rooms (furniture + light mood) are defined in SCENES and assembled by
build_scene(room_id, cfg): vitalnia (sofa, studio light), bedroom (low
bed + nightstand, softer warm evening light), kids (school desk + chair,
neutral-warm light).

Run:
  blender -b --factory-startup -P viz-render/build_scene.py -- \
      --room vitalnia --texture /path/wallpaper.jpg \
      --out viz-render/previews/quick-1.png \
      --width 960 --height 540 --samples 32

Render device: CUDA by default (OptiX silently falls back to CPU in this
WSL2 environment), falls back to CPU.
"""
import argparse
import math
import os
import sys
import time

import bpy
from mathutils import Vector

CONFIG = {
    "texture_path": "",   # путь к текстуре обоев (jpg/webp/png)
    "wall_w": 4.0, "wall_h": 2.7, "roll_w": 0.53,  # метры
    "res": (1920, 1080), "samples": 128, "out": "render.png",
}

# Room assets live OUTSIDE the repo (spike: no binaries in git).
ASSETS = {
    "sofa_gltf": "/tmp/assets/sofa/Sofa_01_2k.gltf",
    "console_gltf": "/tmp/assets/console/ClassicConsole_01_2k.gltf",
    "bed_gltf": "/tmp/assets/bedframe/old_bed_frame_2k.gltf",
    "nightstand_gltf": "/tmp/assets/nightstand/ClassicNightstand_01_2k.gltf",
    "desk_gltf": "/tmp/assets/schooldesk/SchoolDesk_01_2k.gltf",
    "chair_gltf": "/tmp/assets/schoolchair/SchoolChair_01_2k.gltf",
    "mirror_gltf": "/tmp/assets/mirror/ornate_mirror_01_2k.gltf",
    "floor_diff": "/tmp/assets/floor/wooden_floor_02_diff_2k.jpg",
    "floor_nor": "/tmp/assets/floor/wooden_floor_02_nor_gl_2k.jpg",
    "floor_rough": "/tmp/assets/floor/wooden_floor_02_rough_2k.jpg",
}

KIND_ASSET = {
    "sofa": "sofa_gltf",
    "console": "console_gltf",
    "bed": "bed_gltf",
    "nightstand": "nightstand_gltf",
    "desk": "desk_gltf",
    "chair": "chair_gltf",
    "mirror": "mirror_gltf",
    "none": None,
}

ROOM = {
    "depth": 7.5,           # how far the room extends behind the camera
    "return_wall_col": (0.70, 0.66, 0.61),  # warm off-white, darker than wallpaper
    "ceiling_col": (0.82, 0.80, 0.77),
    "floor_repeat_m": 2.2,  # floor texture covers 2.2 x 2.2 m per tile
}

CAMERA = {
    "height": 1.5,          # eye level, m
    "dist": 4.8,            # distance from the wall, m
    "lens": 34,             # mm -> wall ~79% of frame width
    "yaw_deg": 4.0,         # slight side perspective
    "aim_z": 1.30,          # camera looks a touch below eye level
}

LIGHTS = {
    "key_power": 240,       # W, big soft box above/front
    "fill_power": 55,       # W, frontal fill from camera side
    "side_power": 30,       # W, gentle lateral gradient
    "world_strength": 0.25,
    "world_col": (1.0, 0.97, 0.92),
}

FURNITURE = {
    "kind": "sofa",         # sofa | console | none
    "max_h": 0.75,          # m, must stay below 0.8
    "x": 0.0,               # lateral center offset
    "gap": 0.06,            # gap between furniture back and the wall
    "rot_z_deg": 0.0,       # fix model orientation after visual check
}

# ------------------------------------------------------------ scene factory
# Per-room furniture + light mood. The vitalnia entry reproduces the
# approved scene 1 exactly (same values as the module defaults above).
# Furniture pieces: kind (KIND_ASSET), max_h (uniform cap), x (lateral
# center), gap (back-to-wall distance), rot_z_deg, z (floor level, for
# wall-mounted pieces).
SCENES = {
    "vitalnia": {
        "furniture": [
            {"kind": "sofa", "max_h": 0.75, "x": 0.0, "gap": 0.06, "rot_z_deg": 0.0},
        ],
        "lights": {},
        "camera": {},
        "exposure": 0.0,
    },
    "bedroom": {
        # console table + ornate mirror above it (dresser vignette) left,
        # classic nightstand right; both low, wallpaper clean above ~0.9 m.
        "furniture": [
            {"kind": "console", "max_h": 0.88, "x": -0.70, "gap": 0.06, "rot_z_deg": 0.0},
            {"kind": "mirror", "scale": 1.15, "x": -0.70, "gap": 0.02, "rot_z_deg": 0.0, "z": 1.05},
            {"kind": "nightstand", "max_h": 0.62, "x": 1.35, "gap": 0.06, "rot_z_deg": 0.0},
        ],
        "lights": {
            "key_power": 170, "fill_power": 42, "side_power": 22,
            "world_strength": 0.19, "world_col": (1.0, 0.95, 0.89),
        },
        "camera": {},
        "exposure": 0.0,
    },
    "kids": {
        # child-scale writing desk + school chair near the wall; the group
        # sits slightly left of center so the wallpaper stays the hero.
        "furniture": [
            {"kind": "desk", "max_h": 0.75, "x": -0.35, "gap": 0.06, "rot_z_deg": 0.0},
            {"kind": "chair", "max_h": 0.90, "x": 0.25, "gap": 0.42, "rot_z_deg": -14.0},
        ],
        "lights": {
            "key_power": 215, "fill_power": 50, "side_power": 28,
            "world_strength": 0.22, "world_col": (1.0, 0.96, 0.91),
        },
        "camera": {},
        "exposure": 0.0,
    },
}

SEED = 7


# ---------------------------------------------------------------- helpers

def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def track_to(loc, target):
    d = Vector(target) - Vector(loc)
    return d.to_track_quat("-Z", "Y").to_euler()


def make_plane(name, size_x, size_y, loc, rot=(0, 0, 0)):
    """XY plane (single face) with UV 0..1."""
    mesh = bpy.data.meshes.new(name)
    hx, hy = size_x / 2.0, size_y / 2.0
    verts = [(-hx, -hy, 0), (hx, -hy, 0), (hx, hy, 0), (-hx, hy, 0)]
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    uv = mesh.uv_layers.new(name="UVMap")
    for i, c in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[i].uv = c
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    obj.rotation_euler = [math.radians(a) for a in rot]
    bpy.context.collection.objects.link(obj)
    return obj


def flat_material(name, col, rough=0.9):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*col, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    return mat


def image_mat(name, img_path, non_color=()):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    img = bpy.data.images.load(img_path)
    # Smart-интерполяция: при сильном минифицировании (мелкий узор на 4-м
    # стене) Linear+денойз дают кашу, Smart сохраняет читаемость узора.
    img.colorspace_settings.name = "sRGB"
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Smart"
    tex.extension = "REPEAT"
    return mat, nt, bsdf, tex, img


# ---------------------------------------------------------------- scene

def vertical_quad(name, corners, uvs=None):
    """Mesh quad from 4 world-space corners (CCW), with 0..1 UVs."""
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(c) for c in corners], [], [(0, 1, 2, 3)])
    uv = mesh.uv_layers.new(name="UVMap")
    for i, c in enumerate(uvs or [(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[i].uv = c
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def build_room(cfg):
    wall_w, wall_h = cfg["wall_w"], cfg["wall_h"]
    depth = ROOM["depth"]

    floor = make_plane("Floor", wall_w + 0.02, depth + 1.0, (0, -depth / 2.0 + 0.5, 0))
    floor.data.materials.append(floor_material())

    ceil = make_plane("Ceiling", wall_w + 0.02, depth + 1.0, (0, -depth / 2.0 + 0.5, wall_h))
    ceil.rotation_euler = (math.pi, 0, 0)
    ceil.data.materials.append(flat_material("CeilingMat", ROOM["ceiling_col"], 0.95))

    for i, x in enumerate((-wall_w / 2.0, wall_w / 2.0)):
        w = vertical_quad(f"ReturnWall{i}", [
            (x, -depth, 0), (x, 0, 0), (x, 0, wall_h), (x, -depth, wall_h)])
        w.data.materials.append(flat_material("ReturnMat", ROOM["return_wall_col"], 0.95))

    back = vertical_quad("BackWall", [
        (-wall_w / 2, -depth, 0), (wall_w / 2, -depth, 0),
        (wall_w / 2, -depth, wall_h), (-wall_w / 2, -depth, wall_h)])
    back.data.materials.append(flat_material("BackMat", ROOM["return_wall_col"], 0.95))


def build_wall(cfg):
    """Feature wall: exactly wall_w x wall_h, one face toward -Y, UV 0..1."""
    w, h = cfg["wall_w"], cfg["wall_h"]
    mesh = bpy.data.meshes.new("FeatureWall")
    verts = [(-w / 2, 0, 0), (w / 2, 0, 0), (w / 2, 0, h), (-w / 2, 0, h)]
    mesh.from_pydata(verts, [], [(0, 1, 2, 3)])
    uv = mesh.uv_layers.new(name="UVMap")
    for i, c in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[i].uv = c
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new("FeatureWall", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(wallpaper_material(cfg))
    return obj


def wallpaper_material(cfg):
    w, h, roll = cfg["wall_w"], cfg["wall_h"], cfg["roll_w"]
    mat, nt, bsdf, tex, img = image_mat("Wallpaper", cfg["texture_path"])

    # force pixel load so img.size is available in background mode
    if img.size[0] == 0:
        _ = img.pixels[0]
    iw, ih = img.size
    tile_h = roll * ih / iw          # physical height of one tile
    sx, sy = w / roll, h / tile_h    # one image tile == one roll strip
    print(f"[wallpaper] image {iw}x{ih}px -> tile {roll:.3f} x {tile_h:.3f} m, "
          f"uv scale ({sx:.3f}, {sy:.3f})")

    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (sx, sy, 1.0)
    nt.links.new(coord.outputs["UV"], mapping.inputs["Vector"])
    nt.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])

    # mild contrast boost: photos of paper wash out under even studio light
    curve = nt.nodes.new("ShaderNodeRGBCurve")
    cv = curve.mapping.curves[3]
    cv.points.new(0.45, 0.40)
    cv.points.new(0.85, 0.87)
    curve.mapping.update()
    nt.links.new(tex.outputs["Color"], curve.inputs["Color"])

    # subtle paper relief so the wall never reads as a CG plane
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 140.0
    noise.inputs["Detail"].default_value = 6.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.15
    bump.inputs["Distance"].default_value = 0.0006
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    # honest roll seams: thin shading line where one 0.53 m strip ends
    sep_x = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(mapping.outputs["Vector"], sep_x.inputs["Vector"])
    fract = nt.nodes.new("ShaderNodeMath")
    fract.operation = "FRACT"
    nt.links.new(sep_x.outputs["X"], fract.inputs[0])
    d = nt.nodes.new("ShaderNodeMath")          # distance to tile edge, 0..0.5
    d.operation = "SUBTRACT"
    d.inputs[0].default_value = 0.5
    abs_d = nt.nodes.new("ShaderNodeMath")
    abs_d.operation = "ABSOLUTE"
    nt.links.new(fract.outputs["Value"], d.inputs[1])
    nt.links.new(d.outputs["Value"], abs_d.inputs[0])
    # half-width 1.5 mm -> 0.00283 tile units; smooth line via smoothstep
    seam_w = 0.0015 / roll
    ss = nt.nodes.new("ShaderNodeMapRange")
    ss.inputs["From Min"].default_value = seam_w
    ss.inputs["From Max"].default_value = seam_w * 3.0
    ss.inputs["To Min"].default_value = 1.0     # inside seam -> darken
    ss.inputs["To Max"].default_value = 0.0
    nt.links.new(abs_d.outputs["Value"], ss.inputs["Value"])
    shade = nt.nodes.new("ShaderNodeMix")
    shade.data_type = "RGBA"
    shade.blend_type = "MULTIPLY"
    shade.inputs[6].default_value = (1, 1, 1, 1)             # A(color): texture
    shade.inputs[7].default_value = (0.94, 0.94, 0.94, 1.0)  # B(color): seam shade
    nt.links.new(ss.outputs["Result"], shade.inputs["Factor"])
    nt.links.new(curve.outputs["Color"], shade.inputs[6])
    nt.links.new(shade.outputs[2], bsdf.inputs["Base Color"])

    bsdf.inputs["Roughness"].default_value = 0.6
    bsdf.inputs["Sheen Weight"].default_value = 0.08
    bsdf.inputs["Specular IOR Level"].default_value = 0.15
    return mat


def floor_material():
    mat = bpy.data.materials.new("FloorWood")
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]

    coord = nt.nodes.new("ShaderNodeTexCoord")
    mapping = nt.nodes.new("ShaderNodeMapping")
    rep = 1.0 / ROOM["floor_repeat_m"]
    mapping.inputs["Scale"].default_value = (rep, rep, 1.0)
    nt.links.new(coord.outputs["UV"], mapping.inputs["Vector"])

    diff = nt.nodes.new("ShaderNodeTexImage")
    diff.image = bpy.data.images.load(ASSETS["floor_diff"])
    diff.extension = "REPEAT"
    nt.links.new(mapping.outputs["Vector"], diff.inputs["Vector"])
    nt.links.new(diff.outputs["Color"], bsdf.inputs["Base Color"])

    rough = nt.nodes.new("ShaderNodeTexImage")
    rough.image = bpy.data.images.load(ASSETS["floor_rough"])
    rough.image.colorspace_settings.name = "Non-Color"
    rough.extension = "REPEAT"
    nt.links.new(mapping.outputs["Vector"], rough.inputs["Vector"])
    nt.links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])

    nor = nt.nodes.new("ShaderNodeTexImage")
    nor.image = bpy.data.images.load(ASSETS["floor_nor"])
    nor.image.colorspace_settings.name = "Non-Color"
    nor.extension = "REPEAT"
    nt.links.new(mapping.outputs["Vector"], nor.inputs["Vector"])
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nmap.inputs["Strength"].default_value = 0.5
    nt.links.new(nor.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    return mat


def add_light(name, kind, energy, loc, target, size, size_y=None, color=(1.0, 0.96, 0.9)):
    light = bpy.data.lights.new(name, kind)
    light.energy = energy
    light.color = color
    if kind == "AREA":
        light.shape = "RECTANGLE" if size_y else "SQUARE"
        light.size = size
        if size_y:
            light.size_y = size_y
    obj = bpy.data.objects.new(name, light)
    obj.location = loc
    obj.rotation_euler = track_to(loc, target)
    obj.visible_camera = False          # never show light planes in frame
    obj.visible_glossy = False
    bpy.context.collection.objects.link(obj)
    return obj


def add_lights(lights):
    wall_h = CONFIG["wall_h"]
    lp = dict(LIGHTS)
    lp.update(lights or {})
    # key: huge soft box just below ceiling, tilted toward the wall
    add_light("Key", "AREA", lp["key_power"], (0.0, -2.3, wall_h - 0.12),
              (0.0, 0.0, 1.1), size=3.6, size_y=2.0)
    # fill: frontal from camera side, keeps the wall even
    add_light("Fill", "AREA", lp["fill_power"], (0.0, -4.4, 1.7),
              (0.0, 0.0, 1.4), size=2.6, size_y=2.0)
    # gentle side gradient (right), low power
    add_light("Side", "AREA", lp["side_power"], (2.2, -3.0, 2.3),
              (0.3, 0.0, 1.3), size=1.6, size_y=1.2, color=(1.0, 0.98, 0.95))

    world = bpy.data.worlds.new("World")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (*lp["world_col"], 1.0)
    bg.inputs["Strength"].default_value = lp["world_strength"]
    bpy.context.scene.world = world


def add_camera(cam_over=None):
    cam = dict(CAMERA)
    cam.update(cam_over or {})
    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = cam["lens"]
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.clip_start = 0.05
    cam_obj = bpy.data.objects.new("Camera", cam_data)
    loc = (0.0, -cam["dist"], cam["height"])
    cam_obj.location = loc
    aim = (cam["dist"] * math.tan(math.radians(cam["yaw_deg"])), 0.0, cam["aim_z"])
    cam_obj.rotation_euler = track_to(loc, aim)
    bpy.context.collection.objects.link(cam_obj)
    bpy.context.scene.camera = cam_obj
    print(f"[camera] pos {loc} yaw {cam['yaw_deg']}deg lens {cam['lens']}mm")
    return cam_obj


# ---------------------------------------------------------------- furniture

def import_and_place(gltf_path, cfg):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=gltf_path)
    new = [o for o in bpy.data.objects if o not in before]

    root = bpy.data.objects.new("FurnitureRoot_" + cfg.get("kind", "piece"), None)
    bpy.context.collection.objects.link(root)
    tops = [o for o in new if o.parent is None or o.parent not in new]
    for o in tops:
        o.parent = root

    def bbox():
        dg = bpy.context.evaluated_depsgraph_get()
        mins = Vector((1e9,) * 3)
        maxs = Vector((-1e9,) * 3)
        for o in new:
            if o.type != "MESH":
                continue
            ev = o.evaluated_get(dg)
            for c in ev.bound_box:
                wc = ev.matrix_world @ Vector(c)
                mins = Vector(map(min, mins, wc))
                maxs = Vector(map(max, maxs, wc))
        return mins, maxs

    bpy.context.view_layer.update()
    mins, maxs = bbox()
    size = maxs - mins
    print(f"[furniture] raw size {size.x:.2f} x {size.y:.2f} x {size.z:.2f} m")

    s = cfg["scale"] if cfg.get("scale") else min(1.0, cfg["max_h"] / max(size.z, 1e-6))
    root.scale = (s, s, s)
    root.rotation_euler = (0, 0, math.radians(cfg["rot_z_deg"]))
    bpy.context.view_layer.update()
    mins, maxs = bbox()

    root.location = Vector((
        cfg["x"] - (mins.x + maxs.x) / 2.0,
        -cfg["gap"] - maxs.y,
        cfg.get("z", 0.0) - mins.z,
    ))
    bpy.context.view_layer.update()
    mins, maxs = bbox()
    print(f"[furniture] placed size {(maxs-mins).x:.2f} x {(maxs-mins).y:.2f} x "
          f"{(maxs-mins).z:.2f} m, back y={maxs.y:.3f}, top z={maxs.z:.3f}")
    return new


def bbox_of(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    mins = Vector((1e9,) * 3)
    maxs = Vector((-1e9,) * 3)
    for o in objs:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(dg)
        for c in ev.bound_box:
            wc = ev.matrix_world @ Vector(c)
            mins = Vector(map(min, mins, wc))
            maxs = Vector(map(max, maxs, wc))
    return mins, maxs


def fabric_mat(name, col):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*col, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.95
    bsdf.inputs["Sheen Weight"].default_value = 0.35
    bsdf.inputs["Specular IOR Level"].default_value = 0.08
    return mat


def soft_box(name, size, loc, mat, bevel=0.03, subsurf=3, wrinkle=0.0):
    """Rounded fabric-looking box (mattress / duvet / pillow)."""
    mesh = bpy.data.meshes.new(name)
    hx, hy, hz = size[0] / 2.0, size[1] / 2.0, size[2] / 2.0
    verts = [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz),
             (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]
    faces = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh.from_pydata(verts, [], faces)
    mesh.validate()
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = loc
    bpy.context.collection.objects.link(obj)
    bev = obj.modifiers.new("Bevel", "BEVEL")
    bev.width = bevel
    bev.segments = 4
    sub = obj.modifiers.new("Subsurf", "SUBSURF")
    sub.levels = sub.render_levels = subsurf
    if wrinkle > 0.0:
        tex = bpy.data.textures.new(name + "Tex", "CLOUDS")
        tex.noise_scale = 0.25
        disp = obj.modifiers.new("Wrinkle", "DISPLACE")
        disp.texture = tex
        disp.strength = wrinkle
        disp.mid_level = 0.5
    obj.data.materials.append(mat)
    return obj


def dress_bed(objs, rot_z_deg):
    """Add mattress + duvet + pillow to a bare bed frame (vintage metal bed).

    Assumes rot_z_deg of 0 (headboard against the wall) or 180 (footboard
    against the wall, headboard into the room).
    """
    mins, maxs = bbox_of(objs)
    W, D = maxs.x - mins.x, maxs.y - mins.y
    head_y, foot_y = (mins.y, maxs.y) if abs(rot_z_deg) > 90 else (maxs.y, mins.y)
    # sleep surface of the frame: rails sit at ~40% of the total height
    base_z = mins.z + (maxs.z - mins.z) * 0.40
    linen = fabric_mat("Linen", (0.93, 0.92, 0.90))
    duvet_col = fabric_mat("Duvet", (0.88, 0.87, 0.845))

    # mattress: slightly inset, thickness ~0.16 m
    mw, md, mt = W - 0.10, D - 0.16, 0.16
    my = (head_y + foot_y) / 2.0
    soft_box("Mattress", (mw, md, mt), (mins.x + W / 2.0, my, base_z + mt / 2.0),
             linen, bevel=0.05, subsurf=3, wrinkle=0.008)

    # duvet: covers the foot half, drapes over the side rails
    dw, dd, dt = W + 0.16, D * 0.55, 0.24
    dy = foot_y + (D - dd) / 2.0 - 0.10
    soft_box("Duvet", (dw, dd, dt), (mins.x + W / 2.0, dy, base_z + dt / 2.0 - 0.03),
             duvet_col, bevel=0.07, subsurf=4, wrinkle=0.02)

    # pillow(s) near the headboard, side by side within the frame width
    pw = min(0.38, (W - 0.40) / 2.0)
    px = mins.x + W / 2.0 - pw / 2.0 - 0.07
    for side in (-1, 1):
        soft_box("Pillow", (pw, 0.32, 0.10),
                 (px + (side > 0) * (pw + 0.14), head_y - 0.30, base_z + mt + 0.05),
                 linen, bevel=0.04, subsurf=3, wrinkle=0.012)
    print(f"[bed] dressed: frame {W:.2f}x{D:.2f}, base z {base_z:.2f}, "
          f"head at y={head_y:.2f}")


def add_furniture(pieces):
    for piece in pieces:
        path = ASSETS.get(KIND_ASSET.get(piece["kind"], ""), "")
        if path and os.path.exists(path):
            new = import_and_place(path, piece)
            if piece["kind"] == "bed" and piece.get("dress", True):
                dress_bed(new, piece.get("rot_z_deg", 0.0))
        else:
            print(f"[furniture] MISSING {path or piece['kind']}, skipping piece")


# ---------------------------------------------------------------- scene factory

def build_scene(room_id, cfg):
    """Assemble the full room: shell, wallpaper wall, lights, camera, furniture."""
    scene = SCENES[room_id]

    reset_scene()
    build_room(cfg)
    build_wall(cfg)
    add_lights(scene["lights"])
    add_camera(scene["camera"])

    pieces = scene["furniture"]
    if cfg.get("furniture_override") is not None:
        pieces = cfg["furniture_override"]
    add_furniture(pieces)


# ---------------------------------------------------------------- render

def setup_render(cfg):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"

    # Device selection with honest logging.
    # NB: in this WSL2 environment OptiX init fails SILENTLY (Cycles falls
    # back to CPU while the log still says GPU) -- verified via nvidia-smi:
    # no compute app appears and render time matches CPU. CUDA works.
    # Default is therefore CUDA; pass --device optix to try OptiX first.
    order = {"optix": ("OPTIX", "CUDA"), "cuda": ("CUDA", "OPTIX"),
             "cpu": ()}[cfg["device"]]
    device = "CPU"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for ctype in order:
            try:
                prefs.compute_device_type = ctype
                prefs.get_devices()
                # some builds report GPU devices as type 'CUDA' even under OPTIX
                gpus = [d for d in prefs.devices if d.type != "CPU"]
                if gpus:
                    for d in prefs.devices:
                        d.use = (d.type != "CPU")
                    device = ctype
                    break
            except Exception as e:
                print(f"[device] {ctype} unavailable: {e}")
    except Exception as e:
        print(f"[device] prefs unavailable: {e}")
    if device != "CPU":
        sc.cycles.device = "GPU"
    print(f"[device] enabled types: "
          f"{[(d.name, d.type, d.use) for d in bpy.context.preferences.addons['cycles'].preferences.devices]}")
    print(f"[device] requested={cfg['device']} selected={device} "
          f"cycles.device={sc.cycles.device}")

    sc.cycles.samples = cfg["samples"]
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.adaptive_threshold = 0.01
    sc.cycles.seed = SEED
    sc.cycles.use_denoising = True
    # OptiX denoiser needs working OptiX; OIDN with GPU backend is the safe
    # default here (denoises on the CUDA device, not the CPU).
    try:
        sc.cycles.denoiser = "OPENIMAGEDENOISE"
        sc.cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
        if device != "CPU":
            sc.cycles.denoising_openimagedenoise_use_gpu = True
    except Exception as e:
        print(f"[device] denoiser setup: {e}")
    sc.cycles.max_bounces = 8
    sc.cycles.transmissive_bounces = 4
    sc.cycles.volume_bounces = 0

    sc.render.resolution_x, sc.render.resolution_y = cfg["res"]
    sc.render.resolution_percentage = 100
    sc.render.image_settings.file_format = cfg.get("format", "PNG").upper()
    sc.render.image_settings.quality = cfg.get("quality", 85)
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Base Contrast"
    sc.view_settings.exposure = cfg.get("exposure", 0.0)

    sc.render.filepath = cfg["out"]


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--room", default="vitalnia", choices=sorted(SCENES.keys()))
    p.add_argument("--texture", default=CONFIG["texture_path"])
    p.add_argument("--out", default=CONFIG["out"])
    p.add_argument("--width", type=int, default=CONFIG["res"][0])
    p.add_argument("--height", type=int, default=CONFIG["res"][1])
    p.add_argument("--samples", type=int, default=CONFIG["samples"])
    p.add_argument("--roll-w", type=float, default=CONFIG["roll_w"])
    p.add_argument("--furniture", default=None,
                   choices=["sofa", "console", "none"])
    p.add_argument("--furniture-x", type=float, default=FURNITURE["x"])
    p.add_argument("--furniture-rot", type=float, default=FURNITURE["rot_z_deg"])
    p.add_argument("--yaw", type=float, default=None)
    p.add_argument("--format", default="png", choices=["png", "webp"])
    p.add_argument("--quality", type=int, default=85)
    p.add_argument("--key-power", type=float, default=None)
    p.add_argument("--fill-power", type=float, default=None)
    p.add_argument("--exposure", type=float, default=None)
    p.add_argument("--device", default="cuda", choices=["cuda", "optix", "cpu"])
    args = p.parse_args(argv)

    cfg = dict(CONFIG)
    cfg["texture_path"] = args.texture
    cfg["out"] = args.out
    cfg["res"] = (args.width, args.height)
    cfg["samples"] = args.samples
    cfg["roll_w"] = args.roll_w
    cfg["device"] = args.device
    cfg["format"] = args.format
    cfg["quality"] = args.quality
    if args.exposure is not None:
        cfg["exposure"] = args.exposure

    # CLI overrides (kept for the vitalnia workflow / render_windows.bat)
    if args.furniture is not None:
        piece = dict(FURNITURE)
        piece["kind"] = args.furniture
        piece["x"] = args.furniture_x
        piece["rot_z_deg"] = args.furniture_rot
        cfg["furniture_override"] = [] if args.furniture == "none" else [piece]
    if args.yaw is not None:
        SCENES[args.room]["camera"]["yaw_deg"] = args.yaw
    if args.key_power is not None:
        SCENES[args.room]["lights"]["key_power"] = args.key_power
    if args.fill_power is not None:
        SCENES[args.room]["lights"]["fill_power"] = args.fill_power

    assert cfg["texture_path"], "pass --texture /path/to/wallpaper.jpg"
    assert os.path.exists(cfg["texture_path"]), cfg["texture_path"]

    t0 = time.time()
    build_scene(args.room, cfg)
    setup_render(cfg)
    bpy.context.view_layer.update()

    os.makedirs(os.path.dirname(os.path.abspath(cfg["out"])) or ".", exist_ok=True)
    t1 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f"[done] out={cfg['out']} build={t1 - t0:.1f}s render={time.time() - t1:.1f}s "
          f"res={cfg['res']} samples={cfg['samples']}")


main()
