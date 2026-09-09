"""Regenerate the checked-in RUNE icons with Python and Pillow 12.2.0."""

from pathlib import Path

from PIL import Image, ImageDraw


destination = Path(__file__).resolve().parents[1] / "packages/gui-shell/resources"
destination.mkdir(parents=True, exist_ok=True)

# A geometric R stays readable at taskbar sizes. Share its geometry across formats.
size = 512
accent = "#4f6df5"
outline = [(144, 112), (296, 112), (368, 184), (368, 248),
           (296, 304), (384, 400), (296, 400), (216, 312),
           (216, 400), (144, 400)]
counter = [(216, 184), (272, 184), (296, 208), (296, 224),
           (272, 248), (216, 248)]

def points(vertices):
    return " ".join(f"{x},{y}" for x, y in vertices)

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>RUNE</title>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="{accent}" />
  <polygon points="{points(outline)}" fill="#ffffff" />
  <polygon points="{points(counter)}" fill="{accent}" />
</svg>
'''
(destination / "icon.svg").write_text(svg, encoding="utf-8", newline="\n")

scale = 4
image = Image.new("RGBA", (size * scale, size * scale))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((64, 64, 1983, 1983), radius=104 * scale, fill=accent)
for polygon, color in [(outline, "#ffffff"), (counter, accent)]:
    draw.polygon([(x * scale, y * scale) for x, y in polygon], fill=color)
image = image.resize((size, size), Image.Resampling.LANCZOS)
image.save(destination / "icon.png", optimize=False)
image.save(destination / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
