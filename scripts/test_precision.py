#!/usr/bin/env python
"""Test attention precision variants and capture logit margins."""
import sys, json, re, time, warnings, contextlib
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
warnings.filterwarnings("ignore")

import torch
from transformers import AutoModel, AutoTokenizer
from transformers.utils import logging as hf_logging
hf_logging.set_verbosity_error()

MODEL_DIR = "models/deepseek-ocr-2"
IMAGE = "out/test-normal/assets/preprocessed/img-001.png"

# Problem characters to watch
WATCH_CHARS = {"용", "융", "감", "갑", "재", "제", "질", "킬"}


def clean_output(text):
    if not text:
        return ""
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    t = re.sub(r"<\|ref\|>.*?<\|/ref\|><\|det\|>.*?<\|/det\|>\s*", "", t, flags=re.DOTALL)
    lines = [line.strip() for line in t.split("\n") if line.strip()]
    return "\n".join(lines).strip()


def run_test(label, setup_fn):
    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"{'='*60}")

    setup_fn()

    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR, trust_remote_code=True)
    model = AutoModel.from_pretrained(
        MODEL_DIR,
        trust_remote_code=True,
        use_safetensors=True,
        low_cpu_mem_usage=True,
        torch_dtype=torch.bfloat16,
        attn_implementation="eager",
    )
    model = model.eval().cuda()

    # Hook lm_head to capture logit margins at each generation step
    margins = []
    original_lm_head_forward = model.lm_head.forward

    def hooked_lm_head(input_tensor):
        logits = original_lm_head_forward(input_tensor)
        # Only look at last token position (the one being generated)
        last_logits = logits[:, -1, :].float()
        top5 = torch.topk(last_logits, 5, dim=-1)

        top1_id = top5.indices[0, 0].item()
        top1_tok = tokenizer.decode([top1_id])

        # Log if it involves a watched character
        if any(c in top1_tok for c in WATCH_CHARS) or \
           any(any(c in tokenizer.decode([top5.indices[0, i].item()]) for c in WATCH_CHARS) for i in range(1, 5)):
            entry = []
            for i in range(5):
                tid = top5.indices[0, i].item()
                tok = tokenizer.decode([tid])
                val = top5.values[0, i].item()
                entry.append({"tok": tok, "val": round(val, 4), "id": tid})
            margin = entry[0]["val"] - entry[1]["val"]
            margins.append({"top5": entry, "margin": round(margin, 4)})
        return logits

    model.lm_head.forward = hooked_lm_head

    t0 = time.time()
    result = model.infer(
        tokenizer,
        prompt="<image>\n<|grounding|>Convert the document to markdown.",
        image_file=IMAGE,
        output_path="out/test-precision",
        base_size=1024,
        image_size=768,
        crop_mode=True,
        save_results=False,
        eval_mode=True,
        device="cuda",
        max_new_tokens=1200,
    )
    elapsed = time.time() - t0

    # Restore
    model.lm_head.forward = original_lm_head_forward

    cleaned = clean_output(result or "")
    print(f"  소요: {elapsed:.1f}초")
    print(f"  텍스트 길이: {len(cleaned)}")

    # Show problem characters with top-5 logits
    for m in margins:
        flag = "⚠️" if m["margin"] < 1.0 else "✅"
        t = m["top5"]
        line = f'  {flag} margin={m["margin"]:6.3f} | '
        line += " > ".join(f'"{e["tok"]}"({e["val"]:.2f})' for e in t[:4])
        print(line)

    # Cleanup
    del model
    torch.cuda.empty_cache()

    return cleaned, margins


# Test 1: baseline bf16 (current)
def setup_baseline():
    torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = True
    torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = True
    torch.backends.cuda.matmul.allow_tf32 = False

text1, m1 = run_test("bf16 baseline (reduction ON)", setup_baseline)


# Test 2: bf16 with ALL reduced precision OFF
def setup_no_reduction():
    torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
    torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cuda.allow_fp16_bf16_reduction_math_sdp(False)

text2, m2 = run_test("bf16 + ALL reduction OFF", setup_no_reduction)


# Test 3: fp32 matmul precision highest + reduction OFF
def setup_fp32_highest():
    torch.set_float32_matmul_precision("highest")
    torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
    torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cuda.allow_fp16_bf16_reduction_math_sdp(False)
    torch.backends.cudnn.deterministic = True

text3, m3 = run_test("bf16 + reduction OFF + deterministic", setup_fp32_highest)


# Compare
print(f"\n{'='*60}")
print("  COMPARISON")
print(f"{'='*60}")
if text1 == text2:
    print("  baseline == reduction OFF: IDENTICAL")
else:
    print("  baseline != reduction OFF: DIFFERENT!")
if text1 == text3:
    print("  baseline == deterministic: IDENTICAL")
else:
    print("  baseline != deterministic: DIFFERENT!")
if text2 == text3:
    print("  reduction OFF == deterministic: IDENTICAL")
else:
    print("  reduction OFF != deterministic: DIFFERENT!")
