"""Compose the app icon layers and every derived raster from the split artwork.

Input is the wand / creature pair produced by separate.py at 4096px render width.
Every run writes both output families into --out:

* Icon Composer layers (`layers/`) -- clean artwork on transparent canvases, with
  no baked glow or shadow. iOS 26 adds specular highlight and shadow itself; baking
  them in fights the system and reads as dirty under Liquid Glass.
* Flat rasters -- the iOS <=18 / Android / web fallback, where the gradient, rim
  glow and wand-tip bloom are baked in so it matches the Electron desktop icon.

The source creature is flat #79B0DC with bevel shading painted on top. To impose
the Electron icon's vertical gradient without losing that bevel, each pixel's
luminance is measured as a ratio against the base fill and used to modulate the
gradient ramp. Highlights and shadows survive; the eyes stay dark.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageFilter

# --- Palette, matched to frontend/assets/icon.png (the Electron icon) -----------
BASE_FILL = (121, 176, 220)  # #79B0DC, the creature's flat body colour
GRAD_TOP = (168, 208, 236)  # #A8D0EC
GRAD_BOTTOM = (46, 78, 134)  # #2E4E86
# The tile background is a vertical gradient, not a flat fill. A flat near-black
# reads as a hole rather than a glass slab; Apple's own dark icons (Fitness,
# Watch) lift the top. These two stops match what Apple's automatic-gradient
# produces for the .icon, so the Android/web raster matches the iOS 26 render.
BACKGROUND_TOP = (50, 53, 58)
BACKGROUND = (10, 11, 13)  # #0a0b0d, matches app.json backgroundColor
RIM_GLOW = (150, 200, 245)
TIP_GLOW = (232, 242, 255)

# Fraction of the canvas width the full logo (creature + wand) spans, plus the
# offsets that optically centre it.
#
# Centring the logo's bounding box does not work here: the wand juts up and to the
# right while the creature sits low and left, so box-centring leaves the creature
# visibly displaced. Centring the creature alone is not right either -- it forces a
# smaller scale to keep the wand tip inside the mask, and leaves a ~31% bottom gap.
#
# These offsets balance the alpha-weighted centre of mass at 50/50, so the wand
# counts for the visual weight it actually carries rather than for the area of its
# bounding box. Re-solve with scripts/icon-build/ if the artwork changes.
#
# The scale is set by the wand tip, not by the creature. The tip glow sits near the
# top-right corner, exactly where the icon mask curves inward, so it runs out of
# room well before the creature does: at 0.685 the glow came within 2.1% of the
# mask edge and read as touching the corner. 0.630 leaves 6.6%.
LOGO_WIDTH_FRACTION = 0.630
LOGO_X_NUDGE = 0.0393
LOGO_Y_NUDGE = -0.0781
# The splash is drawn on a full-bleed background with no icon mask, so the wand-tip
# clearance that pins LOGO_WIDTH_FRACTION does not apply and this is sized on its
# own. Kept as-is rather than folded into LOGO_WIDTH_FRACTION: at resizeMode
# "contain" the difference is ~1.6% of logo width, and matching them would rewrite
# splash-icon.png for no visible gain.
SPLASH_WIDTH_FRACTION = 0.62
# Android guarantees only the central 66dp of the 108dp adaptive-icon canvas
# survives masking. The logo is fitted to that circle by content radius.
ANDROID_SAFE_DIAMETER = 66 / 108


def luminance(r, g, b):
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


BASE_LUM = luminance(*BASE_FILL)


def apply_gradient(layer, top_y, height):
    """Recolour a layer with the vertical Electron gradient, preserving shading."""
    out = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    src, dst = layer.load(), out.load()
    w, h = layer.size
    ramp = []
    for y in range(h):
        t = min(max((y - top_y) / height, 0.0), 1.0)
        ramp.append(tuple(GRAD_TOP[i] + (GRAD_BOTTOM[i] - GRAD_TOP[i]) * t for i in range(3)))
    for y in range(h):
        gr, gg, gb = ramp[y]
        for x in range(w):
            r, g, b, a = src[x, y]
            if a == 0:
                continue
            shade = luminance(r, g, b) / BASE_LUM
            dst[x, y] = (
                min(255, int(gr * shade)),
                min(255, int(gg * shade)),
                min(255, int(gb * shade)),
                a,
            )
    return out


def tinted(alpha, colour):
    img = Image.new("RGBA", alpha.size, colour + (0,))
    img.putalpha(alpha)
    return img


def top_biased(alpha, top_y, height):
    """Fade a mask out towards the bottom so glow reads as light from above."""
    out = alpha.copy()
    px = out.load()
    w, h = out.size
    for y in range(h):
        t = min(max((y - top_y) / height, 0.0), 1.0)
        k = max(0.0, 1.0 - t * 1.6)
        if k >= 1.0:
            continue
        for x in range(w):
            v = px[x, y]
            if v:
                px[x, y] = int(v * k)
    return out


def place(creature, wand, size, width_fraction, x_nudge=0.0, y_nudge=0.0):
    """Scale the combined logo to `width_fraction` of `size` and centre it."""
    combined = Image.alpha_composite(creature, wand)
    box = combined.getbbox()
    logo_w = box[2] - box[0]
    logo_h = box[3] - box[1]
    scale = (size * width_fraction) / logo_w
    new_w, new_h = max(1, round(logo_w * scale)), max(1, round(logo_h * scale))
    off_x = round((size - new_w) / 2 + size * x_nudge)
    off_y = round((size - new_h) / 2 + size * y_nudge)

    def fit(layer):
        cropped = layer.crop(box).resize((new_w, new_h), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.paste(cropped, (off_x, off_y))
        return canvas

    return fit(creature), fit(wand), (off_y, new_h)


def place_in_circle(creature, wand, size, diameter_fraction):
    """Scale the logo so every opaque pixel fits inside Android's safe circle.

    Adaptive-icon launchers mask the canvas, and only the central 66dp of the
    108dp canvas is guaranteed to survive. Fitting the logo's bounding box is not
    enough here: the wand tip and the creature's rear foot sit at opposite corners
    of that box, so box-fitting pushes both outside the circle and the wand tip
    gets clipped. Measuring the actual content radius avoids that.
    """
    combined = Image.alpha_composite(creature, wand)
    box = combined.getbbox()
    px = combined.load()
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    worst = max(
        ((x - cx) ** 2 + (y - cy) ** 2)
        for y in range(box[1], box[3])
        for x in range(box[0], box[2])
        if px[x, y][3] > 8
    ) ** 0.5

    scale = (size * diameter_fraction / 2) / worst
    logo_w, logo_h = box[2] - box[0], box[3] - box[1]
    new_w, new_h = max(1, round(logo_w * scale)), max(1, round(logo_h * scale))
    off_x, off_y = round((size - new_w) / 2), round((size - new_h) / 2)

    def fit(layer):
        cropped = layer.crop(box).resize((new_w, new_h), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.paste(cropped, (off_x, off_y))
        return canvas

    return fit(creature), fit(wand), (off_y, new_h)


def graded(creature_placed, wand_placed, span):
    top_y, height = span
    return (
        apply_gradient(creature_placed, top_y, height),
        apply_gradient(wand_placed, top_y, height),
    )


def wand_tip(wand_placed):
    """Topmost point of the wand, where the bloom sits."""
    box = wand_placed.getbbox()
    px = wand_placed.load()
    y = box[1]
    xs = [x for x in range(box[0], box[2]) if px[x, y][3] > 40]
    return ((xs[0] + xs[-1]) // 2 if xs else (box[0] + box[2]) // 2, y)


def tip_bloom(wand_placed, size, radius_fraction=0.040, falloff=2.8):
    """Radial bloom centred on the wand tip.

    Baked into the flat raster, and supplied to Icon Composer as its own layer:
    iOS 26 adds specular and shadow but never emissive glow, so without this the
    wand tip would go dark under Liquid Glass.
    """
    tx, ty = wand_tip(wand_placed)
    bloom = Image.new("L", (size, size), 0)
    bp = bloom.load()
    r = size * radius_fraction
    for y in range(max(0, int(ty - r)), min(size, int(ty + r))):
        for x in range(max(0, int(tx - r)), min(size, int(tx + r))):
            d = ((x - tx) ** 2 + (y - ty) ** 2) ** 0.5 / r
            if d < 1.0:
                bp[x, y] = int(255 * (1.0 - d) ** falloff)
    return bloom


def background_gradient(size):
    """Vertical tile gradient matching the .icon's automatic-gradient."""
    canvas = Image.new("RGBA", (size, size))
    d = canvas.load()
    for y in range(size):
        t = y / max(1, size - 1)
        # ease out so the lift concentrates in the upper third, as Apple's does
        k = (1.0 - t) ** 2.2
        row = tuple(
            int(BACKGROUND[i] + (BACKGROUND_TOP[i] - BACKGROUND[i]) * k) for i in range(3)
        ) + (255,)
        for x in range(size):
            d[x, y] = row
    return canvas


def flat_icon(creature, wand, size):
    canvas = background_gradient(size)
    creature_p, wand_p, span = place(
        creature, wand, size, LOGO_WIDTH_FRACTION, LOGO_X_NUDGE, LOGO_Y_NUDGE
    )
    creature_g, wand_g = graded(creature_p, wand_p, span)

    # Rim glow: blurred silhouette, biased to the top, laid under the artwork.
    radius = size * 0.026
    silhouette = Image.alpha_composite(creature_p, wand_p).getchannel("A")
    glow_mask = silhouette.filter(ImageFilter.GaussianBlur(radius))
    glow_mask = top_biased(glow_mask, span[0], span[1])
    glow_mask = glow_mask.point(lambda v: int(v * 0.38))
    canvas.alpha_composite(tinted(glow_mask, RIM_GLOW))

    canvas.alpha_composite(creature_g)
    canvas.alpha_composite(wand_g)

    # Wand-tip bloom, on top of everything.
    canvas.alpha_composite(tinted(tip_bloom(wand_p, size), TIP_GLOW))
    return canvas


def monochrome(creature, wand, size):
    """White silhouette on transparent, for Android 13+ themed icons."""
    c, w, _ = place_in_circle(creature, wand, size, ANDROID_SAFE_DIAMETER)
    alpha = Image.alpha_composite(c, w).getchannel("A")
    return tinted(alpha, (255, 255, 255))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creature", required=True)
    ap.add_argument("--wand", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    creature = Image.open(args.creature).convert("RGBA")
    wand = Image.open(args.wand).convert("RGBA")
    out = Path(args.out)
    (out / "layers").mkdir(parents=True, exist_ok=True)

    # --- Icon Composer layers: clean, no glow, no shadow, transparent canvas ---
    c_p, w_p, span = place(
        creature, wand, 1024, LOGO_WIDTH_FRACTION, LOGO_X_NUDGE, LOGO_Y_NUDGE
    )
    c_g, w_g = graded(c_p, w_p, span)
    c_g.save(out / "layers" / "creature.png")
    w_g.save(out / "layers" / "wand.png")
    # Wider and softer than the flat version: Liquid Glass composites the glow
    # over its own specular pass, so a tight hotspot reads as a hard white dot.
    tinted(tip_bloom(w_p, 1024, radius_fraction=0.055, falloff=2.0), TIP_GLOW).save(
        out / "layers" / "tip-glow.png"
    )

    # --- Flat rasters ---------------------------------------------------------
    icon = flat_icon(creature, wand, 1024)
    icon.convert("RGB").save(out / "icon.png")

    splash = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    sc, sw, sspan = place(
        creature, wand, 1024, SPLASH_WIDTH_FRACTION, LOGO_X_NUDGE, LOGO_Y_NUDGE
    )
    scg, swg = graded(sc, sw, sspan)
    splash.alpha_composite(scg)
    splash.alpha_composite(swg)
    splash.save(out / "splash-icon.png")

    fg = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    ac, aw, aspan = place_in_circle(creature, wand, 1024, ANDROID_SAFE_DIAMETER)
    acg, awg = graded(ac, aw, aspan)
    fg.alpha_composite(acg)
    fg.alpha_composite(awg)
    fg.save(out / "android-icon-foreground.png")

    monochrome(creature, wand, 1024).save(out / "android-icon-monochrome.png")

    icon.resize((256, 256), Image.LANCZOS).save(out / "favicon.png")
    print("wrote", ", ".join(sorted(p.name for p in out.iterdir())))


if __name__ == "__main__":
    main()
