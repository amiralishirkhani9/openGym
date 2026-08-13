#!/usr/bin/env python3
"""
Contrast audit for the segmented control, before and after tinting the selected pill.

The ask is to make the control match the app's theme. Everything else that means
"selected" in this app is the accent -- the switches, the FAB, the active tab -- while the
segmented pill was a flat grey (#48484a dark / #ffffff light). So the pill should take the
accent. But the label sitting ON that pill then has to pass, and the numbers matter here in
a way they did not for buttons:

  · Button text is 17px/600 -> WCAG "large text", AA bar 3:1.
  · Segmented text is 14px/600 -> NOT large (the bar is 18.66px regular / 14px bold, and
    600 is not bold enough to claim the bold exemption at 14px). AA bar is 4.5:1.

So --on-acc, which was chosen against the 3:1 bar for buttons, cannot be assumed to carry
over. This script computes every accent x theme combination against both candidate label
colours and reports which pass 4.5:1.
"""

ACC = {
    # accent: (dark value, light value)  -- from index.css :root and [data-theme=light]
    'lime':   ('#30d158', '#34c759'),
    'sky':    ('#0a84ff', '#007aff'),
    'orange': ('#ff9f0a', '#ff9500'),
    'violet': ('#bf5af2', '#af52de'),
    'pink':   ('#ff375f', '#ff2d55'),
    'red':    ('#ff453a', '#ff3b30'),
    'teal':   ('#40c8e0', '#30b0c7'),
    'gold':   ('#ffd60a', '#ffcc00'),
}

# What --on-acc currently resolves to, per theme and accent (index.css).
ON_ACC_DARK = {'lime': '#000', 'sky': '#fff', 'orange': '#000', 'violet': '#fff',
               'pink': '#fff', 'red': '#fff', 'teal': '#000', 'gold': '#000'}
ON_ACC_LIGHT = {'lime': '#000', 'sky': '#fff', 'orange': '#000', 'violet': '#fff',
                'pink': '#fff', 'red': '#fff', 'teal': '#000', 'gold': '#000'}

TRACK = {'dark': '#242426', 'light': '#ebebec'}   # light track is rgba(118,118,128,.12) over #fff
CARD = {'dark': '#1c1c1e', 'light': '#ffffff'}


def rgb(h):
    h = h.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lum(h):
    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(x) for x in rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = lum(a), lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def mix(fg, bg, alpha):
    """fg over bg at alpha -- for the soft accent tint candidate."""
    f, b = rgb(fg), rgb(bg)
    out = tuple(round(f[i] * alpha + b[i] * (1 - alpha)) for i in range(3))
    return '#%02x%02x%02x' % out


BAR = 4.5
print('SEGMENTED LABEL ON A FULL-ACCENT PILL (14px/600 -> AA bar 4.5:1)')
print(f'{"accent":8} {"theme":6} {"pill":9} {"on-acc":8} {"ratio":>6}  {"white":>6} {"black":>6}  verdict')
fails = []
for name, (dv, lv) in ACC.items():
    for theme, pill in (('dark', dv), ('light', lv)):
        on = (ON_ACC_DARK if theme == 'dark' else ON_ACC_LIGHT)[name]
        r = ratio(on, pill)
        w, b = ratio('#ffffff', pill), ratio('#000000', pill)
        ok = 'PASS' if r >= BAR else 'FAIL'
        best = 'white' if w > b else 'black'
        if r < BAR:
            fails.append((name, theme, r, max(w, b), best))
        print(f'{name:8} {theme:6} {pill:9} {on:8} {r:6.2f}  {w:6.2f} {b:6.2f}  {ok}'
              + ('' if r >= BAR else f'  best={best} {max(w, b):.2f}'))

print()
if fails:
    print(f'{len(fails)} of {len(ACC) * 2} combinations FAIL a full-accent pill:')
    for name, theme, r, best_r, best in fails:
        status = 'still fails' if best_r < BAR else f'fixable with {best}'
        print(f'  {name}/{theme}: {r:.2f} — {status} ({best_r:.2f})')
    unfixable = [f for f in fails if f[3] < BAR]
    print()
    print(f'unfixable by swapping the label colour: {len(unfixable)}')
    for name, theme, r, best_r, best in unfixable:
        print(f'  {name}/{theme}: best possible {best_r:.2f} < {BAR}')

# The alternative: keep a neutral pill and carry the accent in the LABEL only, which is how
# iOS tints a segmented control it does not want to fill.
print()
print('ALTERNATIVE — neutral raised pill, accent-coloured label on it')
print(f'{"accent":8} {"theme":6} {"pill":9} {"label":9} {"ratio":>6}  verdict')
alt_fails = 0
for name, (dv, lv) in ACC.items():
    for theme, acc in (('dark', dv), ('light', lv)):
        pill = '#48484a' if theme == 'dark' else '#ffffff'
        r = ratio(acc, pill)
        ok = 'PASS' if r >= BAR else 'FAIL'
        if r < BAR:
            alt_fails += 1
        print(f'{name:8} {theme:6} {pill:9} {acc:9} {r:6.2f}  {ok}')
print(f'\n{alt_fails} of {len(ACC) * 2} fail')

# Fourth candidate, and the one that keeps white text where the platform expects it: use the
# already-defined darker accent (--acc-2, the pressed state) as the pill wherever the bright
# accent cannot carry white at 4.5:1.
ACC2 = {
    'lime': ('#248a3d', '#248a3d'), 'sky': ('#0060df', '#0060df'),
    'orange': ('#c76b00', '#c76b00'), 'violet': ('#8944ab', '#8944ab'),
    'pink': ('#d70036', '#d70036'), 'red': ('#d70015', '#d70015'),
    'teal': ('#0071a4', '#0071a4'), 'gold': ('#b25000', '#b25000'),
}
print()
print('FOURTH — --acc-2 (the existing darker accent) as the pill, white label')
print(f'{"accent":8} {"acc-2":9} {"white":>6}  verdict')
for name, (d2, _) in ACC2.items():
    r = ratio('#ffffff', d2)
    print(f'{name:8} {d2:9} {r:6.2f}  {"PASS" if r >= BAR else "FAIL"}')

# Third candidate: soft accent tint as the pill, accent as the label, matching .chip.on
print()
print('THIRD — soft accent tint pill (accent @ 22% over the track), accent label')
print(f'{"accent":8} {"theme":6} {"pill":9} {"label":9} {"ratio":>6}  {"vs track":>8}  verdict')
soft_fails = 0
for name, (dv, lv) in ACC.items():
    for theme, acc in (('dark', dv), ('light', lv)):
        pill = mix(acc, TRACK[theme], 0.22)
        r = ratio(acc, pill)
        vt = ratio(pill, TRACK[theme])
        ok = 'PASS' if r >= BAR else 'FAIL'
        if r < BAR:
            soft_fails += 1
        print(f'{name:8} {theme:6} {pill:9} {acc:9} {r:6.2f}  {vt:8.2f}  {ok}')
print(f'\n{soft_fails} of {len(ACC) * 2} fail')

# ---------------------------------------------------------------- decision --
# A full-accent pill with BLACK labels passes 16/16 at the 4.5:1 bar, and black-on-accent is
# already this app's convention for accent fills (the FAB and every primary button use
# --on-acc, which is black for the default green). White passes on only 4 of 16. So the pill
# takes the accent and the label on it is black, via its own token rather than by reusing
# --on-acc -- that one was chosen against the 3:1 large-text bar and is white for half the
# accents, which would fail here.
print()
print('CHOSEN — accent pill, black label. Also checking the pill is visible AS a shape')
print('(WCAG non-text contrast, 3:1, pill against its own track)')
print(f'{"accent":8} {"theme":6} {"label 4.5":>9} {"pill/track 3.0":>15}  verdict')
worst_label, worst_shape = 99, 99
for name, (dv, lv) in ACC.items():
    for theme, pill in (('dark', dv), ('light', lv)):
        rl = ratio('#000000', pill)
        rs = ratio(pill, TRACK[theme])
        worst_label, worst_shape = min(worst_label, rl), min(worst_shape, rs)
        ok = 'PASS' if rl >= 4.5 and rs >= 3.0 else 'FAIL'
        print(f'{name:8} {theme:6} {rl:9.2f} {rs:15.2f}  {ok}')
print(f'\nworst label {worst_label:.2f} (bar 4.5)   worst pill-vs-track {worst_shape:.2f} (bar 3.0)')

# The label passes everywhere (worst 5.08). The pill-vs-track boundary does NOT, in light
# mode, for the bright accents: lime is 1.86 against the near-white track. WCAG 1.4.11 lets a
# component satisfy the 3:1 boundary requirement via a BORDER rather than the fill itself, and
# --acc-2 (the pressed-state accent) already exists and is dark. Check it as a ring.
print()
print('BOUNDARY RING — --acc-2 as a hairline ring around the pill, vs the track')
print(f'{"accent":8} {"theme":6} {"ring":9} {"ring/track":>10}  verdict')
worst_ring = 99
for name, (d2, _) in ACC2.items():
    for theme in ('dark', 'light'):
        r = ratio(d2, TRACK[theme])
        worst_ring = min(worst_ring, r)
        print(f'{name:8} {theme:6} {d2:9} {r:10.2f}  {"PASS" if r >= 3.0 else "FAIL"}')
print(f'\nworst ring-vs-track {worst_ring:.2f} (bar 3.0)')

# Neither the fill alone nor the ring alone clears 3:1 everywhere -- but they fail in opposite
# themes. In DARK the accent fill is far lighter than the #242426 track (worst 4.25). In LIGHT
# the fill is too close to the near-white track, while the darker --acc-2 ring is well clear of
# it (worst 3.19). Drawing both means the boundary is satisfied by whichever one has contrast
# in that theme, so a single rule covers all 16 combinations.
print()
print('FILL + RING TOGETHER — boundary satisfied by whichever has contrast in that theme')
print(f'{"accent":8} {"theme":6} {"fill":>6} {"ring":>6} {"best":>6}  verdict')
worst_best = 99
for name, (dv, lv) in ACC.items():
    d2 = ACC2[name][0]
    for theme, pill in (('dark', dv), ('light', lv)):
        rf, rr = ratio(pill, TRACK[theme]), ratio(d2, TRACK[theme])
        best = max(rf, rr)
        worst_best = min(worst_best, best)
        print(f'{name:8} {theme:6} {rf:6.2f} {rr:6.2f} {best:6.2f}  {"PASS" if best >= 3.0 else "FAIL"}')
print(f'\nworst of the better boundary: {worst_best:.2f} (bar 3.0) '
      f'-- {"all pass" if worst_best >= 3.0 else "STILL FAILING"}')
