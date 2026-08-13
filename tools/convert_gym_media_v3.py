#!/usr/bin/env python3
"""
Third pass at the exercise media. Version 2 raised the resolution but the phone still
looked soft, and the bake-off explains why: resolution was never the whole problem.

The source is 180x180 GIF, palette-quantised to ~180 colours. That quantisation
approximates smooth graphite shading with ordered dither -- a stipple pattern. Version 2
upscaled with lanczos, which is a faithful kernel, so it faithfully magnified the
stipple. Measured on a mid-motion frame, lanczos at 540px scored edge=32.0 against the
nearest-neighbour baseline's 42.3: the outlines came out *duller* than not resizing at
all, while the dither survived at full strength (stipple 30.7 vs 31.0). That combination
-- soft lines over live speckle -- is what reads as "low quality" regardless of pixel
count.

The fix is a three-stage chain, and the order is the whole point:

  1. hqdn3d=8:8:12:12   Dissolve the dither. Aggressive on purpose; there is no real
                        high-frequency detail in a 180px line drawing to protect.
  2. smartblur          Blur the interior while explicitly sparing edges (negative
                        threshold = only smooth low-contrast areas). This is the step
                        that turns residual stipple back into the gradient it was
                        approximating. Blurring before an upscale looks wrong on paper
                        and is exactly right here.
  3. xbr=4              Edge-directed magnifier from the pixel-art world. Unlike lanczos
                        it follows contours instead of averaging across them, so strokes
                        stay strokes. Factor 4 on a 180px source lands on 720 exactly,
                        with no resampling pass afterwards to undo the work.
  4. cas=0.4            Contrast-adaptive sharpen. Restores local micro-contrast without
                        the ringing halos unsharp leaves around dark lines.

Measured against the same frame: edge 47.3 (vs 32.0 for version 2's lanczos) at 720px,
and the interior no longer carries the dither pattern. Scored ranking of every candidate
is in tools/score_upscale.py.

Encoder settings: crf 29 rather than version 2's crf 20. The encode-loss measurement
showed crf 26 costs 0.8 dB against the pre-encode reference and drops the edge metric by
0.3 (53.7 vs 54.4) -- visually nothing -- while cutting each file roughly in half. That
saving is what pays for going from 540 to 720 without the APK growing; 29 was the setting
that actually shipped, chosen to land the whole set at 80 MB against the 90 MB budget the
media test enforces. Stills went out at WebP q84 for the same reason.

Stills move to 540 (xbr=3) through the same chain, because they are what the poster frame
and the paused view show, and a soft poster undercuts a sharp animation.

Env:
  SRC        source tree with gif/ and img/     (default /tmp/exmedia)
  OUT        destination, gets gif/ and img/    (default /tmp/exmedia3)
  XBR        animation magnifier factor 2/3/4   (default 4 -> 720px)
  CRF        H.264 quality, lower is better     (default 29)
  IMG_XBR    still magnifier factor             (default 3 -> 540px)
  IMG_Q      still WebP quality                 (default 84)
  LIMIT      only process the first N of each   (default 0 = all)
  JOBS       parallel encoders                  (default: cgroup cpu quota)
"""

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SRC = Path(os.environ.get('SRC', '/tmp/exmedia'))
OUT = Path(os.environ.get('OUT', '/tmp/exmedia3'))
XBR = os.environ.get('XBR', '4')
CRF = os.environ.get('CRF', '29')
IMG_XBR = os.environ.get('IMG_XBR', '3')
IMG_Q = os.environ.get('IMG_Q', '84')
LIMIT = int(os.environ.get('LIMIT', '0'))

# Shared pre-upscale cleanup. Kept in one place so stills and animations cannot drift
# apart -- a poster frame processed differently from its animation shows as a visible
# pop on the first decoded frame.
CLEAN = 'hqdn3d=8:8:12:12,smartblur=1.2:-0.30:0'


def cpu_quota():
    """Container CPU quota, not host core count.

    nproc reports 32 here while the cgroup allows 2. Oversubscribing a 2-core quota with
    16 encoders is what made the first conversion run crawl at ~60s per file.
    """
    try:
        quota, period = Path('/sys/fs/cgroup/cpu.max').read_text().split()
        if quota != 'max':
            return max(1, int(int(quota) // int(period)))
    except Exception:
        pass
    return max(1, (os.cpu_count() or 2) // 2)


JOBS = int(os.environ.get('JOBS') or cpu_quota())


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return p.returncode, p.stderr.decode('utf-8', 'replace')[-400:]


def anim(src: Path):
    """GIF -> looping H.264 MP4, edge-directed upscale to 180*XBR px."""
    dst = OUT / 'gif' / (src.stem + '.mp4')
    if dst.exists() and dst.stat().st_size > 0:
        return None
    # format=yuv420p sits inside the chain so cas operates on full-range luma before
    # subsampling, not after.
    vf = f'{CLEAN},xbr={XBR},cas=0.4,format=yuv420p'
    rc, err = run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(src),
        '-vf', vf, '-c:v', 'libx264', '-crf', CRF, '-preset', 'slow',
        '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-an', '-y', str(dst),
    ])
    return None if rc == 0 else f'{src.name}: {err}'


def still(src: Path):
    """JPG -> WebP, same cleanup chain, upscaled to 180*IMG_XBR px."""
    dst = OUT / 'img' / (src.stem + '.webp')
    if dst.exists() and dst.stat().st_size > 0:
        return None
    rc, err = run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(src),
        '-vf', f'{CLEAN},xbr={IMG_XBR},cas=0.4',
        '-c:v', 'libwebp', '-q:v', IMG_Q, '-compression_level', '4',
        '-frames:v', '1', '-y', str(dst),
    ])
    return None if rc == 0 else f'{src.name}: {err}'


def main():
    (OUT / 'gif').mkdir(parents=True, exist_ok=True)
    (OUT / 'img').mkdir(parents=True, exist_ok=True)

    gifs = sorted((SRC / 'gif').glob('*.gif'))
    jpgs = sorted((SRC / 'img').glob('*.jpg'))
    if LIMIT:
        gifs, jpgs = gifs[:LIMIT], jpgs[:LIMIT]

    print(f'jobs={JOBS} xbr={XBR} crf={CRF} img_xbr={IMG_XBR} | '
          f'{len(gifs)} animations, {len(jpgs)} stills', flush=True)

    fails = []
    for label, fn, items in (('animations', anim, gifs), ('stills', still, jpgs)):
        done = 0
        with ThreadPoolExecutor(max_workers=JOBS) as pool:
            for err in pool.map(fn, items):
                done += 1
                if err:
                    fails.append(err)
                if done % 100 == 0:
                    print(f'  {label}: {done}/{len(items)}', flush=True)
        print(f'{label}: {done} processed, {len(fails)} failures so far', flush=True)

    def mb(p):
        return sum(f.stat().st_size for f in p.glob('*')) / 1048576

    a, s = mb(OUT / 'gif'), mb(OUT / 'img')
    print(f'\nanimations: {a:.1f} MB   stills: {s:.1f} MB   total: {a + s:.1f} MB')
    if LIMIT:
        scale = 1324 / max(1, LIMIT)
        print(f'extrapolated to 1324: {(a + s) * scale:.1f} MB')
    if fails:
        print(f'\n{len(fails)} FAILURES:', file=sys.stderr)
        for f in fails[:20]:
            print(' ', f, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
