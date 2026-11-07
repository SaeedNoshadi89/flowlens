"""Assemble recorded frames into the README GIF. Usage: make-gif.py <work dir with manifest.json> <out.gif>"""
import json
import sys

from PIL import Image

work, out = sys.argv[1], sys.argv[2]
manifest = json.load(open(work + "/manifest.json"))
WIDTH = 1080
frames = []
for entry in manifest:
    im = Image.open(entry["file"]).convert("RGB")
    im = im.resize((WIDTH, round(im.height * WIDTH / im.width)), Image.LANCZOS)
    # A palette per frame keeps the neon lane colours; frame-diff optimisation is off
    # because it does not work with differing palettes.
    frames.append(im.quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE))
frames[0].save(out, save_all=True, append_images=frames[1:], duration=[e["ms"] for e in manifest], loop=0, optimize=False, disposal=2)
print(f"{len(frames)} frames, {sum(e['ms'] for e in manifest) / 1000:.1f} s")
