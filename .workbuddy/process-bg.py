from PIL import Image
import os

src = r"g:\AI软件\novel-studio开发源码\generated-images\A_clean_minimalist_line_art_we_2026-08-25T11-25-37.png"
dst = r"g:\AI软件\novel-studio开发源码\src\assets\workbench-bg.png"

os.makedirs(os.path.dirname(dst), exist_ok=True)
img = Image.open(src).convert('RGBA')
w, h = img.size
pixels = img.load()

# 右下角水印区域（模型自动加的角落标记）
WATERMARK_X_START = w - 140
WATERMARK_Y_START = h - 55

for y in range(h):
    for x in range(w):
        r, g, b, a = pixels[x, y]
        # 去白底变透明（让背景色透出来）
        if r > 245 and g > 245 and b > 245:
            pixels[x, y] = (255, 255, 255, 0)
        # 右下角水印区直接挖空
        elif x >= WATERMARK_X_START and y >= WATERMARK_Y_START:
            pixels[x, y] = (255, 255, 255, 0)
        else:
            # 整体压低线条不透明度，让它作为背景纹理若隐若现
            pixels[x, y] = (r, g, b, int(a * 0.13))

img.save(dst)
print(f"Saved processed background to {dst}")
