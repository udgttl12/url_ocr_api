#!/usr/bin/env python
import argparse
import json
import re
import sys
import time
import warnings
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer, BitsAndBytesConfig
from transformers.utils import logging as hf_logging


def parse_bool(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


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

    model_kwargs = {
        "trust_remote_code": True,
        "use_safetensors": True,
        "low_cpu_mem_usage": True,
    }

    load_in_4bit = parse_bool(args.load_in_4bit)
    if (device == "cuda" or device.startswith("cuda:")) and load_in_4bit:
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
        model_kwargs["device_map"] = {"": "cuda:0"} if args.device_map != "auto" else "auto"
        model_kwargs["attn_implementation"] = args.attn_implementation
    elif device == "cuda" or device.startswith("cuda:"):
        model_kwargs["torch_dtype"] = torch.float16
        model_kwargs["attn_implementation"] = args.attn_implementation

    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
    model = AutoModel.from_pretrained(str(model_dir), **model_kwargs)
    model = model.eval()
    if "device_map" not in model_kwargs:
        model = model.to(device)
    load_sec = time.time() - t0

    results = []
    for image_path in images:
        started = time.time()
        try:
            raw_text = model.infer(
                tokenizer,
                prompt=args.prompt,
                image_file=image_path,
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

    payload = {
        "ok": True,
        "meta": {
            "modelDir": str(model_dir),
            "device": device,
            "loadSec": round(load_sec, 3),
            "loadIn4bit": load_in_4bit,
        },
        "results": results,
    }
    output_json.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(str(output_json))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
