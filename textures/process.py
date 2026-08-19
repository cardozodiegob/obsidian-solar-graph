"""Normalises the generated plates in raw/ into the maps the plugin ships.

Sphere maps: the generators letterbox and vignette, and black rows would become
black poles once wrapped onto a sphere, so borders are cropped away before the
plate is resized to a 2:1 equirectangular map and saved as JPEG.

The ring map is different: it is read radially (x = distance from the planet), so
the rows are averaged into a single clean profile, and brightness becomes alpha
so the dark gaps between bands are actually see-through.

Run from this directory:  python process.py
"""

from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
RAW = HERE / "raw"

# Every plate in raw/ named <class>-<n>.png is processed. Ring maps are read
# radially rather than wrapped, so they take a different path.
SPHERE_SIZE = (1024, 512)  # 2:1 keeps the equirectangular mapping honest
RING_PREFIX = "rings-"

# The maps are embedded in main.js as data URLs, because Obsidian's installer only
# ever downloads main.js, manifest.json and styles.css from a release — a textures
# folder alongside them would simply not arrive. So the shipped set is halved:
# base64 inflates by a third, and a body is at most a few hundred pixels on screen.
DIST = HERE / "dist"
DIST_SIZE = (512, 256)
DIST_QUALITY = 78
JPEG_QUALITY = 88
# Rows/columns whose brightest pixel is below this are treated as border.
BORDER_LEVEL = 28


def crop_borders(image: Image.Image) -> Image.Image:
    """Trims letterbox bars and dark vignetting from the edges."""
    grey = np.asarray(image.convert("L"), dtype=np.int16)
    rows = np.where(grey.max(axis=1) > BORDER_LEVEL)[0]
    cols = np.where(grey.max(axis=0) > BORDER_LEVEL)[0]
    if rows.size == 0 or cols.size == 0:
        return image
    top, bottom = int(rows[0]), int(rows[-1])
    left, right = int(cols[0]), int(cols[-1])

    # Even after the hard bars are gone the outermost rows are often a dim
    # gradient, which reads as a grubby smear at the poles. Shave a little more.
    height = bottom - top + 1
    inset = int(height * 0.03)
    top = min(top + inset, bottom)
    bottom = max(bottom - inset, top)
    return image.crop((left, top, right + 1, bottom + 1))


def build_sphere_map(name: str, size: tuple[int, int]) -> None:
    source = RAW / f"{name}.png"
    if not source.exists():
        print(f"missing {source.name}")
        return
    image = Image.open(source).convert("RGB")
    before = image.size
    image = crop_borders(image)
    image = image.resize(size, Image.LANCZOS)
    target = HERE / f"{name}.jpg"
    image.save(target, "JPEG", quality=JPEG_QUALITY, optimize=True)
    print(
        f"{name}.jpg  {before[0]}x{before[1]} -> {size[0]}x{size[1]}  "
        f"{target.stat().st_size // 1024} KB"
    )


def build_ring_map(name: str, width: int = 512, height: int = 8) -> None:
    source = RAW / f"{name}.png"
    if not source.exists():
        print(f"missing {name}.png")
        return
    image = Image.open(source).convert("RGB")
    pixels = np.asarray(image, dtype=np.float32)

    # Average down the rows: the plate is drawn as vertical bands, so this
    # collapses it into the radial profile without any perspective mush.
    profile = pixels.mean(axis=0)  # (width, 3)
    profile = np.asarray(
        Image.fromarray(profile.astype(np.uint8)[None, :, :]).resize(
            (width, 1), Image.LANCZOS
        ),
        dtype=np.float32,
    )[0]

    luma = profile @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    low, high = np.percentile(luma, 2), np.percentile(luma, 98)
    alpha = np.clip((luma - low) / max(high - low, 1e-3), 0.0, 1.0)
    # Dark gaps should read as gaps, not grey haze.
    alpha = alpha**1.35

    # Fade both rims so the ring doesn't end on a hard line.
    ramp = np.linspace(0.0, 1.0, width, dtype=np.float32)
    edge = np.clip(np.minimum(ramp, 1.0 - ramp) / 0.06, 0.0, 1.0)
    alpha *= edge

    # Renormalise the colour to stay bright where it is visible.
    colour = np.clip(profile * 1.15, 0, 255)

    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    rgba[..., :3] = colour.astype(np.uint8)[None, :, :]
    rgba[..., 3] = (alpha * 255).astype(np.uint8)[None, :]

    target = HERE / f"{name}.png"
    Image.fromarray(rgba, "RGBA").save(target, "PNG", optimize=True)
    print(
        f"{name}.png  {image.size[0]}x{image.size[1]} -> {width}x{height}  "
        f"{target.stat().st_size // 1024} KB  "
        f"alpha {alpha.min():.2f}..{alpha.max():.2f}"
    )


def derive_recoloured(source: str, target: str, ramp: list[tuple[float, ...]]) -> None:
    """Rebuilds a plate in a new colour by remapping its luminance through `ramp`.

    Used for star-2: every attempt at generating a blue-white photosphere came back
    as a nebula, and the granulation pattern is the part that matters, so the gold
    plate is recoloured instead. See generate.sh.
    """
    path = HERE / f"{source}.jpg"
    if not path.exists():
        print(f"missing {source}.jpg, cannot derive {target}")
        return
    image = Image.open(path).convert("RGB")
    pixels = np.asarray(image, dtype=np.float32) / 255.0
    luma = pixels @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    # Stretch first: the source's darks and brights don't span the full range, and
    # without this the result is a flat mid-blue with no visible convection cells.
    low, high = np.percentile(luma, 1), np.percentile(luma, 99)
    luma = np.clip((luma - low) / max(high - low, 1e-3), 0.0, 1.0)

    stops = np.linspace(0.0, 1.0, len(ramp), dtype=np.float32)
    colours = np.array(ramp, dtype=np.float32)
    out = np.stack(
        [np.interp(luma, stops, colours[:, channel]) for channel in range(3)], axis=-1
    )
    result = Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8), "RGB")
    out_path = HERE / f"{target}.jpg"
    result.save(out_path, "JPEG", quality=JPEG_QUALITY, optimize=True)
    print(f"{target}.jpg  derived from {source}  {out_path.stat().st_size // 1024} KB")


def build_distributables() -> None:
    """Writes the smaller copies that actually get bundled into the plugin."""
    DIST.mkdir(exist_ok=True)
    total = 0
    for source in sorted(HERE.glob("*.jpg")):
        image = Image.open(source).convert("RGB").resize(DIST_SIZE, Image.LANCZOS)
        target = DIST / source.name
        image.save(target, "JPEG", quality=DIST_QUALITY, optimize=True)
        total += target.stat().st_size
    # Ring maps are a few hundred bytes already and are read radially, so they go
    # across untouched — resizing them would only blur the band edges.
    for source in sorted(HERE.glob("rings-*.png")):
        target = DIST / source.name
        target.write_bytes(source.read_bytes())
        total += target.stat().st_size
    count = len(list(DIST.iterdir()))
    print(f"dist/  {count} maps, {total // 1024} KB (~{int(total * 4 / 3) // 1024} KB as base64)")


if __name__ == "__main__":
    plates = sorted(p.stem for p in RAW.glob("*.png") if "." not in p.stem)
    if not plates:
        print(f"no plates in {RAW} — run generate.sh first")
    for name in plates:
        if name.startswith(RING_PREFIX):
            build_ring_map(name)
        else:
            build_sphere_map(name, SPHERE_SIZE)

    # Hot blue-white star, from the gold one.
    derive_recoloured(
        "star-1",
        "star-2",
        [(0.04, 0.09, 0.28), (0.16, 0.38, 0.78), (0.55, 0.78, 1.0), (1.0, 1.0, 1.0)],
    )
    build_distributables()
