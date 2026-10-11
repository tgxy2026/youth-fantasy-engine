# -*- coding: utf-8 -*-
"""
B 站封面 · 底图批量生成
链路：WAI (SDXL anime) checkpoint 直连 → KSampler → 1920x1080
用法：python gen_cover.py [A|B|C|D|all]
输出：底图/{风格}_{seed}.png
"""
import json, os, sys, time, urllib.request, urllib.parse, uuid, shutil

COMFY = "http://127.0.0.1:8188"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "底图")
RAW_DIR = r"D:\Program Files\ComfyUI\ComfyUI-Shared\output\B站封面"

W, H = 1920, 1080
CKPT = "waiIllustriousSDXL_v170.safetensors"

# 颉文姬形象锚点（统一）——严格单人、居中偏右构图，左侧留白给标题
CHAR = ("((1girl)), ((solo)), single character only, one person, "
        "long wavy orange hair, amber golden eyes, gentle smile, "
        "white and gold scholar robe, ancient chinese dress, gold embroidery, "
        "floral hair ornament, holding chinese calligraphy brush, ink brush, "
        "brush pen, book and scroll nearby, subject on the right side of frame, "
        "left side empty for text, ")

# 负面提示词（避免性感化 / 低质 / 多人）
NEG = ("nsfw, sexual, revealing clothes, cleavage, large breasts, bikini, "
       "2girls, multiple girls, two girls, twins, clone, duplicate, extra person, "
       "second girl, extra character, crowd, group, "
       "feather pen, quill, feather quill, "
       "lowres, bad anatomy, bad hands, extra fingers, missing fingers, "
       "text, watermark, signature, logo, username, worst quality, "
       "low quality, jpeg artifacts, deformed, ugly, distorted face, "
       "extra limbs, cropped, out of frame")

# 四个风格
STYLES = {
    "A": {
        "name": "A_曜金夜阁",
        "pos": CHAR + ("warm golden lighting, cozy ancient study room, massive wooden bookshelf "
                       "filled with books, tall arched window with starry night sky, floating "
                       "glowing golden particles, magical atmosphere, cinematic lighting, "
                       "masterpiece, best quality, highly detailed, anime illustration, "
                       "depth of field, warm color palette, deep blue and gold"),
        "seed": 5201,
    },
    "B": {
        "name": "B_青蓝书楼",
        "pos": CHAR + ("bright ancient chinese library pavilion, towering shelves of bamboo scrolls, "
                       "morning sunlight streaming through lattice windows, floating dust motes, "
                       "cyan and sky blue color scheme, tranquil scholarly atmosphere, "
                       "masterpiece, best quality, highly detailed, anime illustration, "
                       "cinematic lighting, soft rim light"),
        "seed": 5202,
    },
    "C": {
        "name": "C_翠玉秘境",
        "pos": CHAR + ("lush bamboo forest background, emerald green tones, soft mist, "
                       "floating glowing light motes and sparkles, sun rays through bamboo leaves, "
                       "clean composition, character occupying right half, ample empty space on left, "
                       "ethereal fantasy atmosphere, gold accents, "
                       "masterpiece, best quality, highly detailed, anime illustration, "
                       "cinematic soft lighting, vibrant green palette"),
        "seed": 5317,
    },
    "D": {
        "name": "D_紫霞星河",
        "pos": CHAR + ("dreamy starry sky cloud sea, purple and pink gold nebula, floating open "
                       "books and unrolling scrolls drifting in the air, glowing magical light, "
                       "surreal fantasy dreamscape, celestial atmosphere, "
                       "masterpiece, best quality, highly detailed, anime illustration, "
                       "cinematic lighting, soft glow"),
        "seed": 5204,
    },
}


def build_wf(style):
    """构建 SDXL 工作流"""
    return {
        "1": {"class_type": "CheckpointLoaderSimple",
              "inputs": {"ckpt_name": CKPT}},
        "2": {"class_type": "CLIPTextEncode",
              "inputs": {"text": style["pos"], "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode",
              "inputs": {"text": NEG, "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage",
              "inputs": {"width": W, "height": H, "batch_size": 1}},
        "5": {"class_type": "KSampler",
              "inputs": {
                  "seed": style["seed"], "steps": 30, "cfg": 7.0,
                  "sampler_name": "dpmpp_2m", "scheduler": "karras",
                  "denoise": 1.0, "model": ["1", 0],
                  "positive": ["2", 0], "negative": ["3", 0],
                  "latent_image": ["4", 0]}},
        "6": {"class_type": "VAEDecode",
              "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage",
              "inputs": {"images": ["6", 0], "filename_prefix": "B站封面/" + style["name"]}},
    }


def post(wf):
    data = json.dumps({"prompt": wf, "client_id": str(uuid.uuid4())}).encode()
    req = urllib.request.Request(COMFY + "/prompt", data=data,
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def wait(pid, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            r = json.loads(urllib.request.urlopen(
                COMFY + "/history/" + pid, timeout=10).read())
            if pid in r:
                st = r[pid].get("status", {})
                if st.get("completed") or st.get("status_str") == "success":
                    return r[pid]
                if st.get("status_str") == "error":
                    return {"error": st}
        except Exception:
            pass
        time.sleep(3)
    return {"error": "timeout"}


def collect(name, seed, hist):
    """把 ComfyUI 输出拷到 底图/"""
    outs = hist.get("outputs", {})
    for node in outs.values():
        for im in node.get("images", []):
            src = os.path.join(RAW_DIR, im["filename"])
            if os.path.exists(src):
                dst = os.path.join(OUT, f"{name}_seed{seed}.png")
                shutil.copyfile(src, dst)
                return dst
    return None


def run(key):
    st = STYLES[key]
    print(f"[{key}] {st['name']} seed={st['seed']} ...", flush=True)
    try:
        res = post(build_wf(st))
    except Exception as e:
        print(f"  提交失败: {e}"); return False
    pid = res.get("prompt_id")
    if not pid:
        print(f"  无 prompt_id: {res}"); return False
    hist = wait(pid)
    if "error" in hist:
        print(f"  生成失败: {hist['error']}"); return False
    p = collect(st["name"], st["seed"], hist)
    print(f"  ✅ {p}" if p else "  ⚠️ 输出未找到")
    return bool(p)


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else "all"
    keys = list(STYLES) if arg == "all" else [arg.upper()]
    for k in keys:
        run(k)
