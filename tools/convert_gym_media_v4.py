#!/usr/bin/env python3
"""
Fourth pass at exercise media: 4x neural super-resolution (720x720) with ONNX Real-ESRGAN.

Why v4 replaces v3's xBR:
  xBR was built for sharp pixel-art sprites, so on 180x180 shaded anatomical drawings it
  introduced worm-like contour ribbons ("blobby worms") along muscle striations.
  v4 uses Real-ESRGAN 4x ONNX models on CPU:
    - Stills (JPG -> 720x720 WebP q82): RealESRGAN_x4plus_anime_6B (crisp line-art, no worms)
    - Animations (GIF -> 720x720 H.264 MP4 crf 27): realesr-general-x4v3 (fast compact 4x)

Supports matrix sharding (--shard i/N) for fast parallel GitHub Actions builds, and a
--fallback-ffmpeg mode when ONNX Runtime is unavailable.
"""

import argparse
import os
import subprocess
import sys
import tempfile
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SRC = Path(os.environ.get('SRC', '/tmp/exmedia'))
OUT = Path(os.environ.get('OUT', '/tmp/exmedia4'))
MODEL_DIR = Path(os.environ.get('MODEL_DIR', '/tmp/esrgan-models'))
CRF = os.environ.get('CRF', '27')
IMG_Q = int(os.environ.get('IMG_Q', '82'))

MODELS = {
    'anime6b': (
        'realesrgan_anime6b.onnx',
        'https://huggingface.co/RekluzLabs/realesrgan_anime6b.onnx/resolve/main/realesrgan_anime6b.onnx',
    ),
    'x4v3': (
        'realesr-general-x4v3.onnx',
        'https://huggingface.co/Heliosoph/realesrgan-onnx/resolve/main/realesr-general-x4v3.onnx',
    ),
}


def ensure_models():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    paths = {}
    for k, (fname, url) in MODELS.items():
        p = MODEL_DIR / fname
        if not p.exists() or p.stat().st_size < 1_000_000:
            print(f'Downloading {fname}...', flush=True)
            urllib.request.urlretrieve(url, p)
        paths[k] = p
    return paths


_tls = threading.local()


def get_session(model_path: Path, threads: int):
    import onnxruntime as ort
    cache = getattr(_tls, 'sessions', None)
    if cache is None:
        cache = {}
        _tls.sessions = cache
    key = str(model_path)
    if key not in cache:
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        cache[key] = ort.InferenceSession(key, sess_options=so, providers=['CPUExecutionProvider'])
    return cache[key]


def sr_rgb(sess, pil_rgb):
    import numpy as np
    from PIL import Image
    arr = (np.asarray(pil_rgb, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None, ...]
    inp_name = sess.get_inputs()[0].name
    out = sess.run(None, {inp_name: arr})[0][0]
    arr_u8 = (out.transpose(1, 2, 0) * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(arr_u8)


def convert_still_onnx(src: Path, model_path: Path, threads: int):
    from PIL import Image
    dst = OUT / 'img' / (src.stem + '.webp')
    if dst.exists() and dst.stat().st_size > 0:
        return None
    try:
        sess = get_session(model_path, threads)
        im = Image.open(src).convert('RGB')
        up = sr_rgb(sess, im)
        up.save(dst, format='WEBP', quality=IMG_Q, method=4)
        return None
    except Exception as e:
        return f'{src.name}: {e}'


def convert_anim_onnx(src: Path, model_path: Path, threads: int):
    from PIL import Image
    dst = OUT / 'gif' / (src.stem + '.mp4')
    if dst.exists() and dst.stat().st_size > 0:
        return None
    try:
        sess = get_session(model_path, threads)
        gif = Image.open(src)
        with tempfile.TemporaryDirectory() as td:
            tdp = Path(td)
            n = 0
            durations = []
            while True:
                try:
                    gif.seek(n)
                    durations.append(gif.info.get('duration', 150) or 150)
                    fr = gif.convert('RGB')
                    up = sr_rgb(sess, fr)
                    up.save(tdp / f'f_{n:04d}.png')
                    n += 1
                except EOFError:
                    break
            if n == 0:
                return f'{src.name}: 0 frames'
            avg_ms = sum(durations) / len(durations)
            fps = max(1.0, min(30.0, 1000.0 / avg_ms))
            p = subprocess.run([
                'ffmpeg', '-hide_banner', '-loglevel', 'error',
                '-framerate', f'{fps:.3f}', '-i', str(tdp / 'f_%04d.png'),
                '-c:v', 'libx264', '-crf', CRF, '-preset', 'slow',
                '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart', '-an', '-y', str(dst),
            ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            if p.returncode != 0:
                return f'{src.name}: {p.stderr.decode("utf-8", "replace")[-300:]}'
        return None
    except Exception as e:
        return f'{src.name}: {e}'


def convert_still_ffmpeg(src: Path):
    dst = OUT / 'img' / (src.stem + '.webp')
    if dst.exists() and dst.stat().st_size > 0:
        return None
    p = subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(src),
        '-vf', 'hqdn3d=4:4:6:6,smartblur=0.9:-0.25:0,scale=720:720:flags=lanczos+accurate_rnd,cas=0.45',
        '-c:v', 'libwebp', '-q:v', str(IMG_Q), '-compression_level', '4',
        '-frames:v', '1', '-y', str(dst),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return None if p.returncode == 0 else f'{src.name}: {p.stderr.decode("utf-8", "replace")[-300:]}'


def convert_anim_ffmpeg(src: Path):
    dst = OUT / 'gif' / (src.stem + '.mp4')
    if dst.exists() and dst.stat().st_size > 0:
        return None
    p = subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(src),
        '-vf', 'hqdn3d=5:5:8:8,smartblur=0.9:-0.25:0,scale=720:720:flags=lanczos+accurate_rnd,cas=0.45,format=yuv420p',
        '-c:v', 'libx264', '-crf', CRF, '-preset', 'slow',
        '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-an', '-y', str(dst),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return None if p.returncode == 0 else f'{src.name}: {p.stderr.decode("utf-8", "replace")[-300:]}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shard', default='0/1', help='Shard index/total, e.g. 0/4')
    ap.add_argument('--jobs', type=int, default=int(os.environ.get('JOBS', os.cpu_count() or 2)))
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--fallback-ffmpeg', action='store_true')
    args = ap.parse_args()

    shard_idx, shard_total = (int(x) for x in args.shard.split('/'))
    (OUT / 'gif').mkdir(parents=True, exist_ok=True)
    (OUT / 'img').mkdir(parents=True, exist_ok=True)

    gifs = sorted((SRC / 'gif').glob('*.gif'))
    jpgs = sorted((SRC / 'img').glob('*.jpg'))
    if args.limit:
        gifs, jpgs = gifs[:args.limit], jpgs[:args.limit]
    gifs = [p for i, p in enumerate(gifs) if i % shard_total == shard_idx]
    jpgs = [p for i, p in enumerate(jpgs) if i % shard_total == shard_idx]

    use_onnx = not args.fallback_ffmpeg
    if use_onnx:
        try:
            import onnxruntime  # noqa: F401
            import numpy  # noqa: F401
            from PIL import Image  # noqa: F401
            mpaths = ensure_models()
        except Exception as e:
            print(f'ONNX unavailable ({e}); falling back to ffmpeg', file=sys.stderr)
            use_onnx = False

    jobs = max(1, args.jobs)
    threads_per_worker = max(1, (os.cpu_count() or 2) // jobs)
    print(f'mode={"onnx" if use_onnx else "ffmpeg"} shard={shard_idx}/{shard_total} jobs={jobs} '
          f'({len(gifs)} gifs, {len(jpgs)} jpgs)', flush=True)

    fails = []
    if use_onnx:
        tasks = [
            ('animations', gifs, lambda p: convert_anim_onnx(p, mpaths['x4v3'], threads_per_worker)),
            ('stills', jpgs, lambda p: convert_still_onnx(p, mpaths['anime6b'], threads_per_worker)),
        ]
    else:
        tasks = [
            ('animations', gifs, convert_anim_ffmpeg),
            ('stills', jpgs, convert_still_ffmpeg),
        ]

    for label, items, fn in tasks:
        done = 0
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            for err in pool.map(fn, items):
                done += 1
                if err:
                    fails.append(err)
                if done % 50 == 0 or done == len(items):
                    print(f'  {label}: {done}/{len(items)} (fails={len(fails)})', flush=True)

    if fails:
        print(f'\n{len(fails)} FAILURES:', file=sys.stderr)
        for f in fails[:20]:
            print(' ', f, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
