#!/usr/bin/env python3
"""
Generate 720x720 animated H.264 MP4s and WebP stills for the 24 bundled
Pilates / flat resistance-band exercises (IDs 9001-9024).

Usage:
  python3 tools/generate_pilates_media.py --out frontend/public
"""

import argparse
import math
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image, ImageDraw

S = 1440  # 2x supersampled canvas -> 720x720 LANCZOS output
OUT_SIZE = 720

BG = (255, 255, 255)
FLOOR = (224, 228, 236)
MAT = (232, 241, 250)
MAT_EDGE = (188, 204, 222)
BODY = (194, 199, 208)
BODY_SHADOW = (164, 170, 180)
OUTLINE = (50, 56, 66)
TARGET = (224, 108, 98)
TARGET_EDGE = (162, 62, 56)
BAND_FILL = (20, 170, 128)
BAND_EDGE = (12, 114, 86)
BAND_HIGHLIGHT = (82, 208, 168)
ARROW_COL = (48, 130, 210)


def lerp(a, b, t):
    return a + (b - a) * t


def ease(t):
    return 0.5 - 0.5 * math.cos(math.pi * t)


def interp_pose(p0, p1, t):
    return {k: (lerp(p0[k][0], p1[k][0], t), lerp(p0[k][1], p1[k][1], t)) for k in p0}


def cap(draw, a, b, r1, r2=None, fill=BODY, outline=OUTLINE, w=5):
    if r2 is None:
        r2 = r1
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    d = math.hypot(dx, dy)
    if d < 1e-3:
        draw.ellipse([ax - r1, ay - r1, ax + r1, ay + r1], fill=fill, outline=outline, width=w)
        return
    nx, ny = -dy / d, dx / d
    pts = [
        (ax + nx * r1, ay + ny * r1),
        (bx + nx * r2, by + ny * r2),
        (bx - nx * r2, by - ny * r2),
        (ax - nx * r1, ay - ny * r1),
    ]
    draw.ellipse([ax - r1, ay - r1, ax + r1, ay + r1], fill=fill, outline=outline, width=w)
    draw.ellipse([bx - r2, by - r2, bx + r2, by + r2], fill=fill, outline=outline, width=w)
    draw.polygon(pts, fill=fill)
    draw.line([pts[0], pts[1]], fill=outline, width=w)
    draw.line([pts[2], pts[3]], fill=outline, width=w)


def hand_grip(draw, pt, r=20.0):
    x, y = pt
    draw.ellipse([x - r, y - r, x + r, y + r], fill=BODY_SHADOW, outline=OUTLINE, width=5)


def head_draw(draw, neck, head, r=58.0, face_dir=0, back=False):
    cap(draw, neck, head, 24, 22, fill=BODY)
    hx, hy = head
    draw.ellipse([hx - r, hy - r, hx + r, hy + r], fill=OUTLINE if back else BODY, outline=OUTLINE, width=5)
    if back:
        draw.arc([hx - r + 10, hy - r + 10, hx + r - 10, hy + r - 10], 30, 150, fill=BODY_SHADOW, width=6)
    elif face_dir == 0:
        draw.arc([hx - r + 4, hy - r + 4, hx + r - 4, hy + r - 4], 195, 345, fill=OUTLINE, width=16)
    elif face_dir > 0:
        draw.arc([hx - r + 4, hy - r + 4, hx + r - 4, hy + r - 4], 165, 310, fill=OUTLINE, width=16)
    else:
        draw.arc([hx - r + 4, hy - r + 4, hx + r - 4, hy + r - 4], 230, 375, fill=OUTLINE, width=16)


def draw_band_ribbon(draw, pts, looped=False):
    if len(pts) < 2:
        return
    seq = list(pts) + ([pts[0]] if looped else [])
    draw.line(seq, fill=BAND_EDGE, width=26, joint='curve')
    draw.line(seq, fill=BAND_FILL, width=16, joint='curve')
    draw.line(seq, fill=BAND_HIGHLIGHT, width=5, joint='curve')


def draw_arrow(draw, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    d = math.hypot(dx, dy)
    if d < 10:
        return
    ux, uy = dx / d, dy / d
    nx, ny = -uy, ux
    draw.line([(ax, ay), (bx, by)], fill=ARROW_COL, width=10)
    tip = (bx, by)
    p1 = (bx - ux * 28 + nx * 16, by - uy * 28 + ny * 16)
    p2 = (bx - ux * 28 - nx * 16, by - uy * 28 - ny * 16)
    draw.polygon([tip, p1, p2], fill=ARROW_COL)


def render_frame(pose, spec, show_arrows=False):
    im = Image.new('RGB', (S, S), BG)
    draw = ImageDraw.Draw(im)

    # Auto-frame pose+floor nicely in the 1440x1440 canvas so floor/mat exercises fill the card
    all_pts = list(spec['p0'].values()) + list(spec['p1'].values())
    min_x = min(p[0] for p in all_pts)
    max_x = max(p[0] for p in all_pts)
    min_y = min(p[1] for p in all_pts)
    max_y = max(spec.get('floor', 1240), max(p[1] for p in all_pts))
    bw = max(1, max_x - min_x)
    bh = max(1, max_y - min_y)
    scale = min(1040.0 / bw, 1040.0 / bh, 1.45)
    cx_src = (min_x + max_x) / 2.0
    cy_src = (min_y + max_y) / 2.0
    tx = lambda pt: (S / 2.0 + (pt[0] - cx_src) * scale, S / 2.0 + (pt[1] - cy_src) * scale)
    raw_pose = pose
    pose = {k: tx(v) for k, v in raw_pose.items()}
    fy = S / 2.0 + (spec.get('floor', 1240) - cy_src) * scale
    r_sc = min(1.22, max(0.85, scale))

    draw.line([(90, fy), (1350, fy)], fill=FLOOR, width=8)
    if spec.get('mat'):
        draw.rounded_rectangle([150, fy - 24 * r_sc, 1290, fy + 10], radius=14, fill=MAT, outline=MAT_EDGE, width=4)

    hl = set(spec.get('hl', []))
    c = lambda part: TARGET if part in hl else BODY
    o = lambda part: TARGET_EDGE if part in hl else OUTLINE
    view = spec.get('view', 'front')  # 'front' | 'back' | 'side'

    # Evaluate band on raw_pose, then transform once so custom midpoints never double-scale
    band_pts = [pose[k] if isinstance(k, str) else tx(k) for k in spec['band'](raw_pose)]
    if spec.get('band_behind'):
        draw_band_ribbon(draw, band_pts, looped=spec.get('looped', False))

    if view in ('front', 'back'):
        for side in ('r', 'l'):
            cap(draw, pose[f'{side}_hip'], pose[f'{side}_knee'], 46 * r_sc, 33 * r_sc, fill=c('quads'), outline=o('quads'))
            cap(draw, pose[f'{side}_knee'], pose[f'{side}_ankle'], 31 * r_sc, 21 * r_sc, fill=c('calves'), outline=o('calves'))
            cap(draw, pose[f'{side}_ankle'], pose[f'{side}_foot'], 20 * r_sc, 17 * r_sc, fill=BODY_SHADOW)

        cap(draw, pose['pelvis'], pose['mid'], 58 * r_sc, 52 * r_sc, fill=c('core'), outline=o('core'))
        cap(draw, pose['mid'], pose['chest'], 54 * r_sc, 72 * r_sc, fill=c('torso'), outline=o('torso'))
        cap(draw, pose['l_sh'], pose['r_sh'], 34 * r_sc, 34 * r_sc, fill=c('shoulders'), outline=o('shoulders'))

        if view == 'back' and 'torso' in hl:
            mx, my = (pose['mid'][0] + pose['chest'][0]) / 2, (pose['mid'][1] + pose['chest'][1]) / 2
            draw.ellipse([mx - 58 * r_sc, my - 56 * r_sc, mx + 58 * r_sc, my + 56 * r_sc], fill=TARGET, outline=TARGET_EDGE, width=4)

        head_draw(draw, pose['chest'], pose['head'], r=58 * r_sc, face_dir=0, back=(view == 'back'))

        for side in ('r', 'l'):
            cap(draw, pose[f'{side}_sh'], pose[f'{side}_elb'], 34 * r_sc, 26 * r_sc, fill=c('arms'), outline=o('arms'))
            cap(draw, pose[f'{side}_elb'], pose[f'{side}_hand'], 25 * r_sc, 19 * r_sc, fill=c('forearms'), outline=o('forearms'))

        if not spec.get('band_behind'):
            draw_band_ribbon(draw, band_pts, looped=spec.get('looped', False))

        hand_grip(draw, pose['r_hand'], r=20 * r_sc)
        hand_grip(draw, pose['l_hand'], r=20 * r_sc)

    else:  # side view
        if 'r_hip' in pose:
            cap(draw, pose['r_hip'], pose['r_knee'], 44 * r_sc, 32 * r_sc, fill=BODY_SHADOW, outline=OUTLINE)
            cap(draw, pose['r_knee'], pose['r_ankle'], 30 * r_sc, 20 * r_sc, fill=BODY_SHADOW, outline=OUTLINE)
            cap(draw, pose['r_ankle'], pose['r_foot'], 19 * r_sc, 15 * r_sc, fill=BODY_SHADOW, outline=OUTLINE)
        if 'r_sh' in pose:
            cap(draw, pose['r_sh'], pose['r_elb'], 30 * r_sc, 24 * r_sc, fill=BODY_SHADOW, outline=OUTLINE)
            cap(draw, pose['r_elb'], pose['r_hand'], 23 * r_sc, 18 * r_sc, fill=BODY_SHADOW, outline=OUTLINE)

        cap(draw, pose['pelvis'], pose['mid'], 54 * r_sc, 48 * r_sc, fill=c('core'), outline=o('core'))
        cap(draw, pose['mid'], pose['chest'], 50 * r_sc, 62 * r_sc, fill=c('torso'), outline=o('torso'))
        if 'glutes' in hl:
            gx, gy = pose['pelvis']
            draw.ellipse([gx - 50 * r_sc, gy - 44 * r_sc, gx + 50 * r_sc, gy + 44 * r_sc], fill=TARGET, outline=TARGET_EDGE, width=4)

        head_draw(draw, pose['chest'], pose['head'], r=58 * r_sc, face_dir=spec.get('face_dir', 1))

        cap(draw, pose['l_hip'], pose['l_knee'], 46 * r_sc, 34 * r_sc, fill=c('quads'), outline=o('quads'))
        cap(draw, pose['l_knee'], pose['l_ankle'], 32 * r_sc, 22 * r_sc, fill=c('calves'), outline=o('calves'))
        cap(draw, pose['l_ankle'], pose['l_foot'], 20 * r_sc, 16 * r_sc, fill=BODY_SHADOW, outline=OUTLINE)

        if not spec.get('band_behind'):
            draw_band_ribbon(draw, band_pts, looped=spec.get('looped', False))

        cap(draw, pose['l_sh'], pose['l_elb'], 33 * r_sc, 25 * r_sc, fill=c('arms'), outline=o('arms'))
        cap(draw, pose['l_elb'], pose['l_hand'], 24 * r_sc, 18 * r_sc, fill=c('forearms'), outline=o('forearms'))
        hand_grip(draw, pose['l_hand'], r=20 * r_sc)
        if 'r_hand' in pose:
            hand_grip(draw, pose['r_hand'], r=16 * r_sc)

    if show_arrows:
        for a, b in spec.get('arrows', []):
            draw_arrow(draw, tx(a), tx(b))

    return im.resize((OUT_SIZE, OUT_SIZE), Image.Resampling.LANCZOS)


# Helper standing/lying/seated base builders
def stand_base(cx=720, y_shift=0):
    return {
        'head': (cx, 250 + y_shift), 'chest': (cx, 390 + y_shift),
        'mid': (cx, 560 + y_shift), 'pelvis': (cx, 720 + y_shift),
        'l_sh': (cx - 108, 405 + y_shift), 'r_sh': (cx + 108, 405 + y_shift),
        'l_elb': (cx - 120, 560 + y_shift), 'r_elb': (cx + 120, 560 + y_shift),
        'l_hand': (cx - 120, 700 + y_shift), 'r_hand': (cx + 120, 700 + y_shift),
        'l_hip': (cx - 60, 745 + y_shift), 'r_hip': (cx + 60, 745 + y_shift),
        'l_knee': (cx - 65, 980 + y_shift), 'r_knee': (cx + 65, 980 + y_shift),
        'l_ankle': (cx - 70, 1200 + y_shift), 'r_ankle': (cx + 70, 1200 + y_shift),
        'l_foot': (cx - 105, 1235 + y_shift), 'r_foot': (cx + 105, 1235 + y_shift),
    }


def make_specs():
    specs = {}

    # 9001: pilates band pull-apart (back view showing rear delts & upper back!)
    p0 = stand_base()
    p0.update({'l_elb': (655, 430), 'r_elb': (785, 430), 'l_hand': (675, 430), 'r_hand': (765, 430)})
    p1 = stand_base()
    p1.update({'l_elb': (445, 420), 'r_elb': (995, 420), 'l_hand': (235, 420), 'r_hand': (1205, 420)})
    specs['9001-pb-pull-apart'] = {
        'view': 'back', 'hl': ['shoulders', 'torso'], 'floor': 1255,
        'band': lambda p: ['l_hand', 'r_hand'],
        'p0': p0, 'p1': p1,
        'arrows': [((560, 355), (310, 355)), ((880, 355), (1130, 355))],
    }

    # 9002: pilates band face pull (side view, band anchored under foot or extended forward)
    s0 = {
        'head': (840, 290), 'chest': (830, 420), 'mid': (830, 590), 'pelvis': (830, 740),
        'l_sh': (825, 435), 'r_sh': (815, 435),
        'l_elb': (610, 440), 'r_elb': (610, 425),
        'l_hand': (410, 440), 'r_hand': (410, 425),
        'l_hip': (830, 755), 'r_hip': (830, 755),
        'l_knee': (760, 990), 'r_knee': (875, 990),
        'l_ankle': (730, 1205), 'r_ankle': (885, 1205),
        'l_foot': (675, 1235), 'r_foot': (835, 1235),
    }
    s1 = dict(s0)
    s1.update({'l_elb': (900, 410), 'r_elb': (895, 395), 'l_hand': (745, 325), 'r_hand': (745, 315)})
    specs['9002-pb-face-pull'] = {
        'view': 'side', 'face_dir': -1, 'hl': ['shoulders', 'arms'], 'floor': 1255,
        'band': lambda p: [(230, 430), 'l_hand'],
        'p0': s0, 'p1': s1,
        'arrows': [((480, 345), (690, 315))],
    }

    # 9003: pilates band overhead lat pulldown (front/back view)
    p0 = stand_base()
    p0.update({'l_elb': (570, 270), 'r_elb': (870, 270), 'l_hand': (545, 145), 'r_hand': (895, 145)})
    p1 = stand_base()
    p1.update({'l_elb': (450, 465), 'r_elb': (990, 465), 'l_hand': (365, 395), 'r_hand': (1075, 395)})
    specs['9003-pb-lat-pulldown'] = {
        'view': 'back', 'hl': ['torso', 'shoulders'], 'floor': 1255,
        'band': lambda p: ['l_hand', 'r_hand'],
        'p0': p0, 'p1': p1,
        'arrows': [((490, 180), (385, 355)), ((950, 180), (1055, 355))],
    }

    # 9004: pilates band seated row (side view, band looped around feet!)
    sr0 = {
        'head': (420, 695), 'chest': (430, 825), 'mid': (430, 965), 'pelvis': (430, 1115),
        'l_sh': (435, 840), 'r_sh': (445, 840),
        'l_elb': (655, 865), 'r_elb': (655, 855),
        'l_hand': (860, 895), 'r_hand': (860, 885),
        'l_hip': (450, 1135), 'r_hip': (450, 1135),
        'l_knee': (760, 1150), 'r_knee': (760, 1135),
        'l_ankle': (1080, 1165), 'r_ankle': (1080, 1150),
        'l_foot': (1120, 1085), 'r_foot': (1120, 1070),
    }
    sr1 = dict(sr0)
    sr1.update({'l_elb': (280, 965), 'r_elb': (285, 955), 'l_hand': (460, 985), 'r_hand': (460, 975)})
    specs['9004-pb-seated-row'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['torso', 'arms'], 'floor': 1210, 'mat': True,
        'band': lambda p: ['l_hand', 'l_foot'],
        'p0': sr0, 'p1': sr1,
        'arrows': [((770, 840), (490, 905))],
    }

    # 9005: pilates band archer row (bow-and-arrow pull, front view)
    p0 = stand_base()
    p0.update({'l_elb': (420, 420), 'r_elb': (515, 425), 'l_hand': (270, 420), 'r_hand': (360, 425)})
    p1 = stand_base()
    p1.update({'l_elb': (420, 420), 'r_elb': (960, 415), 'l_hand': (270, 420), 'r_hand': (760, 415)})
    specs['9005-pb-archer-row'] = {
        'view': 'back', 'hl': ['torso', 'shoulders'], 'floor': 1255,
        'band': lambda p: ['l_hand', 'r_hand'],
        'p0': p0, 'p1': p1,
        'arrows': [((430, 355), (750, 355))],
    }

    # 9006: pilates band chest fly (band behind upper back, front view)
    p0 = stand_base()
    p0.update({'l_elb': (440, 430), 'r_elb': (1000, 430), 'l_hand': (285, 435), 'r_hand': (1155, 435)})
    p1 = stand_base()
    p1.update({'l_elb': (590, 455), 'r_elb': (850, 455), 'l_hand': (685, 445), 'r_hand': (755, 445)})
    specs['9006-pb-chest-fly'] = {
        'view': 'front', 'hl': ['torso'], 'floor': 1255, 'band_behind': True,
        'band': lambda p: ['l_hand', 'l_sh', 'r_sh', 'r_hand'],
        'p0': p0, 'p1': p1,
        'arrows': [((340, 370), (630, 370)), ((1100, 370), (810, 370))],
    }

    # 9007: pilates band push-up (band across upper back, side view)
    pu0 = {
        'head': (1110, 990), 'chest': (975, 1020), 'mid': (805, 1060), 'pelvis': (635, 1105),
        'l_sh': (960, 1030), 'r_sh': (955, 1030),
        'l_elb': (880, 1140), 'r_elb': (880, 1140),
        'l_hand': (970, 1205), 'r_hand': (970, 1205),
        'l_hip': (620, 1110), 'r_hip': (620, 1110),
        'l_knee': (445, 1150), 'r_knee': (445, 1150),
        'l_ankle': (270, 1190), 'r_ankle': (270, 1190),
        'l_foot': (255, 1210), 'r_foot': (255, 1210),
    }
    pu1 = dict(pu0)
    pu1.update({
        'head': (1110, 770), 'chest': (975, 825), 'mid': (805, 925), 'pelvis': (635, 1020),
        'l_sh': (970, 845), 'r_sh': (970, 845),
        'l_elb': (970, 1025), 'r_elb': (970, 1025),
        'l_hip': (620, 1025), 'r_hip': (620, 1025),
        'l_knee': (445, 1105), 'r_knee': (445, 1105),
    })
    specs['9007-pb-push-up'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['torso', 'arms'], 'floor': 1225, 'mat': True,
        'band': lambda p: ['l_hand', 'l_sh'],
        'p0': pu0, 'p1': pu1,
        'arrows': [((980, 965), (980, 745))],
    }

    # 9008: pilates band overhead triceps extension
    p0 = stand_base()
    p0.update({'l_elb': (655, 290), 'r_elb': (785, 290), 'l_hand': (685, 420), 'r_hand': (720, 690)})
    p1 = stand_base()
    p1.update({'l_elb': (665, 260), 'r_elb': (775, 260), 'l_hand': (700, 145), 'r_hand': (720, 690)})
    specs['9008-pb-overhead-triceps'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['arms'], 'floor': 1255,
        'band': lambda p: ['l_foot', 'l_hand'],
        'p0': {
            'head': (720, 260), 'chest': (715, 395), 'mid': (715, 570), 'pelvis': (715, 730),
            'l_sh': (715, 415), 'r_sh': (715, 415),
            'l_elb': (715, 235), 'r_elb': (715, 235),
            'l_hand': (640, 380), 'r_hand': (640, 380),
            'l_hip': (715, 745), 'r_hip': (715, 745),
            'l_knee': (720, 980), 'r_knee': (720, 980),
            'l_ankle': (715, 1200), 'r_ankle': (715, 1200),
            'l_foot': (765, 1235), 'r_foot': (765, 1235),
        },
        'p1': {
            'head': (720, 260), 'chest': (715, 395), 'mid': (715, 570), 'pelvis': (715, 730),
            'l_sh': (715, 415), 'r_sh': (715, 415),
            'l_elb': (720, 235), 'r_elb': (720, 235),
            'l_hand': (725, 110), 'r_hand': (725, 110),
            'l_hip': (715, 745), 'r_hip': (715, 745),
            'l_knee': (720, 980), 'r_knee': (720, 980),
            'l_ankle': (715, 1200), 'r_ankle': (715, 1200),
            'l_foot': (765, 1235), 'r_foot': (765, 1235),
        },
        'arrows': [((625, 340), (695, 140))],
    }

    # 9009: pilates band triceps kickback (side view, hinged torso, band under front foot)
    kb0 = {
        'head': (940, 420), 'chest': (820, 495), 'mid': (670, 585), 'pelvis': (530, 680),
        'l_sh': (805, 510), 'r_sh': (805, 510),
        'l_elb': (660, 585), 'r_elb': (660, 585),
        'l_hand': (790, 720), 'r_hand': (790, 720),
        'l_hip': (530, 700), 'r_hip': (530, 700),
        'l_knee': (620, 955), 'r_knee': (585, 955),
        'l_ankle': (620, 1200), 'r_ankle': (565, 1200),
        'l_foot': (680, 1235), 'r_foot': (625, 1235),
    }
    kb1 = dict(kb0)
    kb1.update({'l_hand': (475, 550), 'r_hand': (475, 550)})
    specs['9009-pb-triceps-kickback'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['arms'], 'floor': 1255,
        'band': lambda p: ['l_foot', 'l_hand'],
        'p0': kb0, 'p1': kb1,
        'arrows': [((730, 730), (495, 600))],
    }

    # 9010: pilates band hammer curl (front view, band under both feet)
    p0 = stand_base()
    p0.update({'l_elb': (585, 560), 'r_elb': (855, 560), 'l_hand': (575, 720), 'r_hand': (865, 720)})
    p1 = stand_base()
    p1.update({'l_elb': (585, 560), 'r_elb': (855, 560), 'l_hand': (595, 425), 'r_hand': (845, 425)})
    specs['9010-pb-hammer-curl'] = {
        'view': 'front', 'hl': ['arms', 'forearms'], 'floor': 1255,
        'band': lambda p: ['l_hand', 'l_foot', 'r_foot', 'r_hand'],
        'p0': p0, 'p1': p1,
        'arrows': [((520, 680), (540, 445)), ((920, 680), (900, 445))],
    }

    # 9011: pilates band lateral raise (front view, band under feet)
    p0 = stand_base()
    p0.update({'l_elb': (580, 560), 'r_elb': (860, 560), 'l_hand': (570, 725), 'r_hand': (870, 725)})
    p1 = stand_base()
    p1.update({'l_elb': (415, 415), 'r_elb': (1025, 415), 'l_hand': (255, 415), 'r_hand': (1185, 415)})
    specs['9011-pb-lateral-raise'] = {
        'view': 'front', 'hl': ['shoulders'], 'floor': 1255,
        'band': lambda p: ['l_hand', 'l_foot', 'r_foot', 'r_hand'],
        'p0': p0, 'p1': p1,
        'arrows': [((480, 660), (295, 465)), ((960, 660), (1145, 465))],
    }

    # 9012: pilates band external rotation (rotator cuff, front view)
    p0 = stand_base()
    p0.update({'l_elb': (575, 555), 'r_elb': (865, 555), 'l_hand': (675, 555), 'r_hand': (765, 555)})
    p1 = stand_base()
    p1.update({'l_elb': (575, 555), 'r_elb': (865, 555), 'l_hand': (425, 545), 'r_hand': (1015, 545)})
    specs['9012-pb-external-rotation'] = {
        'view': 'front', 'hl': ['shoulders'], 'floor': 1255,
        'band': lambda p: ['l_hand', 'r_hand'],
        'p0': p0, 'p1': p1,
        'arrows': [((620, 495), (435, 495)), ((820, 495), (1005, 495))],
    }

    # 9013: pilates band roll-up (side view on mat, band around feet)
    ru0 = {
        'head': (260, 1140), 'chest': (390, 1145), 'mid': (545, 1145), 'pelvis': (700, 1145),
        'l_sh': (395, 1135), 'r_sh': (395, 1135),
        'l_elb': (540, 1085), 'r_elb': (540, 1085),
        'l_hand': (695, 1055), 'r_hand': (695, 1055),
        'l_hip': (715, 1145), 'r_hip': (715, 1145),
        'l_knee': (940, 1150), 'r_knee': (940, 1150),
        'l_ankle': (1175, 1155), 'r_ankle': (1175, 1155),
        'l_foot': (1205, 1070), 'r_foot': (1205, 1070),
    }
    ru1 = dict(ru0)
    ru1.update({
        'head': (760, 745), 'chest': (715, 865), 'mid': (705, 1005), 'pelvis': (700, 1145),
        'l_sh': (725, 875), 'r_sh': (725, 875),
        'l_elb': (895, 935), 'r_elb': (895, 935),
        'l_hand': (1070, 985), 'r_hand': (1070, 985),
    })
    specs['9013-pb-roll-up'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['core'], 'floor': 1210, 'mat': True,
        'band': lambda p: ['l_hand', 'l_foot'],
        'p0': ru0, 'p1': ru1,
        'arrows': [((345, 1000), (675, 765))],
    }

    # 9014: pilates band teaser (V-sit balance, band around feet)
    ts0 = dict(ru0)
    ts0.update({'l_knee': (910, 1020), 'r_knee': (910, 1020), 'l_ankle': (1130, 960), 'r_ankle': (1130, 960), 'l_foot': (1175, 910), 'r_foot': (1175, 910)})
    ts1 = {
        'head': (515, 650), 'chest': (565, 780), 'mid': (635, 955), 'pelvis': (710, 1125),
        'l_sh': (575, 795), 'r_sh': (575, 795),
        'l_elb': (745, 775), 'r_elb': (745, 775),
        'l_hand': (910, 755), 'r_hand': (910, 755),
        'l_hip': (720, 1125), 'r_hip': (720, 1125),
        'l_knee': (920, 910), 'r_knee': (920, 910),
        'l_ankle': (1110, 710), 'r_ankle': (1110, 710),
        'l_foot': (1155, 650), 'r_foot': (1155, 650),
    }
    specs['9014-pb-teaser'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['core', 'quads'], 'floor': 1210, 'mat': True,
        'band': lambda p: ['l_hand', 'l_foot'],
        'p0': ts0, 'p1': ts1,
        'arrows': [((435, 975), (565, 745)), ((1120, 900), (1120, 700))],
    }

    # 9015: pilates band hundred (hollow hold with band pulsed by arms)
    hd0 = {
        'head': (360, 955), 'chest': (460, 1065), 'mid': (585, 1135), 'pelvis': (720, 1145),
        'l_sh': (470, 1075), 'r_sh': (470, 1075),
        'l_elb': (640, 1025), 'r_elb': (640, 1025),
        'l_hand': (810, 980), 'r_hand': (810, 980),
        'l_hip': (730, 1145), 'r_hip': (730, 1145),
        'l_knee': (930, 985), 'r_knee': (930, 985),
        'l_ankle': (1125, 835), 'r_ankle': (1125, 835),
        'l_foot': (1165, 780), 'r_foot': (1165, 780),
    }
    hd1 = dict(hd0)
    hd1.update({'l_elb': (640, 1095), 'r_elb': (640, 1095), 'l_hand': (815, 1110), 'r_hand': (815, 1110)})
    specs['9015-pb-hundred'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['core'], 'floor': 1210, 'mat': True,
        'band': lambda p: ['l_hand', 'l_foot'],
        'p0': hd0, 'p1': hd1,
        'arrows': [((835, 955), (835, 1105))],
    }

    # 9016: pilates band single-leg circle (supine, band looped on raised foot, hands anchored)
    lc0 = {
        'head': (260, 1140), 'chest': (390, 1145), 'mid': (545, 1145), 'pelvis': (700, 1145),
        'l_sh': (395, 1135), 'r_sh': (395, 1135),
        'l_elb': (485, 1085), 'r_elb': (485, 1085),
        'l_hand': (565, 1030), 'r_hand': (565, 1030),
        'l_hip': (715, 1145), 'r_hip': (715, 1145),
        'l_knee': (780, 880), 'r_knee': (940, 1150),
        'l_ankle': (830, 620), 'r_ankle': (1175, 1155),
        'l_foot': (865, 575), 'r_foot': (1215, 1100),
    }
    lc1 = dict(lc0)
    lc1.update({'l_knee': (910, 920), 'l_ankle': (1070, 710), 'l_foot': (1110, 675)})
    specs['9016-pb-leg-circle'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['core', 'quads'], 'floor': 1210, 'mat': True,
        'band': lambda p: ['l_hand', 'l_foot'],
        'p0': lc0, 'p1': lc1,
        'arrows': [((860, 560), (1085, 650))],
    }

    # 9017: pilates band clamshell (side-lying with band above knees; feet together)
    cl0 = {
        'head': (310, 1065), 'chest': (430, 1085), 'mid': (580, 1105), 'pelvis': (730, 1110),
        'l_sh': (430, 1070), 'r_sh': (430, 1110),
        'l_elb': (515, 1135), 'r_elb': (320, 1135),
        'l_hand': (610, 1145), 'r_hand': (255, 1100),
        'l_hip': (740, 1110), 'r_hip': (740, 1130),
        'l_knee': (960, 1065), 'r_knee': (960, 1095),
        'l_ankle': (795, 1165), 'r_ankle': (795, 1175),
        'l_foot': (760, 1175), 'r_foot': (760, 1185),
    }
    cl1 = dict(cl0)
    cl1.update({'l_knee': (915, 860)})
    specs['9017-pb-clamshell'] = {
        'view': 'side', 'face_dir': -1, 'hl': ['glutes'], 'floor': 1210, 'mat': True,
        'band': lambda p: [((p['l_hip'][0] + p['l_knee'][0]) / 2, (p['l_hip'][1] + p['l_knee'][1]) / 2),
                           ((p['r_hip'][0] + p['r_knee'][0]) / 2, (p['r_hip'][1] + p['r_knee'][1]) / 2)],
        'looped': False,
        'p0': cl0, 'p1': cl1,
        'arrows': [((985, 1045), (945, 870))],
    }

    # 9018: pilates band donkey kick (all-fours, band anchored in hands & looped around foot)
    dk0 = {
        'head': (1025, 760), 'chest': (905, 830), 'mid': (745, 840), 'pelvis': (585, 850),
        'l_sh': (895, 845), 'r_sh': (895, 845),
        'l_elb': (895, 1015), 'r_elb': (895, 1015),
        'l_hand': (895, 1185), 'r_hand': (895, 1185),
        'l_hip': (580, 860), 'r_hip': (580, 860),
        'l_knee': (620, 1030), 'r_knee': (585, 1045),
        'l_ankle': (540, 1160), 'r_ankle': (430, 1180),
        'l_foot': (505, 1190), 'r_foot': (395, 1190),
    }
    dk1 = dict(dk0)
    dk1.update({'l_knee': (400, 775), 'l_ankle': (225, 675), 'l_foot': (195, 620)})
    specs['9018-pb-donkey-kick'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['glutes'], 'floor': 1210, 'mat': True,
        'band': lambda p: ['l_hand', 'l_foot'],
        'p0': dk0, 'p1': dk1,
        'arrows': [((520, 1070), (245, 710))],
    }

    # 9019: pilates band side-lying leg lift (band around lower legs/ankles)
    sl0 = {
        'head': (290, 1055), 'chest': (415, 1095), 'mid': (565, 1110), 'pelvis': (715, 1115),
        'l_sh': (415, 1075), 'r_sh': (415, 1115),
        'l_elb': (515, 1140), 'r_elb': (305, 1140),
        'l_hand': (605, 1150), 'r_hand': (245, 1105),
        'l_hip': (725, 1115), 'r_hip': (725, 1130),
        'l_knee': (960, 1115), 'r_knee': (960, 1135),
        'l_ankle': (1195, 1115), 'r_ankle': (1195, 1140),
        'l_foot': (1220, 1065), 'r_foot': (1220, 1095),
    }
    sl1 = dict(sl0)
    sl1.update({'l_knee': (940, 915), 'l_ankle': (1150, 725), 'l_foot': (1195, 695)})
    specs['9019-pb-side-leg-lift'] = {
        'view': 'side', 'face_dir': -1, 'hl': ['glutes', 'quads'], 'floor': 1210, 'mat': True,
        'band': lambda p: ['l_ankle', 'r_ankle'],
        'p0': sl0, 'p1': sl1,
        'arrows': [((1205, 1030), (1165, 765))],
    }

    # 9020: pilates band lateral walk (monster walk, front quarter-squat, band around knees/shins)
    p0 = stand_base(cx=640, y_shift=45)
    p0.update({'l_knee': (560, 965), 'r_knee': (720, 965), 'l_ankle': (565, 1200), 'r_ankle': (715, 1200), 'l_foot': (530, 1235), 'r_foot': (750, 1235), 'l_hand': (590, 560), 'r_hand': (690, 560), 'l_elb': (530, 520), 'r_elb': (750, 520)})
    p1 = stand_base(cx=790, y_shift=45)
    p1.update({'l_knee': (610, 965), 'r_knee': (965, 965), 'l_ankle': (600, 1200), 'r_ankle': (980, 1200), 'l_foot': (565, 1235), 'r_foot': (1015, 1235), 'l_hand': (740, 560), 'r_hand': (840, 560), 'l_elb': (680, 520), 'r_elb': (900, 520)})
    specs['9020-pb-lateral-walk'] = {
        'view': 'front', 'hl': ['quads', 'glutes'], 'floor': 1255,
        'band': lambda p: ['l_ankle', 'r_ankle'], 'looped': True,
        'p0': p0, 'p1': p1,
        'arrows': [((760, 1140), (960, 1140))],
    }

    # 9021: pilates band good morning (side view, band under feet and behind neck/shoulders)
    gm0 = {
        'head': (720, 260), 'chest': (720, 395), 'mid': (720, 570), 'pelvis': (720, 730),
        'l_sh': (720, 415), 'r_sh': (720, 415),
        'l_elb': (770, 525), 'r_elb': (770, 525),
        'l_hand': (755, 410), 'r_hand': (755, 410),
        'l_hip': (720, 745), 'r_hip': (720, 745),
        'l_knee': (720, 980), 'r_knee': (720, 980),
        'l_ankle': (720, 1200), 'r_ankle': (720, 1200),
        'l_foot': (775, 1235), 'r_foot': (775, 1235),
    }
    gm1 = dict(gm0)
    gm1.update({
        'head': (985, 595), 'chest': (865, 650), 'mid': (755, 705), 'pelvis': (640, 760),
        'l_sh': (855, 660), 'r_sh': (855, 660),
        'l_elb': (810, 775), 'r_elb': (810, 775),
        'l_hand': (880, 680), 'r_hand': (880, 680),
        'l_hip': (640, 765), 'r_hip': (640, 765),
    })
    specs['9021-pb-good-morning'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['core', 'quads'], 'floor': 1255,
        'band': lambda p: ['l_foot', 'l_sh'],
        'p0': gm1, 'p1': gm0,
        'arrows': [((960, 540), (745, 290))],
    }

    # 9022: pilates band hamstring stretch (supine, band looped around raised foot, gently pulled)
    hs0 = dict(lc0)
    hs0.update({'l_knee': (875, 975), 'l_ankle': (995, 775), 'l_foot': (1035, 725)})
    hs1 = dict(lc0)
    hs1.update({'l_knee': (735, 865), 'l_ankle': (750, 590), 'l_foot': (760, 530), 'l_hand': (585, 955)})
    specs['9022-pb-hamstring-stretch'] = {
        'view': 'side', 'face_dir': 1, 'hl': ['quads', 'calves'], 'floor': 1210, 'mat': True,
        'band': lambda p: ['l_hand', 'l_foot'],
        'p0': hs0, 'p1': hs1,
        'arrows': [((975, 725), (785, 555))],
    }

    # 9023: pilates band shoulder pass-through (mobility/stretch, front view)
    p0 = stand_base()
    p0.update({'l_elb': (495, 575), 'r_elb': (945, 575), 'l_hand': (425, 720), 'r_hand': (1015, 720)})
    p1 = stand_base()
    p1.update({'l_elb': (515, 265), 'r_elb': (925, 265), 'l_hand': (420, 145), 'r_hand': (1020, 145)})
    specs['9023-pb-shoulder-passthrough'] = {
        'view': 'front', 'hl': ['shoulders'], 'floor': 1255,
        'band': lambda p: ['l_hand', 'r_hand'],
        'p0': p0, 'p1': p1,
        'arrows': [((390, 620), (390, 210)), ((1050, 620), (1050, 210))],
    }

    # 9024: pilates band seated spine twist (seated upright, band across arms/front)
    tw0 = {
        'head': (720, 470), 'chest': (720, 610), 'mid': (720, 780), 'pelvis': (720, 945),
        'l_sh': (615, 625), 'r_sh': (825, 625),
        'l_elb': (510, 645), 'r_elb': (930, 645),
        'l_hand': (410, 650), 'r_hand': (1030, 650),
        'l_hip': (660, 965), 'r_hip': (780, 965),
        'l_knee': (555, 1085), 'r_knee': (885, 1085),
        'l_ankle': (645, 1185), 'r_ankle': (795, 1185),
        'l_foot': (680, 1200), 'r_foot': (760, 1200),
    }
    tw1 = dict(tw0)
    tw1.update({
        'l_sh': (645, 625), 'r_sh': (795, 625),
        'l_elb': (545, 710), 'r_elb': (895, 575),
        'l_hand': (485, 785), 'r_hand': (975, 520),
    })
    specs['9024-pb-spine-twist'] = {
        'view': 'front', 'hl': ['core'], 'floor': 1225, 'mat': True,
        'band': lambda p: ['l_hand', 'r_hand'],
        'p0': tw0, 'p1': tw1,
        'arrows': [((435, 695), (505, 780)), ((1005, 590), (955, 505))],
    }

    return specs


def build_exercise(stem, spec, out_dir: Path):
    img_path = out_dir / 'img' / f'{stem}.webp'
    mp4_path = out_dir / 'gif' / f'{stem}.mp4'

    # Still frame at peak contraction with crisp directional arrows
    still = render_frame(spec['p1'], spec, show_arrows=True)
    still.save(img_path, format='WEBP', quality=86, method=4)

    # Smooth 24-frame ping-pong loop at 12 fps (2.0s loop)
    p0, p1 = spec['p0'], spec['p1']
    frames = []
    # 2 pause frames at start, 9 forward, 3 hold at peak, 9 backward, 1 pause
    ts = [0.0, 0.0] + [ease(i / 9.0) for i in range(1, 10)] + [1.0, 1.0] + [ease(1.0 - i / 9.0) for i in range(1, 10)]
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        for idx, t in enumerate(ts):
            pose = interp_pose(p0, p1, t)
            fr = render_frame(pose, spec, show_arrows=False)
            fr.save(tdp / f'f_{idx:04d}.png')
        p = subprocess.run([
            'ffmpeg', '-hide_banner', '-loglevel', 'error',
            '-framerate', '12', '-i', str(tdp / 'f_%04d.png'),
            '-c:v', 'libx264', '-crf', '26', '-preset', 'slow',
            '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart', '-an', '-y', str(mp4_path),
        ], capture_output=True)
        if p.returncode != 0:
            return f'{stem}: {p.stderr.decode("utf-8", "replace")}'
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='Output directory containing gif/ and img/')
    ap.add_argument('--jobs', type=int, default=4)
    args = ap.parse_args()

    out_dir = Path(args.out)
    (out_dir / 'gif').mkdir(parents=True, exist_ok=True)
    (out_dir / 'img').mkdir(parents=True, exist_ok=True)

    specs = make_specs()
    errs = []
    with ThreadPoolExecutor(max_workers=max(1, args.jobs)) as pool:
        for err in pool.map(lambda kv: build_exercise(kv[0], kv[1], out_dir), specs.items()):
            if err:
                errs.append(err)
    if errs:
        print('\n'.join(errs), file=sys.stderr)
        return 1
    print(f'Generated {len(specs)} Pilates/band media pairs (720x720) in {out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
