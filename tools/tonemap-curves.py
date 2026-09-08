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


# --- GT7 Tone Mapping ---------------------------------------------------------
#
# Transcribed from the MIT-licensed reference implementation in Polyphony's 2025
# SIGGRAPH course notes, "Physically Based Tone Mapping in GT7". This is a
# different animal from the 2017 GT curve above: that one is per-channel, and GT7
# moved to colour volume mapping. It runs the per-channel curve to get a
# deliberately hue-twisted result, converts both the original and the twisted
# colour into a uniform colour space, takes the luminance from the twisted one and
# the chroma from the original scaled by a fade, and blends the two in RGB. The
# blend is the point: all-untwisted looks synthetic, all-twisted is a camera.
#
# It works in linear Rec.2020, and its SDR path assumes paper white at 250 nits
# where sRGB's 1.0 is 100, so it maps up to 2.5 and scales back down by 0.4.

REFERENCE_LUMINANCE = 100.0
GT7_SDR_PAPER_WHITE = 250.0

REC709_TO_REC2020 = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]]
REC2020_TO_REC709 = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]]

_M1, _C1, _C2, _C3, _PQC = 0.1593017578125, 0.8359375, 18.8515625, 18.6875, 10000.0


def inverse_eotf_st2084(v, exponent_scale=1.0):
    m2 = 78.84375 * exponent_scale
    y = max(v * REFERENCE_LUMINANCE, 0.0) / _PQC
    ym = pow(y, _M1)
    return pow(2.0, m2 * (math.log2(_C1 + _C2 * ym) - math.log2(1.0 + _C3 * ym)))


def eotf_st2084(n, exponent_scale=1.0):
    m2 = 78.84375 * exponent_scale
    n = min(1.0, max(0.0, n))
    npow = pow(n, 1.0 / m2)
    l = max(npow - _C1, 0.0) / (_C2 - _C3 * npow)
    return pow(l, 1.0 / _M1) * _PQC / REFERENCE_LUMINANCE


def rgb_to_ictcp(rgb):
    """Input: linear Rec.2020."""
    l = (rgb[0] * 1688.0 + rgb[1] * 2146.0 + rgb[2] * 262.0) / 4096.0
    m = (rgb[0] * 683.0 + rgb[1] * 2951.0 + rgb[2] * 462.0) / 4096.0
    s = (rgb[0] * 99.0 + rgb[1] * 309.0 + rgb[2] * 3688.0) / 4096.0
    lp, mp, sp = (inverse_eotf_st2084(x) for x in (l, m, s))
    return [
        (2048.0 * lp + 2048.0 * mp) / 4096.0,
        (6610.0 * lp - 13613.0 * mp + 7003.0 * sp) / 4096.0,
        (17933.0 * lp - 17390.0 * mp - 543.0 * sp) / 4096.0,
    ]


def ictcp_to_rgb(ictcp):
    i, ct, cp = ictcp
    l = eotf_st2084(i + 0.00860904 * ct + 0.11103 * cp)
    m = eotf_st2084(i - 0.00860904 * ct - 0.11103 * cp)
    s = eotf_st2084(i + 0.560031 * ct - 0.320627 * cp)
    return [
        max(3.43661 * l - 2.50645 * m + 0.0698454 * s, 0.0),
        max(-0.79133 * l + 1.9836 * m - 0.192271 * s, 0.0),
        max(-0.0259499 * l - 0.0989137 * m + 1.12486 * s, 0.0),
    ]


def smooth_step(x, edge0, edge1):
    if x < edge0:
        return 0.0
    if x > edge1:
        return 1.0
    t = (x - edge0) / (edge1 - edge0)
    return t * t * (3.0 - 2.0 * t)


class GTToneMappingCurveV2:
    """The GT curve with a convergent shoulder; the 2017 one did not reach its peak."""

    def __init__(self, peak, alpha=0.25, mid=0.538, linear_section=0.444, toe=1.280):
        self.peak, self.mid, self.linear_section, self.toe = peak, mid, linear_section, toe
        k = (linear_section - 1.0) / (alpha - 1.0)
        self.kA = peak * linear_section + peak * k
        self.kB = -peak * k * math.exp(linear_section / k)
        self.kC = -1.0 / (k * peak)

    def evaluate(self, x):
        if x < 0.0:
            return 0.0
        if x < self.linear_section * self.peak:
            weight_linear = smooth_step(x, 0.0, self.mid)
            toe_mapped = self.mid * pow(x / self.mid, self.toe) if x > 0 else 0.0
            return (1.0 - weight_linear) * toe_mapped + weight_linear * x
        return self.kA + self.kB * math.exp(x * self.kC)


def gt7(c, exposure=1.0, blend_ratio=0.6, fade_start=0.98, fade_end=1.16):
    c = [x * exposure for x in c]
    rgb = mul(REC709_TO_REC2020, c)
    fb_target = GT7_SDR_PAPER_WHITE / REFERENCE_LUMINANCE   # 2.5
    sdr_correction = 1.0 / fb_target                        # 0.4
    curve = GTToneMappingCurveV2(fb_target)
    target_ucs = rgb_to_ictcp([fb_target] * 3)[0]

    ucs = rgb_to_ictcp(rgb)
    skewed = [curve.evaluate(x) for x in rgb]
    skewed_ucs = rgb_to_ictcp(skewed)
    chroma_scale = 1.0 - smooth_step(ucs[0] / target_ucs, fade_start, fade_end)
    scaled = ictcp_to_rgb([skewed_ucs[0], ucs[1] * chroma_scale, ucs[2] * chroma_scale])

    blended = [
        sdr_correction * min((1.0 - blend_ratio) * skewed[i] + blend_ratio * scaled[i], fb_target)
        for i in range(3)
    ]
    return [min(1, max(0, x)) for x in mul(REC2020_TO_REC709, blended)]


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
        ('GT7', gt7, 1.0),
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
