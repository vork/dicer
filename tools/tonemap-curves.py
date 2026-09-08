"""
Exact comparison of tone mapping operators on a tinted highlight.

This exists because the GPU sheet cannot do it: three keys its shader program
cache on the material's own source, so swapping the tone mapping ShaderChunk at
runtime silently reuses the previously compiled program. Here there is no cache
to fight, and the operators are transcribed from three's own shaders.

The question it answers is narrow and it is the one that matters for this scene:
as a tinted specular highlight gets brighter, does it stay the colour it was?

    python3 tools/tonemap-curves.py
"""
import math

def mul(m, v):
    return [sum(m[i][j] * v[j] for j in range(3)) for i in range(3)]

ACES_IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]]
ACES_OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]]


def aces(c, exposure=1.0):
    c = [x * exposure / 0.6 for x in c]
    c = mul(ACES_IN, c)
    fit = lambda v: (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081)
    c = mul(ACES_OUT, [fit(x) for x in c])
    return [min(1, max(0, x)) for x in c]


def gt_curve(x, P=1.0, a=1.0, m=0.22, l=0.4, c=1.33, b=0.0):
    """Uchimura's GT curve: a toe, a straight section, and a shoulder."""
    l0 = ((P - m) * l) / a
    S0, S1 = m + l0, m + a * l0
    C2 = (a * P) / (P - S1)
    CP = -C2 / P
    def smoothstep(e0, e1, v):
        t = min(1, max(0, (v - e0) / (e1 - e0)))
        return t * t * (3 - 2 * t)
    w0 = 1 - smoothstep(0.0, m, x)
    w2 = 1.0 if x >= m + l0 else 0.0
    w1 = 1 - w0 - w2
    T = m * pow(max(x, 1e-8) / m, c) + b
    S = P - (P - S1) * math.exp(CP * (x - S0))
    L = m + a * (x - m)
    return T * w0 + L * w1 + S * w2


def gt_per_channel(c, exposure=1.0):
    """The GT curve as it is normally published: run on each channel separately."""
    return [min(1, max(0, gt_curve(x * exposure))) for x in c]


def gt_hue_safe(c, exposure=1.0):
    """
    The same curve run on luminance, with the chroma carried through and
    desaturated only as far as it takes to fit in gamut. This is the part of GT7
    worth having in a scene made of tinted specular: the curve decides brightness,
    and colour is left alone until it physically cannot be.
    """
    c = [x * exposure for x in c]
    L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    if L <= 1e-6:
        return [0.0, 0.0, 0.0]
    Lt = gt_curve(L)
    mapped = [x / L * Lt for x in c]
    peak = max(mapped)
    if peak > 1.0:
        t = min(1, max(0, (peak - 1.0) / max(peak - Lt, 1e-6)))
        mapped = [x * (1 - t) + Lt * t for x in mapped]
    return [min(1, max(0, x)) for x in mapped]


def neutral(c, exposure=1.0):
    """three's NeutralToneMapping, the Khronos PBR Neutral operator."""
    c = [x * exposure for x in c]
    start, desaturation = 0.8 - 0.04, 0.15
    x = min(c)
    offset = x - 6.25 * x * x if x < 0.08 else 0.04
    c = [v - offset for v in c]
    peak = max(c)
    if peak < start:
        return [min(1, max(0, v)) for v in c]
    d = 1.0 - start
    new_peak = 1.0 - d * d / (peak + d - start)
    c = [v * new_peak / peak for v in c]
    g = 1.0 - 1.0 / (desaturation * (peak - new_peak) + 1.0)
    return [min(1, max(0, v * (1 - g) + new_peak * g)) for v in c]


def srgb(v):
    return 12.92 * v if v <= 0.0031308 else 1.055 * pow(v, 1 / 2.4) - 0.055


def describe(c):
    r, g, b = (srgb(x) for x in c)
    mx, mn = max(r, g, b), min(r, g, b)
    sat = 0 if mx <= 0 else (mx - mn) / mx
    if mx == mn:
        hue = 0
    elif mx == r:
        hue = (60 * ((g - b) / (mx - mn)) + 360) % 360
    elif mx == g:
        hue = 60 * ((b - r) / (mx - mn)) + 120
    else:
        hue = 60 * ((r - g) / (mx - mn)) + 240
    return sat, hue


if __name__ == '__main__':
    base = [1.0, 0.52, 0.20]  # a warm flake glint
    operators = [
        ('ACES (now)', aces, 1.28),
        ('Khronos Neutral', neutral, 1.81),
        ('GT per channel', gt_per_channel, 1.11),
        ('GT, chroma kept', gt_hue_safe, 1.11),
    ]
    print('  a warm tinted glint as it gets brighter, at exposures matched on the real frame')
    print('  saturation of the result, and how far its hue has moved from 32 degrees\n')
    print('   linear   ' + '  '.join(f'{name:>18}' for name, _, _ in operators))
    for k in (0.5, 1, 2, 4, 8, 16):
        cells = []
        for _, fn, exposure in operators:
            sat, hue = describe(fn([x * k for x in base], exposure))
            cells.append(f'sat {sat:4.2f} hue {hue:3.0f}'.rjust(18))
        print(f'   {k:5.1f}x   ' + '  '.join(cells))
