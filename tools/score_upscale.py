#!/usr/bin/env python3
"""
Score the upscale candidates numerically, because "looks blurry" needs a measurable
proxy before I trust a choice.

There is no high-resolution ground truth to compare against, so the scoring targets the
two failure modes directly:

  stipple  -- residual dither texture inside what should be smooth shading. Measured as
              the mean local standard deviation over interior patches that contain no
              real edge. Lower is better: real graphite shading varies smoothly, dither
              does not.

  edge     -- how crisp the outline strokes are. Measured as the mean gradient magnitude
              restricted to strong-edge pixels. Higher is better; a blurry upscale
              spreads the same ink over more pixels and drops this.

  fidelity -- downscale the candidate back to 180 and compare to the source. Guards
              against a filter that "improves" the image by inventing structure or
              melting detail away. Reported as PSNR against the original frame.

A good candidate has low stipple, high edge, and fidelity high enough to prove it did not
hallucinate. Any one of the three alone is gameable.
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path('/tmp/upscale-bakeoff')
SRC = Path('/tmp/exmedia/gif/0001-2gPfomN.gif')
FRAME = 3


def source_frame():
    dst = Path('/tmp/src-frame.png')
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-i', str(SRC),
        '-vf', f'select=eq(n\\,{FRAME})', '-frames:v', '1', str(dst),
    ], check=True)
    return np.asarray(Image.open(dst).convert('L'), dtype=np.float64)


def grad_mag(a):
    gy = np.zeros_like(a)
    gx = np.zeros_like(a)
    gy[1:-1, :] = (a[2:, :] - a[:-2, :]) * 0.5
    gx[:, 1:-1] = (a[:, 2:] - a[:, :-2]) * 0.5
    return np.hypot(gx, gy)


def stipple_score(a, patch=8):
    """Mean local std-dev over patches that are interior (not edges, not pure paper)."""
    g = grad_mag(a)
    h, w = a.shape
    ph, pw = h // patch, w // patch
    vals = []
    for i in range(patch):
        for j in range(patch):
            blk = a[i * ph:(i + 1) * ph, j * pw:(j + 1) * pw]
            gblk = g[i * ph:(i + 1) * ph, j * pw:(j + 1) * pw]
            if blk.size == 0:
                continue
            # Skip near-white paper (nothing to judge) and strong-edge blocks (real detail).
            if blk.mean() > 246:
                continue
            if np.percentile(gblk, 95) > 40:
                continue
            vals.append(blk.std())
    return float(np.mean(vals)) if vals else float('nan')


def edge_score(a):
    g = grad_mag(a)
    thr = np.percentile(g, 99.0)
    strong = g[g >= thr]
    return float(strong.mean()) if strong.size else 0.0


def psnr_roundtrip(a, src):
    """Downscale candidate back to source size, compare. Catches invented detail."""
    im = Image.fromarray(a.astype(np.uint8))
    small = np.asarray(
        im.resize((src.shape[1], src.shape[0]), Image.LANCZOS), dtype=np.float64
    )
    mse = float(np.mean((small - src) ** 2))
    if mse <= 1e-9:
        return float('inf')
    return 10.0 * float(np.log10(255.0 * 255.0 / mse))


def main():
    src = source_frame()
    files = sorted(p for p in OUT.glob('*.png') if p.stem != 'contact-sheet')
    if not files:
        sys.exit('no candidate PNGs; run upscale_bakeoff.py first')

    rows = []
    for p in files:
        a = np.asarray(Image.open(p).convert('L'), dtype=np.float64)
        rows.append((
            p.stem,
            stipple_score(a),
            edge_score(a),
            psnr_roundtrip(a, src),
            p.stat().st_size / 1024,
        ))

    # Rank: stipple ascending is good, edge descending is good. Combine as a simple
    # ratio so one number orders them, with the raw columns kept visible for sanity.
    print(f'{"candidate":26s} {"stipple":>8s} {"edge":>8s} {"psnr":>7s} {"KB":>7s} {"edge/stip":>10s}')
    print('-' * 72)
    for name, st, ed, ps, kb in rows:
        ratio = ed / st if st and st == st else float('nan')
        print(f'{name:26s} {st:8.2f} {ed:8.1f} {ps:7.2f} {kb:7.1f} {ratio:10.2f}')

    print()
    best = max((r for r in rows if r[0] != '00-source-nearest'),
               key=lambda r: (r[2] / r[1]) if r[1] else 0)
    print('highest edge/stipple:', best[0])


if __name__ == '__main__':
    main()
