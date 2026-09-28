"""Cut, key and vectorise ChatGPT-generated illustration sheets.

Usage:
  python process-generated-art.py sheet <raw.png> <cols> <rows> <name1,name2,...> [--vector]
  python process-generated-art.py single <raw.png> <name> [--vector] [--keep-bg]

Background removal: the flat off-white background is flood-filled from the
image border (so enclosed cream fills such as paper sheets stay opaque), then
the edge is feathered. rembg is used only with --rembg for busy scenes.
Outputs go to frontend2/public/illustrations/generated/<name>.{png,webp,svg}.
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

OUT = Path(__file__).resolve().parents[1] / "public" / "illustrations" / "generated"
OUT.mkdir(parents=True, exist_ok=True)
MAX_BYTES = 150 * 1024
SVG_MAX = 80 * 1024
ICON_MODE = False


def bg_colour(a: np.ndarray) -> np.ndarray:
    border = np.concatenate([a[0], a[-1], a[:, 0], a[:, -1]])
    return np.median(border[:, :3], axis=0)


def key_out(img: Image.Image, thr: float = 22.0) -> Image.Image:
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    bg = bg_colour(a)
    dist = np.sqrt(((a - bg) ** 2).sum(-1))
    lum = a.mean(-1)
    chroma = a.max(-1) - a.min(-1)
    # pale, low-chroma pixels (incl. bright sharpening fringes) count as background
    # candidates; only those connected to the border are removed
    near = (dist < thr) | ((lum > bg.mean() - 14) & (chroma < 40))
    lab, _ = ndimage.label(near)
    edge_labels = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    edge_labels = edge_labels[edge_labels != 0]
    bgmask = np.isin(lab, edge_labels)
    # soft alpha: fully transparent in bg, ramp near the boundary by colour distance
    ramp = np.clip((dist - 6) / (thr - 6), 0, 1) * 255
    # background pixels next to the art keep a partial alpha (anti-aliased edge)
    edge = bgmask & ndimage.binary_dilation(~bgmask, iterations=2)
    alpha = np.where(bgmask, np.where(edge, ramp, 0.0), 255.0)
    al = np.asarray(Image.fromarray(alpha.astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32) / 255
    # decontaminate: remove the off-white background blended into soft edge pixels
    # semi-transparent edge pixels take the colour of their darkest 5x5 neighbour
    # (the ink line), so no pale fringe shows on dark backgrounds
    al = np.clip((al - 0.12) / 0.88, 0, 1)
    dark = np.stack([ndimage.minimum_filter(a[..., c], size=5) for c in range(3)], -1)
    rgb = np.where((al < 0.98)[..., None], dark, a)
    out = np.dstack([rgb, al * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def key_icon(img: Image.Image) -> Image.Image:
    """Colour-to-alpha against the flat background, applied everywhere (icons
    have no opaque paper fills, so enclosed white must become transparent)."""
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    bg = bg_colour(a)
    dist = np.sqrt(((a - bg) ** 2).sum(-1))
    al = np.clip((dist - 18) / 70, 0, 1)
    k = np.clip(al, 0.15, 1)[..., None]
    rgb = np.clip((a - (1 - k) * bg) / k, 0, 255)
    return Image.fromarray(np.dstack([rgb, al * 255]).astype(np.uint8), "RGBA")


def crop_to_content(im: Image.Image, pad: int = 16) -> Image.Image:
    al = np.asarray(im.getchannel("A"))
    ys, xs = np.where(al > 24)
    if len(xs) == 0:
        return im
    x0, x1 = max(xs.min() - pad, 0), min(xs.max() + pad, im.width)
    y0, y1 = max(ys.min() - pad, 0), min(ys.max() + pad, im.height)
    return im.crop((x0, y0, x1, y1))


def save_raster(im: Image.Image, name: str, max_side: int = 640) -> dict:
    im = im.copy()
    im.thumbnail((max_side, max_side), Image.LANCZOS)
    files = {}
    png = OUT / f"{name}.png"
    p_im, colours = im, 96
    while True:
        p_im.quantize(colors=colours, method=Image.FASTOCTREE, dither=Image.NONE).save(png, optimize=True)
        if png.stat().st_size <= MAX_BYTES:
            break
        if colours > 48:
            colours -= 16
        else:
            p_im = p_im.resize((int(p_im.width * 0.85), int(p_im.height * 0.85)), Image.LANCZOS)
    webp = OUT / f"{name}.webp"
    q = 88
    while True:
        im.save(webp, "WEBP", quality=q, method=6)
        if webp.stat().st_size <= MAX_BYTES or q <= 40:
            break
        q -= 8
    files["png"], files["webp"] = png.stat().st_size, webp.stat().st_size
    return files


def vectorise(im: Image.Image, name: str) -> int | None:
    import vtracer

    tmp = OUT / f"_{name}_src.png"
    big = im.copy()
    big.thumbnail((900, 900), Image.LANCZOS)
    # hard alpha for tracing: soft edges make vtracer emit mottled grey slivers
    big.putalpha(big.getchannel("A").point(lambda v: 255 if v >= 128 else 0))
    big.save(tmp)
    svg = OUT / f"{name}.svg"
    vtracer.convert_image_to_svg_py(
        str(tmp), str(svg), colormode="color", hierarchical="stacked", mode="spline",
        filter_speckle=6, color_precision=5, layer_difference=24, corner_threshold=60,
        length_threshold=4.0, max_iterations=10, splice_threshold=45, path_precision=2,
    )
    tmp.unlink()
    return svg.stat().st_size


def process(im: Image.Image, name: str, vector: bool, keep_bg: bool, use_rembg: bool, max_side: int) -> dict:
    if use_rembg:
        from rembg import remove
        cut = remove(im.convert("RGBA"))
    elif keep_bg:
        cut = im.convert("RGBA")
    elif ICON_MODE:
        cut = key_icon(im)
    else:
        cut = key_out(im)
    if not keep_bg:
        cut = crop_to_content(cut)
    info = {"size": list(cut.size), **save_raster(cut, name, max_side)}
    if vector:
        info["svg"] = vectorise(cut, name)
    return info


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    vector, keep_bg, use_rembg = "--vector" in flags, "--keep-bg" in flags, "--rembg" in flags
    global ICON_MODE
    ICON_MODE = "--icon" in flags
    mode, raw = args[0], Image.open(args[1]).convert("RGB")
    names = args[4].split(",") if mode == "sheet" else [args[2]]
    if mode == "sheet":
        cols, rows, names = int(args[2]), int(args[3]), args[4].split(",")
        w, h = raw.width / cols, raw.height / rows
        for i, name in enumerate(names):
            if not name or name == "-":
                continue
            r, c = divmod(i, cols)
            cell = raw.crop((int(c * w), int(r * h), int((c + 1) * w), int((r + 1) * h)))
            print(name, process(cell, name, vector, keep_bg, use_rembg, 256 if ICON_MODE else (1400 if keep_bg else 640)))
    else:
        print(args[2], process(raw, args[2], vector, keep_bg, use_rembg, 1600))
    if vector:
        subprocess.run(f'npx --yes svgo --multipass -q -f "{OUT}"', check=False, shell=True)
        if ICON_MODE:
            import re
            def ink(m):
                h = m.group(2)
                h = "".join(c * 2 for c in h) if len(h) == 3 else h
                r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
                dark = (r + g + b) / 3 < 110 and max(r, g, b) - min(r, g, b) < 40
                return f'{m.group(1)}"currentColor"' if dark else m.group(0)
            for n in names:
                f = OUT / f"{n}.svg"
                if f.exists():
                    f.write_text(re.sub(r'(fill=)"#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})"', ink, f.read_text()))
        for f in sorted(OUT.glob("*.svg")):
            # a trace heavier than 80 KB is not "flat" art: ship raster only
            if f.stat().st_size > SVG_MAX:
                print("svg dropped (too heavy)", f.name, f.stat().st_size)
                f.unlink()


if __name__ == "__main__":
    main()
