#!/usr/bin/env python3
"""
Generate placeholder pixel-art sprites for AOPet.

Each sprite is a 16x16 PNG. Two frames per mood per sprite set so we have
something to animate. Replace these with real art once it's available — the
sprite loader keys on filenames `{mood}_{frame}.png`.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / "Sources" / "AOPet" / "Resources" / "sprites"

# Mood → (body color, accent color, eye style).
# We draw a 16x16 blob with a flat body, two pixels for eyes, plus a small
# accent shape that varies per mood (z's for sleeping, exclamation for sad,
# checkmark for happy, etc.) plus a per-frame jitter so animation is visible.
PALETTES = {
    "dog": {
        "body": (212, 165, 116),   # tan
        "accent": (90, 60, 30),    # dark brown
    },
    "cat": {
        "body": (180, 180, 200),   # grey-blue
        "accent": (40, 40, 60),    # dark slate
    },
}

MOODS = ["sleeping", "happy", "working", "sad", "alert", "hidden"]

W = H = 16


def base_body(draw: ImageDraw.ImageDraw, body, accent, frame: int):
    # Rounded blob body.
    draw.rectangle((3, 5, 12, 13), fill=body)
    draw.rectangle((4, 4, 11, 4), fill=body)
    draw.rectangle((4, 14, 11, 14), fill=body)
    # Ears.
    draw.rectangle((3, 3, 4, 4), fill=accent)
    draw.rectangle((11, 3, 12, 4), fill=accent)
    # Eyes (frame-dependent: blink on frame 1).
    if frame == 0:
        draw.point((6, 8), fill=accent)
        draw.point((9, 8), fill=accent)
    else:
        draw.line(((6, 8), (6, 8)), fill=accent)
        draw.line(((9, 8), (9, 8)), fill=accent)


def draw_sleeping(img: Image.Image, palette, frame: int):
    d = ImageDraw.Draw(img)
    base_body(d, palette["body"], palette["accent"], frame)
    # Closed eyes.
    d.line(((5, 8), (7, 8)), fill=palette["accent"])
    d.line(((8, 8), (10, 8)), fill=palette["accent"])
    # Floating "Z" — moves up between frames.
    z_y = 1 if frame == 0 else 0
    d.point((13, z_y + 1), fill=(80, 80, 200))
    d.point((14, z_y + 1), fill=(80, 80, 200))
    d.point((14, z_y + 2), fill=(80, 80, 200))
    d.point((13, z_y + 3), fill=(80, 80, 200))
    d.point((14, z_y + 3), fill=(80, 80, 200))


def draw_happy(img: Image.Image, palette, frame: int):
    d = ImageDraw.Draw(img)
    base_body(d, palette["body"], palette["accent"], frame)
    # Smile.
    d.line(((6, 11), (9, 11)), fill=palette["accent"])
    # Green checkmark, alternates position.
    cx = 12 if frame == 0 else 11
    d.point((cx, 6), fill=(60, 180, 90))
    d.point((cx + 1, 7), fill=(60, 180, 90))
    d.point((cx + 2, 6), fill=(60, 180, 90))
    d.point((cx + 3, 5), fill=(60, 180, 90))


def draw_working(img: Image.Image, palette, frame: int):
    d = ImageDraw.Draw(img)
    base_body(d, palette["body"], palette["accent"], frame)
    # Forward-leaning typing pose: legs alternate between frames.
    if frame == 0:
        d.line(((4, 14), (6, 14)), fill=palette["accent"])
        d.line(((9, 14), (11, 14)), fill=palette["accent"])
    else:
        d.line(((5, 14), (7, 14)), fill=palette["accent"])
        d.line(((8, 14), (10, 14)), fill=palette["accent"])
    # Tiny keyboard underneath.
    d.line(((4, 15), (11, 15)), fill=(120, 120, 120))


def draw_sad(img: Image.Image, palette, frame: int):
    d = ImageDraw.Draw(img)
    base_body(d, palette["body"], palette["accent"], frame)
    # Frown.
    d.line(((6, 12), (9, 12)), fill=palette["accent"])
    d.point((6, 11), fill=palette["accent"])
    d.point((9, 11), fill=palette["accent"])
    # Red "!" — wobbles between frames.
    bx = 13 if frame == 0 else 12
    d.line(((bx, 1), (bx, 4)), fill=(220, 60, 60))
    d.point((bx, 6), fill=(220, 60, 60))


def draw_alert(img: Image.Image, palette, frame: int):
    d = ImageDraw.Draw(img)
    base_body(d, palette["body"], palette["accent"], frame)
    # Wide eyes.
    d.rectangle((5, 7, 6, 8), fill=palette["accent"])
    d.rectangle((9, 7, 10, 8), fill=palette["accent"])
    # Red clock — flashes between frames.
    color = (220, 60, 60) if frame == 0 else (255, 120, 120)
    d.ellipse((11, 0, 15, 4), outline=color)
    d.point((13, 1), fill=color)
    d.point((13, 2), fill=color)


def draw_hidden(img: Image.Image, palette, frame: int):
    # Hidden state — render a single transparent pixel so the file exists
    # and the loader can fall back gracefully if the controller asks for it.
    pass


DRAW_FNS = {
    "sleeping": draw_sleeping,
    "happy": draw_happy,
    "working": draw_working,
    "sad": draw_sad,
    "alert": draw_alert,
    "hidden": draw_hidden,
}


def main():
    for sprite_name, palette in PALETTES.items():
        out_dir = ROOT / sprite_name
        out_dir.mkdir(parents=True, exist_ok=True)
        for mood in MOODS:
            for frame in (0, 1):
                img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                DRAW_FNS[mood](img, palette, frame)
                path = out_dir / f"{mood}_{frame}.png"
                img.save(path)
                print(f"wrote {path.relative_to(ROOT.parent.parent.parent)}")


if __name__ == "__main__":
    main()
