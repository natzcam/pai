# Makes the app's icons (assets/): the word "pai" in white on the app's
# accent green. Run again after changing the look: python3 scripts/make-icons.py
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ACCENT = (47, 93, 80, 255)  # ui.tsx's LIGHT.accent, #2F5D50
WHITE = (255, 255, 255, 255)
FONT = '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf'
out = Path(__file__).resolve().parent.parent / 'assets'
out.mkdir(exist_ok=True)


def word(size, scale, background):
    img = Image.new('RGBA', (size, size), background)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, int(size * scale))
    box = d.textbbox((0, 0), 'pai', font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((size - w) / 2 - box[0], (size - h) / 2 - box[1]), 'pai', font=font, fill=WHITE)
    return img


# iOS and the store: a full square (iOS rounds the corners itself).
word(1024, 0.36, ACCENT).save(out / 'icon.png')
# Android's adaptive icon: the mark alone, inside the middle 66% that every
# mask keeps; the green comes from app.json's backgroundColor.
word(1024, 0.26, (0, 0, 0, 0)).save(out / 'adaptive-icon.png')
# The splash: the mark small, on the same green.
word(1024, 0.16, (0, 0, 0, 0)).save(out / 'splash-icon.png')
print('wrote', ', '.join(p.name for p in sorted(out.glob('*.png'))))
