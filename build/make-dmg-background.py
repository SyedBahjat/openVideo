"""Renders build/background.png (+ @2x) for the macOS installer window. Run: python3 build/make-dmg-background.py"""
import math, random
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, S = 660, 420, 2                     # window size in points, retina scale
PAPER, INK, SOFT, RED = (246, 241, 231), (29, 26, 22), (107, 98, 85), (229, 67, 45)
APP_X, APPS_X, ICON_Y = 180, 480, 215     # must match "dmg.contents" in package.json
FONTS = '/System/Library/Fonts/'

def font(name, size): return ImageFont.truetype(FONTS + name, size * S)

img = Image.new('RGB', (W * S, H * S), PAPER)
# paper grain
rnd = random.Random(7)
grain = Image.new('L', img.size)
grain.putdata([rnd.randint(0, 255) for _ in range(img.size[0] * img.size[1])])
grain = grain.filter(ImageFilter.GaussianBlur(0.6))
img = Image.composite(Image.new('RGB', img.size, (236, 229, 215)), img, grain.point(lambda v: 26 if v > 170 else 0))
d = ImageDraw.Draw(img)

# wordmark
open_f, video_f = font('NewYork.ttf', 34), font('NewYorkItalic.ttf', 34)
w1, w2 = d.textlength('open', font=open_f), d.textlength('Video', font=video_f)
x = (W * S - (w1 + w2)) / 2
d.text((x, 38 * S), 'open', font=open_f, fill=INK)
d.text((x + w1, 38 * S), 'Video', font=video_f, fill=RED)
sub = font('SFNS.ttf', 14)
t = 'Drag openVideo into Applications to install'
d.text(((W * S - d.textlength(t, font=sub)) / 2, 92 * S), t, font=sub, fill=SOFT)

# soft discs behind the two icon slots
for cx in (APP_X, APPS_X):
    r = 74 * S
    d.ellipse([cx * S - r, ICON_Y * S - r, cx * S + r, ICON_Y * S - r + 2 * r], fill=(239, 232, 218))

# dashed arc arrow from app to Applications
x0, x1, y = (APP_X + 78) * S, (APPS_X - 80) * S, (ICON_Y - 6) * S
cx, sag = (x0 + x1) / 2, 34 * S
pts = [(x0 + (x1 - x0) * i / 120, y - sag * math.sin(math.pi * i / 120)) for i in range(121)]
for i in range(0, 114, 8):  # dashes
    d.line(pts[i:i + 5], fill=RED, width=4 * S, joint='curve')
ex, ey = pts[-1]; px, py = pts[-6]
ang = math.atan2(ey - py, ex - px)
head = [(ex + 4 * S * math.cos(ang), ey + 4 * S * math.sin(ang)),
        (ex - 15 * S * math.cos(ang - 0.5), ey - 15 * S * math.sin(ang - 0.5)),
        (ex - 15 * S * math.cos(ang + 0.5), ey - 15 * S * math.sin(ang + 0.5))]
d.polygon(head, fill=RED)

# first-launch steps
small, mono = font('SFNS.ttf', 11), font('SFNSMono.ttf', 10)
d.line([(60 * S, 338 * S), ((W - 60) * S, 338 * S)], fill=(217, 207, 187), width=S)
t = 'Then open it and allow Camera, Microphone and Screen Recording.'
d.text(((W * S - d.textlength(t, font=small)) / 2, 352 * S), t, font=small, fill=SOFT)
t1, t2 = 'If macOS blocks it, run in Terminal:  ', 'xattr -cr /Applications/openVideo.app'
tw = d.textlength(t1, font=small) + d.textlength(t2, font=mono)
x = (W * S - tw) / 2
d.text((x, 374 * S), t1, font=small, fill=SOFT)
d.text((x + d.textlength(t1, font=small), 375 * S), t2, font=mono, fill=INK)

img.save('build/background@2x.png')
img.resize((W, H), Image.LANCZOS).save('build/background.png')
print('wrote build/background.png and build/background@2x.png')
