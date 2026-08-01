"""Split the rendered ao-logo into wand / creature layers.

Icon Composer needs the wand and the creature as separate layers so iOS 26 can
light each one independently. The traced ao-logo.svg draws the wand and the trunk
curl inside a single subpath, so geometry cannot separate them -- but colour can:
the wand is the desaturated grey family (#DEE3EA shaft, #7E8BB0 shadow side) and
the creature is the blue family. The hue+value rule was checked against all 21
fills in the source.

Two cleanups follow the colour split:

1. Anti-aliased pixels along the wand's edges blend grey into blue and land in
   the creature bucket, leaving a faint ghost stroke. They are reassigned to the
   wand layer (not deleted) so the wand keeps smooth edges and no seam opens up.
2. Anti-aliasing on the creature's own outline produces a few hundred 1-2px
   grey-ish slivers that the colour rule claims for the wand. Only the largest
   connected component is a real wand, so the rest go back to the creature.
"""
import colorsys
import sys

from PIL import Image, ImageFilter

WAND_DILATE = 7  # px at 4096 render width; covers the ~2px AA fringe with margin


def is_wand_colour(r, g, b):
    hue, sat, val = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    hue *= 360
    if sat < 0.10:  # #DEE3EA -- near-white shaft
        return True
    return 215 <= hue <= 235 and val > 0.61  # #7E8BB0 -- shaft shadow side


def largest_component(alpha):
    """Bounding-box-free flood fill; returns a set-like bytearray mask."""
    px = alpha.load()
    w, h = alpha.size
    seen = bytearray(w * h)
    best, best_size = None, 0
    for sy in range(h):
        for sx in range(w):
            if px[sx, sy] == 0 or seen[sy * w + sx]:
                continue
            stack, members = [(sx, sy)], []
            seen[sy * w + sx] = 1
            while stack:
                x, y = stack.pop()
                members.append((x, y))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and px[nx, ny] and not seen[ny * w + nx]:
                        seen[ny * w + nx] = 1
                        stack.append((nx, ny))
            if len(members) > best_size:
                best, best_size = members, len(members)
    return set(best or ())


def main(src, wand_out, body_out):
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    wand = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    body = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sp, wp, bp = im.load(), wand.load(), body.load()

    for y in range(h):
        for x in range(w):
            r, g, b, a = sp[x, y]
            if a == 0:
                continue
            (wp if is_wand_colour(r, g, b) else bp)[x, y] = (r, g, b, a)

    # (1) Reclaim the wand's anti-aliased fringe from the creature layer.
    near_wand = wand.getchannel("A").filter(ImageFilter.MaxFilter(WAND_DILATE)).load()
    moved = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = bp[x, y]
            # Solid creature pixels stay put even where the curl meets the wand;
            # only partial-coverage pixels beside the wand are fringe.
            if a == 0 or a >= 250 or not near_wand[x, y]:
                continue
            bp[x, y] = (0, 0, 0, 0)
            if wp[x, y][3] == 0:
                wp[x, y] = (r, g, b, a)
            moved += 1

    # (2) Return misclaimed outline slivers to the creature.
    keep = largest_component(wand.getchannel("A"))
    returned = 0
    for y in range(h):
        for x in range(w):
            if wp[x, y][3] and (x, y) not in keep:
                bp[x, y] = wp[x, y]
                wp[x, y] = (0, 0, 0, 0)
                returned += 1

    wand.save(wand_out)
    body.save(body_out)
    print(
        f"wand {wand.getbbox()} ({len(keep)}px)  creature {body.getbbox()}  "
        f"fringe moved {moved}  slivers returned {returned}"
    )


if __name__ == "__main__":
    main(*sys.argv[1:4])
