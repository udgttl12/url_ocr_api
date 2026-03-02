import argparse
import sys
import time
from pathlib import Path

import torch
from transformers import AutoModel, AutoTokenizer, BitsAndBytesConfig


def parse_bool(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def main() -> int:
    parser = argparse.ArgumentParser(description="Run DeepSeek-OCR-2 local OCR test")
    parser.add_argument("--model-dir", default="models/deepseek-ocr-2")
    parser.add_argument("--image", required=True)
    parser.add_argument("--out-dir", default="out/deepseek-ocr2-test")
    parser.add_argument("--device", default="auto", help="auto|cpu|cuda")
    parser.add_argument("--prompt", default="<image>\n<|grounding|>OCR this image.")
    parser.add_argument("--base-size", type=int, default=512)
    parser.add_argument("--image-size", type=int, default=512)
    parser.add_argument("--crop-mode", default="false")
    parser.add_argument("--max-new-tokens", type=int, default=256)
    parser.add_argument("--load-in-4bit", default="true")
    parser.add_argument("--device-map", default="cuda:0", help="cuda:0|auto")
    parser.add_argument("--attn-implementation", default="eager", help="eager|sdpa|flash_attention_2")
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    image_path = Path(args.image).resolve()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    if not model_dir.exists():
        raise FileNotFoundError(f"model dir not found: {model_dir}")
    if not image_path.exists():
        raise FileNotFoundError(f"image not found: {image_path}")

    if args.device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("device=cuda requested, but CUDA is not available")

    print(f"[info] model: {model_dir}")
    print(f"[info] image: {image_path}")
    print(f"[info] out: {out_dir}")
    print(f"[info] device: {device}")
    print(f"[info] torch: {torch.__version__}")

    t0 = time.time()
    tokenizer = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True)
    model_kwargs = {
        "trust_remote_code": True,
        "use_safetensors": True,
        "low_cpu_mem_usage": True,
    }
    load_in_4bit = parse_bool(args.load_in_4bit)
    if device == "cuda" and load_in_4bit:
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.float16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )
        model_kwargs["device_map"] = {"": "cuda:0"} if args.device_map != "auto" else "auto"
        model_kwargs["attn_implementation"] = args.attn_implementation
    elif device == "cuda":
        model_kwargs["torch_dtype"] = torch.float16
        model_kwargs["attn_implementation"] = args.attn_implementation

    model = AutoModel.from_pretrained(str(model_dir), **model_kwargs)
    if "device_map" in model_kwargs:
        model = model.eval()
    else:
        model = model.eval().to(device)
    t1 = time.time()
    print(f"[info] load_sec: {t1 - t0:.2f}")

    text = model.infer(
        tokenizer,
        prompt=args.prompt,
        image_file=str(image_path),
        output_path=str(out_dir),
        base_size=args.base_size,
        image_size=args.image_size,
        crop_mode=parse_bool(args.crop_mode),
        save_results=False,
        eval_mode=True,
        device=device,
        max_new_tokens=args.max_new_tokens,
    )
    t2 = time.time()
    print(f"[info] infer_sec: {t2 - t1:.2f}")

    result_path = out_dir / "result.txt"
    result_path.write_text((text or "").strip() + "\n", encoding="utf-8")
    print(f"[info] result: {result_path}")
    print("--- OCR OUTPUT (preview) ---")
    preview = (text or "").strip()
    if len(preview) > 1200:
        preview = preview[:1200] + "\n...[truncated]..."
    safe = preview.encode(sys.stdout.encoding or "utf-8", errors="replace").decode(
        sys.stdout.encoding or "utf-8",
        errors="replace",
    )
    print(safe)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
