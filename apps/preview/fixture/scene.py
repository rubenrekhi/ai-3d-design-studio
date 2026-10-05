from pathlib import Path

import bpy


ROOT = Path(__file__).resolve().parents[1]


def material(name, color, roughness=0.6, metallic=0.0):
    value = bpy.data.materials.new(name)
    value.diffuse_color = (*color, 1.0)
    value.use_nodes = True
    shader = value.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1.0)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    return value


def cube(name, location, dimensions, surface):
    bpy.ops.mesh.primitive_cube_add(location=location)
    value = bpy.context.object
    value.name = name
    value.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    value.data.materials.append(surface)
    bevel = value.modifiers.new("soft edges", "BEVEL")
    bevel.width = 0.025
    bevel.segments = 3
    bpy.context.view_layer.objects.active = value
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    return value


bpy.ops.wm.read_factory_settings(use_empty=True)

plaster = material("warm plaster", (0.72, 0.68, 0.58), 0.78)
wood = material("walnut", (0.16, 0.055, 0.022), 0.48)
fabric = material("rust fabric", (0.45, 0.095, 0.045), 0.9)
metal = material("dark metal", (0.04, 0.045, 0.05), 0.28, 0.85)
stone = material("stone", (0.25, 0.28, 0.3), 0.72)
proxy = material("collision proxy", (0.04, 0.55, 0.8), 0.4)

cube("DemoFloor-col", (0, 0, -0.1), (9, 8, 0.2), wood)
cube("NorthWall-col", (0, 4, 1.5), (9, 0.2, 3), plaster)
cube("WestWall-col", (-4.4, 0, 1.5), (0.2, 8, 3), plaster)
cube("EastWall-col", (4.4, 0, 1.5), (0.2, 8, 3), plaster)

cube("DemoCouch", (-2.1, 1.7, 0.45), (2.4, 0.9, 0.72), fabric)
cube("DemoCouchBack", (-2.1, 2.05, 1.05), (2.4, 0.2, 0.95), fabric)
cube("DemoCouch-convcolonly", (-2.1, 1.82, 0.65), (2.45, 0.95, 1.3), proxy)

for index in range(4):
    cube(
        f"StairTread{index + 1}",
        (2.6, 2.7 + index * 0.3, 0.125 + index * 0.25),
        (2.2, 0.32, 0.25),
        stone,
    )

ramp = cube("StairRamp-colonly", (2.6, 3.17, 0.5), (2.2, 1.2, 0.16), proxy)
ramp.rotation_euler[0] = -0.69
bpy.context.view_layer.objects.active = ramp
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=(1.4, -0.2, 0.65))
sculpture = bpy.context.object
sculpture.name = "PenetrableSculpture"
sculpture.scale = (0.48, 0.48, 0.78)
sculpture.data.materials.append(metal)
bpy.ops.object.shade_smooth()

settings = bpy.data.objects.new("__studio_scene_settings__", None)
settings["studio_contract_version"] = 1
settings["studio_scene_kind"] = "environment"
bpy.context.scene.collection.objects.link(settings)

spawn = bpy.data.objects.new("__studio_player_spawn__", None)
spawn.location = (0, -2.4, 0)
spawn.rotation_euler[2] = 0
spawn["studio_player_height_m"] = 1.8
spawn["studio_player_radius_m"] = 0.35
spawn["studio_eye_height_m"] = 1.65
spawn["studio_walk_speed_mps"] = 3.0
spawn["studio_run_speed_mps"] = 6.0
spawn["studio_jump_speed_mps"] = 5.0
spawn["studio_gravity_mps2"] = 9.81
spawn["studio_max_slope_degrees"] = 50.0
spawn["studio_fall_reset_m"] = 12.0
bpy.context.scene.collection.objects.link(spawn)

sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 3.0
sun_data.color = (1.0, 0.72, 0.42)
sun = bpy.data.objects.new("Sun", sun_data)
sun.rotation_euler = (1.28, 0.0, 2.4)
bpy.context.scene.collection.objects.link(sun)

bpy.ops.export_scene.gltf(
    filepath=str(ROOT / "public" / "scene.glb"),
    export_apply=True,
    export_extras=True,
    export_lights=True,
    export_import_convert_lighting_mode="COMPAT",
)
