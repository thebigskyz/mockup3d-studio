"""Make the smaller copy of the HDRI that the Figma plugin loads.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P blender/downscale_hdri.py -- env/studio-panels.exr env/studio-panels-2k.exr

Scales the 4096 x 2048 panorama to 2048 x 1024 (about 3 MB instead of 12)
and saves it as a half-float EXR. The light values stay the same; only
fine detail in reflections is softer, which doesn't show at plugin sizes.
Run it again after rebuilding the HDRI (build_hdri.py).
"""
import bpy, sys
src, dst = sys.argv[sys.argv.index('--') + 1:][:2]
img = bpy.data.images.load(src)
print('source', img.size[:], img.is_float)
img.scale(2048, 1024)
s = bpy.context.scene.render.image_settings
s.file_format = 'OPEN_EXR'
s.color_depth = '16'
s.exr_codec = 'ZIP'
s.color_mode = 'RGB'
img.save_render(dst, scene=bpy.context.scene)
print('saved', dst)
