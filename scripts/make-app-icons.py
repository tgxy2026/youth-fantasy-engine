#!/usr/bin/env python3
# ============ 应用图标生成器（3.1.2 · 桌面图标切换）============
#
# 【它做什么】把三套图源统一成**视觉尺寸一致**的多尺寸 .ico，供运行期切换桌面快捷方式图标：
#   electron/icons/default.ico  —— 默认（由既有 build/icon.ico 的 256 图重制）
#   electron/icons/fantasy.ico  —— 幻想（主人提供的图 1）
#   electron/icons/elegant.ico  —— 典雅（主人提供的图 3）
#
# 【为什么要写这个脚本，而不是随手转一次】
#   🔴 主人明确要求：**三套图标在桌面上看起来要一样大**（原先默认图标偏小）。
#      「看起来一样大」不能靠「三张图都缩到 256」—— 三张图各自的留白 / 光晕范围不同，
#      直接缩会得到三个视觉重量不一的图标。正确做法是**按内容外接框归一化**：
#      先算 alpha 有效区域（阈值去微弱光晕），再把该区域等比缩放到统一占比后居中放回画布。
#   🔴 本机零依赖政策：**只用 Python 标准库**（zlib/struct）。Pillow 在本环境装不上（No matching distribution），
#      故这里自写 PNG 解码 + 面积平均缩放 + ICO 编解码。
#
# 【用法】
#   python scripts/make-app-icons.py                     # 生成三套 .ico 到 electron/icons/
#   python scripts/make-app-icons.py --analyze           # 只打印三张源图的 bbox / 占比（不改文件）
#   python scripts/make-app-icons.py --ratio 0.90        # 调整统一占比（默认 0.92）
#   python scripts/make-app-icons.py --preview .workbuddy/tmp/icon-preview  # 另存 256 PNG 便于肉眼对比
#
# 【产出规格】256 / 128 / 64 / 48 / 32 / 24 / 16 七档；
#   256 用 PNG 条目（体积小），其余用 32bpp BMP 条目（老 shell 兼容性最好）。
import argparse
import os
import struct
import sys
import zlib

# ---------- PNG 解码（仅支持 8bit RGBA/RGB，本项目的源图即此形态）----------

def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def decode_png(path):
    """返回 (width, height, bytearray RGBA)。"""
    with open(path, 'rb') as f:
        data = f.read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'{path}: 不是 PNG')
    pos = 8
    w = h = bd = ct = None
    idat = bytearray()
    while pos < len(data):
        (ln,) = struct.unpack('>I', data[pos:pos + 4])
        typ = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct, _comp, _filt, inter = struct.unpack('>IIBBBBB', chunk)
            if bd != 8 or inter != 0:
                raise ValueError(f'{path}: 仅支持 8bit 非隔行（实际 bd={bd} interlace={inter}）')
            if ct not in (2, 6):
                raise ValueError(f'{path}: 仅支持 RGB/RGBA（实际 colortype={ct}）')
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
    if w is None:
        raise ValueError(f'{path}: 缺 IHDR')
    ch = 4 if ct == 6 else 3
    raw = zlib.decompress(bytes(idat))
    stride = w * ch
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if ft == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                c = prev[i - ch] if i >= ch else 0
                line[i] = (line[i] + _paeth(a, prev[i], c)) & 0xFF
        elif ft != 0:
            raise ValueError(f'{path}: 未知 filter {ft}')
        prev = line
        if ch == 4:
            out[y * w * 4:(y + 1) * w * 4] = line
        else:
            row = y * w * 4
            for x in range(w):
                s = x * 3
                d = row + x * 4
                out[d] = line[s]
                out[d + 1] = line[s + 1]
                out[d + 2] = line[s + 2]
                out[d + 3] = 255
    return w, h, out


# ---------- ICO 读取（取既有 icon.ico 里的 256 源图）----------

def read_ico_largest(path):
    """返回 (width, height, bytearray RGBA) —— ICO 里尺寸最大的那一条。"""
    with open(path, 'rb') as f:
        data = f.read()
    _res, typ, cnt = struct.unpack('<HHH', data[:6])
    if typ != 1:
        raise ValueError(f'{path}: 不是 ICO')
    best = None
    for i in range(cnt):
        off = 6 + i * 16
        w, h, _cc, _rs, _pl, bpp, size, offset = struct.unpack('<BBBBHHII', data[off:off + 16])
        w = w or 256
        h = h or 256
        blob = data[offset:offset + size]
        if blob[:8] == b'\x89PNG\r\n\x1a\n':
            img = _decode_png_bytes(blob)
        else:
            img = _decode_ico_bmp(blob, w, h, bpp)
        if best is None or w * h > best[0] * best[1]:
            best = img
    if best is None:
        raise ValueError(f'{path}: 没有可用图像')
    return best


def _decode_png_bytes(blob):
    import io
    tmp = io.BytesIO(blob)
    # 复用 decode_png 的逻辑：写临时文件太重，这里直接内联最小实现
    pos = 8
    w = h = None
    idat = bytearray()
    while pos < len(blob):
        (ln,) = struct.unpack('>I', blob[pos:pos + 4])
        typ = blob[pos + 4:pos + 8]
        chunk = blob[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct, _c, _f, inter = struct.unpack('>IIBBBBB', chunk)
            ch = 4 if ct == 6 else 3
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
    raw = zlib.decompress(bytes(idat))
    stride = w * ch
    out = bytearray(w * h * 4)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        ft = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if ft == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif ft == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                c = prev[i - ch] if i >= ch else 0
                line[i] = (line[i] + _paeth(a, prev[i], c)) & 0xFF
        prev = line
        if ch == 4:
            out[y * w * 4:(y + 1) * w * 4] = line
        else:
            for x in range(w):
                s = x * 3; d = y * w * 4 + x * 4
                out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255
    tmp.close()
    return w, h, out


def _decode_ico_bmp(blob, w, h, bpp):
    """ICO 内嵌 BMP：BITMAPINFOHEADER(40) + 自底向上 BGRA + AND mask。"""
    if bpp not in (32, 24):
        raise ValueError(f'ICO BMP 仅支持 24/32bpp（实际 {bpp}）')
    pixel_off = 40
    stride = w * (bpp // 8)
    pad = (-stride) % 4
    out = bytearray(w * h * 4)
    for y in range(h):
        src = pixel_off + (h - 1 - y) * (stride + pad)
        d = y * w * 4
        for x in range(w):
            s = src + x * (bpp // 8)
            if bpp == 32:
                b, g, r, a = blob[s], blob[s + 1], blob[s + 2], blob[s + 3]
            else:
                b, g, r = blob[s], blob[s + 1], blob[s + 2]
                a = 255
            o = d + x * 4
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a
    return w, h, out


# ---------- 归一化（内容外接框 → 统一占比）----------

def content_bbox(w, h, rgba, thresh):
    """alpha > thresh 的外接框；找不到则整幅。"""
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        row = y * w * 4
        for x in range(w):
            if rgba[row + x * 4 + 3] > thresh:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    if maxx < 0:
        return 0, 0, w - 1, h - 1
    return minx, miny, maxx, maxy


def scale_into(src_w, src_h, src, box, out_size, ratio, thresh):
    """把 box 区域等比缩放到 out_size*ratio 后居中放进 out_size 透明画布。"""
    bx0, by0, bx1, by1 = box
    bw = bx1 - bx0 + 1
    bh = by1 - by0 + 1
    side = max(bw, bh)
    target = max(1, int(round(out_size * ratio)))
    scale = target / side
    canvas = bytearray(out_size * out_size * 4)
    # 目标区域起点（居中）
    dst_w = max(1, int(round(bw * scale)))
    dst_h = max(1, int(round(bh * scale)))
    ox = (out_size - dst_w) // 2
    oy = (out_size - dst_h) // 2
    for dy in range(dst_h):
        sy0 = by0 + int(dy / scale)
        sy1 = min(by1 + 1, by0 + max(sy0 - by0 + 1, int((dy + 1) / scale)))
        if sy1 <= sy0:
            sy1 = sy0 + 1
        for dx in range(dst_w):
            sx0 = bx0 + int(dx / scale)
            sx1 = min(bx1 + 1, bx0 + max(sx0 - bx0 + 1, int((dx + 1) / scale)))
            if sx1 <= sx0:
                sx1 = sx0 + 1
            r = g = b = a = n = 0
            for yy in range(sy0, sy1):
                base = yy * src_w * 4
                for xx in range(sx0, sx1):
                    o = base + xx * 4
                    r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3]
                    n += 1
            if n == 0:
                continue
            d = ((oy + dy) * out_size + (ox + dx)) * 4
            canvas[d] = r // n
            canvas[d + 1] = g // n
            canvas[d + 2] = b // n
            canvas[d + 3] = a // n
    return canvas


# ---------- ICO 写出 ----------

def _png_bytes(w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += rgba[y * w * 4:(y + 1) * w * 4]
    def chunk(typ, payload):
        return (struct.pack('>I', len(payload)) + typ + payload +
                struct.pack('>I', zlib.crc32(typ + payload) & 0xFFFFFFFF))
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
            chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))


def _bmp_entry_bytes(w, h, rgba):
    """32bpp BMP 条目：BITMAPINFOHEADER + 自底向上 BGRA + AND mask（全 0）。"""
    stride = w * 4
    pad = (-stride) % 4
    px = bytearray()
    for y in range(h - 1, -1, -1):
        row = y * w * 4
        for x in range(w):
            o = row + x * 4
            px += bytes((rgba[o + 2], rgba[o + 1], rgba[o], rgba[o + 3]))
        px += b'\x00' * pad
    mask_stride = ((w + 31) // 32) * 4
    mask = b'\x00' * (mask_stride * h)
    header = struct.pack('<IiiHHIIiiII', 40, w, h * 2, 1, 32, 0, len(px) + len(mask), 0, 0, 0, 0)
    return bytes(header) + bytes(px) + mask


def write_ico(path, images):
    """images: [(size, rgba)]，按尺寸从大到小给出。"""
    entries = []
    blobs = []
    offset = 6 + 16 * len(images)
    for size, rgba in images:
        blob = _png_bytes(size, size, rgba) if size >= 256 else _bmp_entry_bytes(size, size, rgba)
        entries.append((size, len(blob), offset))
        blobs.append(blob)
        offset += len(blob)
    out = bytearray(struct.pack('<HHH', 0, 1, len(images)))
    for size, ln, off in entries:
        out += struct.pack('<BBBBHHII', 0 if size >= 256 else size, 0 if size >= 256 else size,
                           0, 0, 1, 32, ln, off)
    for blob in blobs:
        out += blob
    with open(path, 'wb') as f:
        f.write(bytes(out))
    return len(out)


SIZES = [256, 128, 64, 48, 32, 24, 16]


def build_one(label, w, h, rgba, out_path, ratio, thresh, preview_dir=None):
    box = content_bbox(w, h, rgba, thresh)
    bw = box[2] - box[0] + 1
    bh = box[3] - box[1] + 1
    print(f'  {label}: 源 {w}x{h} · 内容框 {bw}x{bh} '
          f'(占比 {bw / w:.0%} x {bh / h:.0%})')
    imgs = []
    for s in SIZES:
        imgs.append((s, scale_into(w, h, rgba, box, s, ratio, thresh)))
    n = write_ico(out_path, imgs)
    print(f'    → {os.path.relpath(out_path)}（{n} 字节，{"/".join(str(s) for s in SIZES)}）')
    if preview_dir:
        os.makedirs(preview_dir, exist_ok=True)
        pv = os.path.join(preview_dir, f'{label}-256.png')
        with open(pv, 'wb') as f:
            f.write(_png_bytes(256, 256, imgs[0][1]))
        pv2 = os.path.join(preview_dir, f'{label}-48.png')
        with open(pv2, 'wb') as f:
            f.write(_png_bytes(48, 48, [img for sz, img in imgs if sz == 48][0]))
        print(f'    预览 → {os.path.relpath(pv)}')
    return box


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ratio', type=float, default=0.92, help='内容占画布比例（视觉统一的关键）')
    ap.add_argument('--thresh', type=int, default=64, help='alpha 阈值（去微弱光晕）')
    ap.add_argument('--analyze', action='store_true')
    ap.add_argument('--preview', default=None)
    args = ap.parse_args()

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    src = {
        'default': ('ico', os.path.join(root, 'build', 'icon.ico')),
        'fantasy': ('png', r'C:\Users\18223\Downloads\青春幻想引擎图标 (1).png'),
        'elegant': ('png', r'C:\Users\18223\Downloads\青春幻想引擎图标 (3).png'),
    }
    out_dir = os.path.join(root, 'electron', 'icons')

    if args.analyze:
        print('—— 源图分析（alpha 阈值 %d）——' % args.thresh)
    else:
        os.makedirs(out_dir, exist_ok=True)
        print('—— 生成应用图标（统一占比 %.0f%% · alpha 阈值 %d）——' % (args.ratio * 100, args.thresh))

    for label, (kind, path) in src.items():
        if not os.path.exists(path):
            print(f'  {label}: 源文件不存在（{path}）', file=sys.stderr)
            return 2
        if kind == 'png':
            w, h, rgba = decode_png(path)
        else:
            w, h, rgba = read_ico_largest(path)
        if args.analyze:
            box = content_bbox(w, h, rgba, args.thresh)
            print(f'  {label}: {w}x{h} · 内容 {box[2] - box[0] + 1}x{box[3] - box[1] + 1} · '
                  f'左下角 alpha={rgba[(h - 1) * w * 4 + 3]} 四角 '
                  f'{rgba[3]},{rgba[(w - 1) * 4 + 3]},{rgba[(h - 1) * w * 4 + 3]},{rgba[(h - 1) * w * 4 + (w - 1) * 4 + 3]}')
        else:
            build_one(label, w, h, rgba, os.path.join(out_dir, f'{label}.ico'),
                      args.ratio, args.thresh, args.preview)

    if not args.analyze:
        print('完成。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
