#!/usr/bin/env python
import argparse
import json
import re
import sys
import tempfile
import time
import warnings
from pathlib import Path

import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer, BitsAndBytesConfig
from transformers.utils import logging as hf_logging


def parse_bool(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def enhance_image(image_path: str, scale: float = 2.0) -> str:
    """Enhance image for better OCR: upsample + CLAHE + sharpen. Returns temp file path."""
    import cv2

    img = cv2.imread(image_path)
    if img is None:
        return image_path

    # 1) Upsample with INTER_CUBIC
    img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)

    # 2) CLAHE on L channel (preserve color structure for model)
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l = clahe.apply(l)
    lab = cv2.merge([l, a, b])
    img = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    # 3) Mild sharpen
    kernel = np.array([[0, -1, 0], [-1, 5, -1], [0, -1, 0]], dtype=np.float32)
    img = cv2.filter2D(img, -1, kernel)

    # Save to temp file
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    cv2.imwrite(tmp.name, img)
    tmp.close()
    return tmp.name


def clean_output(text: str) -> str:
    if not text:
        return ""
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"<\|ref\|>.*?<\|/ref\|><\|det\|>.*?<\|/det\|>\s*", "", t, flags=re.DOTALL)
    lines = [line.strip() for line in t.split("\n") if line.strip()]

    merged = []
    i = 0
    while i < len(lines):
        cur = lines[i]
        while i + 1 < len(lines):
            nxt = lines[i + 1]
            if re.fullmatch(r"[A-Za-z0-9\uac00-\ud7a3]{1,2}", nxt) and re.search(
                r"[A-Za-z0-9\uac00-\ud7a3]$",
                cur,
            ):
                cur += nxt
                i += 1
            else:
                break
        merged.append(cur)
        i += 1

    return "\n".join(merged).strip()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    warnings.filterwarnings("ignore")
    hf_logging.set_verbosity_error()

    parser = argparse.ArgumentParser(description="DeepSeek OCR2 batch runner")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--images", nargs="+", required=True)
    parser.add_argument("--output-json", required=True)
    parser.add_argument("--prompt", default="<image>\n<|grounding|>Convert the document to markdown.")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--device-map", default="cuda:0")
    parser.add_argument("--load-in-4bit", default="true")
    parser.add_argument("--attn-implementation", default="eager")
    parser.add_argument("--base-size", type=int, default=1024)
    parser.add_argument("--image-size", type=int, default=768)
    parser.add_argument("--crop-mode", default="true")
    parser.add_argument("--max-new-tokens", type=int, default=900)
    parser.add_argument("--enhance", default="false")
    parser.add_argument("--enhance-scale", type=float, default=2.0)
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    output_json = Path(args.output_json).resolve()
    output_json.parent.mkdir(parents=True, exist_ok=True)

    def fail(message: str) -> int:
        output_json.write_text(
            json.dumps(
                {
                    "ok": False,
                    "error": message,
                    "results": [],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return 1

    images = [str(Path(p).resolve()) for p in args.images]
    missing = [p for p in images if not Path(p).exists()]
    if missing:
        return fail(f"missing images: {missing}")

    if not model_dir.exists():
        return fail(f"model dir not found: {model_dir}")

    cuda_available = torch.cuda.is_available()
    requested_device = str(args.device).strip().lower()
    if requested_device == "auto":
        device = "cuda" if cuda_available else "cpu"
    else:
        device = requested_device

    if not (device == "cuda" or device.startswith("cuda:")):
        return fail(f"DeepSeek OCR requires CUDA device, got '{args.device}'")
    if not cuda_available:
        return fail("DeepSeek OCR requires CUDA, but torch.cuda.is_available() is False")

    # Disable reduced-precision reduction to prevent boundary-value corruption
    torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
    torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False

    model_kwargs = {
        "trust_remote_code": True,
        "use_safetensors": True,
        "low_cpu_mem_usage": True,
    }

    load_in_4bit = parse_bool(args.load_in_4bit)
    if (device == "cuda" or device.startswith("cuda:")) and load_in_4bit:
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
        model_kwargs["device_map"] = {"": "cuda:0"} if args.device_map != "auto" else "auto"
        model_kwargs["attn_implementation"] = args.attn_implementation
    elif device == "cuda" or device.startswith("cuda:"):
        model_kwargs["torch_dtype"] = torch.bfloat16
        model_kwargs["attn_implementation"] = args.attn_implementation

    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
    model = AutoModel.from_pretrained(str(model_dir), **model_kwargs)
    model = model.eval()
    if "device_map" not in model_kwargs:
        model = model.to(device)
    load_sec = time.time() - t0

    do_enhance = parse_bool(args.enhance)
    enhance_temps = []

    results = []
    for image_path in images:
        started = time.time()
        actual_path = image_path
        if do_enhance:
            actual_path = enhance_image(image_path, args.enhance_scale)
            if actual_path != image_path:
                enhance_temps.append(actual_path)
        try:
            raw_text = model.infer(
                tokenizer,
                prompt=args.prompt,
                image_file=actual_path,
                output_path=str(output_json.parent),
                base_size=args.base_size,
                image_size=args.image_size,
                crop_mode=parse_bool(args.crop_mode),
                save_results=False,
                eval_mode=True,
                device=device,
                max_new_tokens=args.max_new_tokens,
            )
            cleaned = clean_output(raw_text or "")
            results.append(
                {
                    "image": image_path,
                    "text": cleaned,
                    "error": "",
                    "inferSec": round(time.time() - started, 3),
                }
            )
        except Exception as err:
            results.append(
                {
                    "image": image_path,
                    "text": "",
                    "error": str(err),
                    "inferSec": round(time.time() - started, 3),
                }
            )

    # Cleanup enhanced temp files
    for tmp_path in enhance_temps:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except OSError:
            pass

    payload = {
        "ok": True,
        "meta": {
            "modelDir": str(model_dir),
            "device": device,
            "loadSec": round(load_sec, 3),
            "loadIn4bit": load_in_4bit,
            "enhanced": do_enhance,
        },
        "results": results,
    }
    output_json.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(str(output_json))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
