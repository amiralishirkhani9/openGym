#!/usr/bin/env python3
"""
convert_gym_media.py -- turn the downloaded exercise media into a packaged,
sharper, smaller offline set.

Two problems with how 1.4.x shipped the media, both fixed here:

*Offline.* The animations were fetched from a pinned jsDelivr mirror at runtime,
so with no connection every exercise was a broken image -- in an app whose whole
job is showing you how the movement goes. The converted set is small enough to
sit inside the APK.

*Sharpness.* Upstream is 180x180 and the app renders it at 320-380 CSS px, so
the phone was upscaling ~2x with a bilinear filter. Upscaling once here with
lanczos, at encode time, gives a visibly cleaner edge than asking the GPU to do
it every frame -- and because WebP is a far better codec than GIF for this
content, the 2x result is still *smaller* than the 180px GIF it replaces.

Measured on the real set (see the table printed at the end of a run): GIF at
180px averages ~93 KB/exercise (118 MB total, unshippable). WebP at 2x/q=62
averages ~51 KB (64 MB) and 1.5x/q=70 averages ~42 KB (53 MB). The default is
1.5x, which keeps the whole APK near 60 MB while still handing the renderer more
pixels than it had before; SCALE=2.0 is there for a bigger build.

Requires ffmpeg with libwebp_anim (Debian's ffmpeg has it).

Usage:
    python3 convert_gym_media.py            # /tmp/exmedia -> /tmp/exmedia/webp
    SCALE=2.0 QUALITY=62 python3 convert_gym_media.py
"""

import os
import pathlib
import shutil
import subprocess
import sys
from concurrent.futures import ProcessPoolExecutor

SRC = pathlib.Path(os.environ.get('SRC', '/tmp/exmedia'))
OUT = pathlib.Path(os.environ.get('OUT', '/tmp/exmedia/webp'))
SCALE = os.environ.get('SCALE', '1.5')
QUALITY = os.environ.get('QUALITY', '72')
# Thumbnails are static and already tiny; a light upscale plus WebP still halves
# them. They appear in scrolling lists, so decode cost matters more than size.
THUMB_SCALE = os.environ.get('THUMB_SCALE', '2.0')
THUMB_QUALITY = os.environ.get('THUMB_QUALITY', '80')
# libwebp's compression_level 6 buys ~5% size for 6x the encode time (4.4s vs
# 0.73s per animation, measured). Across 1324 files that is 45 extra minutes to
# save 2 MB, so the default is 4 with quality nudged up to compensate.
COMPRESSION = os.environ.get('COMPRESSION', '4')


def cpu_budget():
    """Usable cores, from the cgroup quota rather than the visible core count.

    This box reports 32 cores but is capped at 2 by cpu.max; running 16 encoders
    against that turned a 0.7s job into a 60s one. Overcommitting a CPU-bound
    encoder gains nothing even without a cap, so the default is the quota.
    """
    try:
        quota, period = pathlib.Path('/sys/fs/cgroup/cpu.max').read_text().split()
        if quota != 'max':
            return max(1, int(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    return max(1, os.cpu_count() or 2)


JOBS = int(os.environ.get('JOBS', str(cpu_budget())))


def ffmpeg(args):
    return subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', *args],
                          capture_output=True, text=True)


def convert_anim(src_dst):
    src, dst = src_dst
    if dst.exists() and dst.stat().st_size > 512:
        return dst.stat().st_size
    r = ffmpeg([
        '-i', str(src),
        '-vf', f'scale=iw*{SCALE}:ih*{SCALE}:flags=lanczos',
        '-c:v', 'libwebp_anim',
        '-q:v', QUALITY,
        '-compression_level', COMPRESSION,
        '-loop', '0',
        '-y', str(dst),
    ])
    if r.returncode != 0 or not dst.exists():
        return f'FAIL {src.name}: {r.stderr.strip()[:120]}'
    return dst.stat().st_size


def convert_still(src_dst):
    src, dst = src_dst
    if dst.exists() and dst.stat().st_size > 256:
        return dst.stat().st_size
    r = ffmpeg([
        '-i', str(src),
        '-vf', f'scale=iw*{THUMB_SCALE}:ih*{THUMB_SCALE}:flags=lanczos',
        '-c:v', 'libwebp', '-q:v', THUMB_QUALITY, '-compression_level', COMPRESSION,
        '-y', str(dst),
    ])
    if r.returncode != 0 or not dst.exists():
        return f'FAIL {src.name}: {r.stderr.strip()[:120]}'
    return dst.stat().st_size


def run(kind, srcdir, outdir, fn, ext):
    files = sorted(srcdir.glob('*'))
    if not files:
        sys.exit(f'no source files in {srcdir}')
    outdir.mkdir(parents=True, exist_ok=True)
    pairs = [(f, outdir / (f.stem + ext)) for f in files]
    sizes, fails = [], []
    with ProcessPoolExecutor(max_workers=JOBS) as ex:
        for i, res in enumerate(ex.map(fn, pairs), 1):
            if isinstance(res, str):
                fails.append(res)
            else:
                sizes.append(res)
            if i % 200 == 0:
                print(f'  {kind}: {i}/{len(pairs)}', flush=True)
    src_total = sum(f.stat().st_size for f in files)
    out_total = sum(sizes)
    print(f'{kind}: {len(sizes)} converted, {len(fails)} failed')
    print(f'  source {src_total / 1048576:.1f} MB  ->  webp {out_total / 1048576:.1f} MB'
          f'  ({out_total * 100 // max(src_total, 1)}%)')
    if sizes:
        print(f'  avg {out_total // len(sizes)} B/file')
    for f in fails[:10]:
        print(f'  {f}')
    return out_total, fails


def main():
    if not shutil.which('ffmpeg'):
        sys.exit('ffmpeg not found')
    if 'libwebp_anim' not in subprocess.run(
            ['ffmpeg', '-hide_banner', '-encoders'], capture_output=True, text=True).stdout:
        sys.exit('this ffmpeg has no libwebp_anim encoder')

    print(f'anim scale={SCALE} q={QUALITY}   thumb scale={THUMB_SCALE} q={THUMB_QUALITY}'
          f'   cl={COMPRESSION}   jobs={JOBS}')
    total = 0
    all_fails = []
    for kind, sub, fn in (('animations', 'gif', convert_anim), ('thumbnails', 'img', convert_still)):
        srcdir = SRC / sub
        if not srcdir.is_dir():
            print(f'skip {kind}: {srcdir} missing')
            continue
        t, fails = run(kind, srcdir, OUT / sub, fn, '.webp')
        total += t
        all_fails += fails

    print()
    print(f'packaged media total: {total / 1048576:.1f} MB')
    if all_fails:
        sys.exit(f'{len(all_fails)} conversions failed')


if __name__ == '__main__':
    main()
