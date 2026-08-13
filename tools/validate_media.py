#!/usr/bin/env python3
"""
Validate a converted media tree before it is copied over the one the app ships.

The serial version of this check (one `ffmpeg -f null -` per file, in bash) was going to
take hours: 1324 full decodes on a 2-core cgroup quota. This does the same work with the
container's real parallelism and stops at the first class of problem rather than after
every file.

Three things are checked, because three different things can go wrong:

  dimensions  ffprobe the coded width/height. The whole point of the re-encode is that the
              phone never upscales, so anything below the CSS paint box is a regression.
  decode      Decode the entire stream, not just the header. A truncated file -- the
              conversion was killed midway, the disk filled -- has a valid moov and plays
              for a fraction of a second. `ffprobe` alone would pass it.
  parity      Every stem present in the source has to be present in the output. A missing
              file is invisible in aggregate stats and shows in the app as one blank card.

Env:
  DIR    tree with gif/ and img/   (default /tmp/exmedia3)
  SRC    source tree to compare against for parity (default /tmp/exmedia)
  MIN    minimum acceptable dimension (default 380, the .exmedia CSS box)
  JOBS   parallel probes (default: cgroup cpu quota * 2 -- these are I/O bound enough
         to oversubscribe slightly)
"""

import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DIR = Path(os.environ.get('DIR', '/tmp/exmedia3'))
SRC = Path(os.environ.get('SRC', '/tmp/exmedia'))
MIN = int(os.environ.get('MIN', '380'))


def cpu_quota():
    try:
        quota, period = Path('/sys/fs/cgroup/cpu.max').read_text().split()
        if quota != 'max':
            return max(1, int(int(quota) // int(period)))
    except Exception:
        pass
    return max(1, (os.cpu_count() or 2) // 2)


JOBS = int(os.environ.get('JOBS') or cpu_quota() * 2)


def probe(f: Path):
    """(width, height) or None if the header is unreadable."""
    p = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=p=0', str(f)],
        capture_output=True,
    )
    out = p.stdout.decode().strip().rstrip(',')
    try:
        w, h = (int(x) for x in out.split(',')[:2])
        return w, h
    except Exception:
        return None


def check(f: Path):
    dims = probe(f)
    if dims is None:
        return f'UNREADABLE {f.name}'
    w, h = dims
    if w < MIN or h < MIN:
        return f'UNDERSIZED {f.name} {w}x{h} < {MIN}'
    # Full decode. -f null discards output; a truncated stream errors here and nowhere else.
    p = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(f), '-f', 'null', '-'],
                       capture_output=True)
    if p.returncode != 0:
        return f'DECODE {f.name}: {p.stderr.decode()[-160:].strip()}'
    return None


def main():
    problems = []
    for sub, pat in (('gif', '*.mp4'), ('img', '*.webp')):
        files = sorted((DIR / sub).glob(pat))
        if not files:
            problems.append(f'EMPTY {DIR / sub}')
            continue
        print(f'{sub}: {len(files)} files, {JOBS} jobs', flush=True)
        done = 0
        with ThreadPoolExecutor(max_workers=JOBS) as pool:
            for err in pool.map(check, files):
                done += 1
                if err:
                    problems.append(err)
                if done % 200 == 0:
                    print(f'  {sub} {done}/{len(files)}  problems={len(problems)}', flush=True)
        print(f'{sub}: done, {len(problems)} problems so far', flush=True)

    # Parity against the source, by stem. Aggregate counts hide a missing file; the app
    # shows it as one exercise with a blank card.
    for sub, src_pat, out_pat in (('gif', '*.gif', '*.mp4'), ('img', '*.jpg', '*.webp')):
        want = {f.stem for f in (SRC / sub).glob(src_pat)}
        have = {f.stem for f in (DIR / sub).glob(out_pat)}
        for stem in sorted(want - have):
            problems.append(f'MISSING {sub}/{stem}')
        extra = have - want
        if extra:
            problems.append(f'EXTRA {sub}: {len(extra)} files not in source, e.g. {sorted(extra)[:3]}')

    def mb(p):
        return sum(f.stat().st_size for f in p.glob('*')) / 1048576

    a, s = mb(DIR / 'gif'), mb(DIR / 'img')
    print(f'\nanimations {a:.1f} MB   stills {s:.1f} MB   total {a + s:.1f} MB')

    if problems:
        print(f'\n{len(problems)} PROBLEMS', file=sys.stderr)
        for p in problems[:30]:
            print(' ', p, file=sys.stderr)
        return 1
    print('all files readable, fully decodable, and >= %dpx' % MIN)
    return 0


if __name__ == '__main__':
    sys.exit(main())
