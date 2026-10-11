# -*- coding: utf-8 -*-
"""
B 站封面 · 叠字
在 AI 底图上叠加标题文字，输出 1920x1080 成品
用法：python add_text.py [A|B|C|D|all]
输出：成品/封面_{风格}.png
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "底图")
OUT = os.path.join(HERE, "成品")
os.makedirs(OUT, exist_ok=True)

W, H = 1920, 1080
SAFE = 90

FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"

# 配色
GOLD = (255, 214, 130)
GOLD_LT = (255, 240, 200)
WHITE = (255, 255, 255)
DARK = (12, 16, 30)

# 每风格的底图文件名（取最新 seed）
STYLES = {
    "A": ("A_曜金夜阁_seed5201.png", "封面_A_曜金夜阁"),
    "B": ("B_青蓝书楼_seed5202.png", "封面_B_青蓝书楼"),
    "C": ("C_翠玉秘境_seed5317.png", "封面_C_翠玉秘境"),
    "D": ("D_紫霞星河_seed5204.png", "封面_D_紫霞星河"),
}


def font(path, size):
    return ImageFont.truetype(path, size)


def text_wh(d, s, f):
    b = d.textbbox((0, 0), s, font=f)
    return b[2] - b[0], b[3] - b[1]


def draw_stroke_text(d, xy, s, f, fill, stroke, sw):
    """带描边的文字"""
    x, y = xy
    d.text((x, y), s, font=f, fill=fill,
           stroke_width=sw, stroke_fill=stroke)


def left_scrim(img, x0, alpha_max=170, feather=260):
    """左侧渐暗罩，给文字让出对比度"""
    layer = Image.new("L", (W, H), 0)
    ld = ImageDraw.Draw(layer)
    for x in range(x0 + feather):
        if x < x0:
            a = alpha_max
        else:
            k = (x - x0) / feather
            a = int(alpha_max * (1 - k) ** 1.4)
        ld.line([(x, 0), (x, H)], fill=max(0, min(255, a)))
    dark = Image.new("RGB", (W, H), (6, 10, 22))
    return Image.composite(dark, img, layer.point(lambda v: v))


def bottom_scrim(img, y0, alpha=150, feather=140):
    """底部横向渐暗罩"""
    layer = Image.new("L", (W, H), 0)
    ld = ImageDraw.Draw(layer)
    for y in range(y0, H + feather):
        if y < y0:
            a = 0
        else:
            k = min(1.0, (y - y0) / feather)
            a = int(alpha * k)
        ld.line([(0, y), (W, y)], fill=max(0, min(255, a)))
    dark = Image.new("RGB", (W, H), (6, 10, 22))
    return Image.composite(dark, img, layer)


def add_shadow(img, box, blur=18, alpha=110):
    """给文字区域加柔和阴影块"""
    x0, y0, x1, y1 = box
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle([x0 + 6, y0 + 8, x1 + 6, y1 + 8], radius=28,
                         fill=(0, 0, 0, alpha))
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    img = img.convert("RGBA")
    img.alpha_composite(sh)
    return img.convert("RGB")


def rect_scrim(img, box, alpha=150, feather=80, color=(6, 10, 22)):
    """矩形羽化暗罩 —— 用于压暗指定区域（如 AI 乱码区）
    box=(x0,y0,x1,y1)，feather=边缘羽化像素"""
    x0, y0, x1, y1 = box
    # 先造一个实心白矩形，再做模糊得到羽化 mask
    m = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(m)
    md.rectangle([x0, y0, x1, y1], fill=alpha)
    if feather > 0:
        # 用高斯模糊软化边缘（模糊量约为羽化半径）
        m = m.filter(ImageFilter.GaussianBlur(feather / 2.0))
    dark = Image.new("RGB", (W, H), color)
    return Image.composite(dark, img, m)


def rect_blur(img, box, blur=14, feather=90):
    """矩形羽化模糊 —— 柔化指定区域的乱码纹理（不加暗，保留氛围）
    box=(x0,y0,x1,y1)"""
    x0, y0, x1, y1 = box
    blurred = img.filter(ImageFilter.GaussianBlur(blur))
    # 羽化 mask
    m = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(m)
    md.rectangle([x0, y0, x1, y1], fill=255)
    if feather > 0:
        m = m.filter(ImageFilter.GaussianBlur(feather / 2.0))
    return Image.composite(blurred, img, m)


def compose(key):
    fname, outname = STYLES[key]
    bg_path = os.path.join(SRC, fname)
    if not os.path.exists(bg_path):
        print(f"❌ 缺底图: {bg_path}")
        return None
    img = Image.open(bg_path).convert("RGB")
    if img.size != (W, H):
        img = img.resize((W, H), Image.LANCZOS)

    # 左侧渐暗（给文字让路）
    img = left_scrim(img, x0=780, alpha_max=185, feather=320)
    # 底部渐暗（给角标让路）
    img = bottom_scrim(img, y0=870, alpha=155, feather=160)

    # ===== 每风格的额外处理（柔化 AI 乱码区 / 强化构图） =====
    if key == "D":
        # D 版：右侧书页乱码 —— 用「高斯模糊」柔化纹理（保留星云氛围），
        # 而非整块压暗（压暗会让右边发闷、有方块痕迹）
        img = rect_blur(img, (1290, 70, 1920, 760), blur=16, feather=200)
        # 只叠一层极轻的暗罩，降一点点对比，不做重压
        img = rect_scrim(img, (1360, 110, 1920, 700),
                         alpha=68, feather=190, color=(10, 12, 28))

    d = ImageDraw.Draw(img)

    # ============ 布局 ============
    LX = SAFE + 20           # 文字左边界
    top = 214                # 顶部起始

    # 1) 小标 —— 品类
    f_kicker = font(FONT_REG, 40)
    kick = "长 篇 网 络 小 说 · 创 作 管 理 软 件"
    draw_stroke_text(d, (LX, top), kick, f_kicker,
                     (230, 200, 140), (20, 24, 40), 3)
    top += 78

    # 2) 主标题 —— 产品名（两行，超大）
    f_title = font(FONT_BOLD, 132)
    t1, t2 = "青春幻想", "引擎"
    # 阴影
    draw_stroke_text(d, (LX + 5, top + 6), t1, f_title, (0, 0, 0), (0, 0, 0), 8)
    draw_stroke_text(d, (LX + 5, top + 6 + 168), t2, f_title, (0, 0, 0), (0, 0, 0), 8)
    # 正字（金渐变感：主字金 + 描边深）
    draw_stroke_text(d, (LX, top), t1, f_title, GOLD_LT, (60, 40, 10), 7)
    draw_stroke_text(d, (LX, top + 168), t2, f_title, GOLD_LT, (60, 40, 10), 7)
    top += 168 + 176

    # 3) 金色分隔线
    d.rectangle([LX, top, LX + 560, top + 5], fill=GOLD)
    top += 40

    # 4) 副标题（加大：缩略图下也要看得清）
    f_sub = font(FONT_BOLD, 68)
    sub = "10 大分组 · 55 个功能页签"
    draw_stroke_text(d, (LX, top), sub, f_sub, WHITE, (12, 16, 32), 5)
    top += 116

    # 5) 卖点条（加大）
    f_sell = font(FONT_BOLD, 52)
    sell = "设定不打架 · 伏笔不忘收 · 数据不丢失"
    draw_stroke_text(d, (LX, top), sell, f_sell, (222, 232, 250), (12, 16, 32), 4)

    # ============ 底部角标 ============
    f_tag = font(FONT_BOLD, 40)
    tag = "永久免费 · 开源 · 无广告无后门"
    tw, th = text_wh(d, tag, f_tag)
    bx0 = SAFE
    by0 = H - SAFE - 74
    d.rounded_rectangle([bx0, by0, bx0 + tw + 64, by0 + 74],
                        radius=37, fill=(0, 0, 0, 0),
                        outline=GOLD, width=3)
    draw_stroke_text(d, (bx0 + 32, by0 + 14), tag, f_tag, GOLD, (20, 24, 40), 3)

    # 右上角：v3.0
    f_ver = font(FONT_BOLD, 46)
    ver = "v3.0"
    vw, _ = text_wh(d, ver, f_ver)
    d.rounded_rectangle([W - SAFE - vw - 56, SAFE - 10, W - SAFE, SAFE + 64],
                        radius=16, fill=(0, 0, 0, 0), outline=GOLD, width=3)
    draw_stroke_text(d, (W - SAFE - vw - 28, SAFE + 2), ver, f_ver, GOLD,
                     (20, 24, 40), 3)

    out = os.path.join(OUT, outname + ".png")
    img.save(out, "PNG")
    print(f"✅ {out}")
    return out


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "all"
    keys = list(STYLES) if arg == "all" else [arg.upper()]
    for k in keys:
        compose(k)
