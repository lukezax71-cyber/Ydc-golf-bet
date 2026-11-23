#!/usr/bin/env python3
"""YDC 골프 내기 아이콘 생성 (PNG)."""
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'icons')
FONT_BOLD = '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'

GOLD = (247, 187, 7)
GREEN_TOP = (23, 105, 60)
GREEN_BOT = (9, 40, 23)


def gradient(size):
    img = Image.new('RGB', (size, size), GREEN_BOT)
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(GREEN_TOP[0] + (GREEN_BOT[0] - GREEN_TOP[0]) * t)
        g = int(GREEN_TOP[1] + (GREEN_BOT[1] - GREEN_TOP[1]) * t)
        b = int(GREEN_TOP[2] + (GREEN_BOT[2] - GREEN_TOP[2]) * t)
        d.line([(0, y), (size, y)], fill=(r, g, b))
    return img


def draw_mark(img, size, scale=1.0):
    """깃발 + 골프공 + YDC."""
    d = ImageDraw.Draw(img, 'RGBA')
    s = size * scale

    # 골드 테두리 링
    pad = size * 0.06
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=size * 0.20,
                        outline=GOLD, width=max(2, int(size * 0.018)))

    # 깃대
    px = size * 0.60
    top = size * 0.26
    bottom = size * 0.60
    d.line([(px, top), (px, bottom)], fill=(255, 255, 255), width=max(3, int(size * 0.024)))
    # 깃발(골드 삼각형)
    d.polygon([(px, top), (px, top + size * 0.14), (px - size * 0.20, top + size * 0.07)], fill=GOLD)

    # 골프공
    bx, by, br = size * 0.36, size * 0.64, size * 0.075
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=(255, 255, 255))
    d.ellipse([bx - br * 0.35, by - br * 0.35, bx + br * 0.25, by + br * 0.25], fill=(222, 232, 224))

    # YDC
    try:
        font = ImageFont.truetype(FONT_BOLD, int(s * 0.155))
    except Exception:
        font = ImageFont.load_default()
    text = 'YDC'
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size - tw) / 2 - bbox[0], size * 0.755 - bbox[1]), text, font=font, fill=GOLD)


def make(size, maskable=False):
    img = gradient(size)
    draw_mark(img, size, scale=0.82 if maskable else 1.0)
    if not maskable:
        mask = Image.new('L', (size, size), 0)
        md = ImageDraw.Draw(mask)
        md.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
        out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        return out
    return img.convert('RGBA')


def main():
    os.makedirs(OUT, exist_ok=True)
    specs = [
        ('icon-180.png', 180, False),
        ('icon-192.png', 192, False),
        ('icon-512.png', 512, False),
        ('icon-maskable-512.png', 512, True),
    ]
    for name, size, maskable in specs:
        img = make(size, maskable)
        img.save(os.path.join(OUT, name))
        print('wrote', name, size, 'maskable' if maskable else '')


if __name__ == '__main__':
    main()
