# Application icons

The RUNE icon uses the default theme accent and a geometric R. `icon.svg` is the
vector form, `icon.png` is the 512 px window/Linux icon, and `icon.ico` contains
16, 24, 32, 48, 64, 128, and 256 px images for Windows executable resources.
These assets are covered by the repository's MIT license.

Geometry is shared by all formats in `scripts/generate-branding.py`. To change the
artwork, edit that script and regenerate with Python and Pillow 12.2.0:

```bash
python scripts/generate-branding.py
```

Normal builds consume the checked-in assets and need neither Python nor Pillow.
The shell uses this window icon unless the workflow supplies `gui.logo`.
Manifest branding does not rewrite executable icons or publisher metadata.
