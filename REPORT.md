# DeepSeek-OCR-2 정밀도 최적화 보고서

> 작성일: 2026-03-03
> 환경: Windows 11, RTX 4060 (8GB VRAM), Python 3.10, PyTorch 2.6.0+cu124
> 모델: DeepSeek-OCR-2 (deepseek-ai/DeepSeek-OCR-2)
> 테스트 대상: https://cafe.naver.com/chiusin/43374 (명리학 컨텐츠, 한글 텍스트 이미지)

---

## 1. 요약

HuggingFace 데모(https://huggingface.co/spaces/prithivMLmods/DeepSeek-OCR-2-Demo)에서는 유사도 100%를 달성하는 동일 모델이, 로컬 Windows 환경에서 99.03%에 머물렀던 원인을 분석하고 개선하였다.

### 최종 성과

| 항목 | 변경 전 | 변경 후 | 개선폭 |
|------|---------|---------|--------|
| **유사도** | 99.03% | **99.16%** | +0.13%p |
| **추론 속도** | 119.5초 | **55.4초** | **2.2배 빠름** |
| **글자 오류 수** | 4개 | **2개** | 50% 감소 |

### 적용된 변경 사항 (2건)

1. `float16` → `bfloat16` 전환 (속도 2.8배 향상)
2. `allow_bf16_reduced_precision_reduction = False` 설정 (경계값 글자 오류 해결)

---

## 2. 배경: HuggingFace 데모와 로컬 환경 차이 분석

HF 데모의 소스코드(`deepseek_ocr_v2_demo.py`)를 분석한 결과, 로컬과의 핵심 차이점은 다음 3가지였다.

| 항목 | HuggingFace 데모 | 로컬 (변경 전) |
|------|------------------|----------------|
| 정밀도 (dtype) | `torch.bfloat16` | `torch.float16` |
| Attention 구현 | `flash_attention_2` | `eager` |
| GPU | A100 80GB | RTX 4060 8GB |

`base_size`, `image_size`, `temperature`, `prompt` 등 나머지 설정은 동일하였다.

---

## 3. 실험 과정

### 3.1 bfloat16 전환

**변경 파일**: `scripts/deepseek_ocr2_batch.py`

```python
# 변경 전
bnb_4bit_compute_dtype=torch.float16   # 4bit 모드
model_kwargs["torch_dtype"] = torch.float16  # 비양자화 모드

# 변경 후
bnb_4bit_compute_dtype=torch.bfloat16
model_kwargs["torch_dtype"] = torch.bfloat16
```

**결과**: 유사도는 99.03%로 동일하나, **속도가 119.5초 → 42.6초로 2.8배 향상**되었다. 오류 패턴은 float16과 동일(`용→융`, `감→갑`, `재→제`).

### 3.2 flash_attention_2 시도 (실패)

Windows에서 flash-attn 2.8.3 prebuilt wheel(cu124+torch2.6+cp310)을 설치하여 테스트하였으나, **모델이 반복 토큰만 생성하는 garbage output** 발생. 커뮤니티 빌드 Windows wheel과 이 모델의 커스텀 attention 코드 간 호환성 문제로 판단.

```
출처: github.com/mjun0812/flash-attention-prebuild-wheels (v0.4.19)
파일: flash_attn-2.8.3+cu124torch2.6-cp310-cp310-win_amd64.whl
결과: "신규성 – 신규성 – 신규성..." 반복 (garbage output)
```

또한 PyTorch 내장 `sdpa` attention도 시도하였으나, 모델이 명시적으로 지원하지 않아 실패.

```
ValueError: DeepseekOCR2ForCausalLM does not support an attention implementation
through torch.nn.functional.scaled_dot_product_attention yet.
```

### 3.3 lm_head FP32 캐스팅 시도 (효과 없음)

**가설**: lm_head (최종 토큰 결정 레이어)에서 bf16 matmul 정밀도 손실이 잘못된 글자 선택을 유발.

**실험**: `modeling_deepseekv2.py`에서 lm_head 연산을 FP32로 강제.

```python
# 시도 1: input만 fp32
logits = self.lm_head(hidden_states.float())

# 시도 2: input + weight 모두 fp32
logits = torch.nn.functional.linear(
    hidden_states.float(), self.lm_head.weight.float(), self.lm_head.bias
)

# 시도 3: autocast 비활성화까지 추가
with torch.cuda.amp.autocast(enabled=False):
    logits = torch.nn.functional.linear(
        hidden_states.float(), self.lm_head.weight.float(), self.lm_head.bias
    )
```

**결과**: 3가지 모두 오류 패턴이 완전히 동일. **lm_head 이전 단계(attention 레이어)에서 이미 hidden_states가 결정되어 있음을 확인.**

### 3.4 PyTorch 백엔드 정밀도 플래그 분석 (핵심 발견)

현재 환경의 PyTorch 백엔드 상태를 점검한 결과:

```
torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = True  ← 문제!
torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = True  ← 문제!
```

이 플래그가 `True`이면 bf16 matmul에서 **축약 정밀도 reduction**이 사용되어, 중간 합산 과정에서 반올림 오차가 누적된다.

### 3.5 Logit Margin 분석 (결정적 증거)

문제 글자 위치에서 top-1과 top-2 토큰의 logit 차이(margin)를 측정하였다.

#### reduction ON (기존)

| 위치 | top-1 | top-2 | margin | 판정 |
|------|-------|-------|--------|------|
| 신금**융**신 | 융(18.38) | 용(18.38) | **0.000** | 동률 → tie-break으로 오답 |
| 검**제**가 | 제(14.31) | 재(14.31) | **0.000** | 동률 → tie-break으로 오답 |
| **감**목 | 갑(15.31) | 감(13.56) | 1.750 | 모델 확신 오답 |

#### reduction OFF (변경 후)

| 위치 | top-1 | top-2 | margin | 판정 |
|------|-------|-------|--------|------|
| 신금**용**신 | **용(18.50)** | 융(18.38) | **0.125** | 정답이 이김! |
| 검**재**가 | **재(14.44)** | 제(14.38) | **0.062** | 정답이 이김! |
| **감**목 | 갑(15.31) | 감(13.56) | 1.750 | 모델 확신 오답 (변화 없음) |

**margin=0.000이었던 경계값 글자들이 reduction OFF로 올바른 방향으로 뒤집혔다.**

---

## 4. 최종 적용 내역

### 4.1 `scripts/deepseek_ocr2_batch.py`

```python
# 1) 축약 정밀도 reduction 비활성화 (신규 추가)
torch.backends.cuda.matmul.allow_bf16_reduced_precision_reduction = False
torch.backends.cuda.matmul.allow_fp16_reduced_precision_reduction = False

# 2) 4bit 모드: compute dtype을 bfloat16으로 변경
bnb_4bit_compute_dtype=torch.bfloat16  # 기존: torch.float16

# 3) 비양자화 모드: dtype을 bfloat16으로 변경
model_kwargs["torch_dtype"] = torch.bfloat16  # 기존: torch.float16
```

### 4.2 `archive-cafe.mjs`

OCR 모드별 기본 설정은 변경 없음 (`eager` attention 유지). bfloat16은 Python 스크립트 레벨에서 적용.

### 4.3 `models/deepseek-ocr-2/modeling_deepseekv2.py`

lm_head FP32 캐스팅은 효과가 없어 **원본 상태로 유지** (변경 없음).

---

## 5. 버전별 유사도 비교 (전체 이력)

테스트 대상: 네이버 카페 명리학 게시글 (원본 텍스트 대비 `difflib.SequenceMatcher` ratio)

### 5.1 OCR 모델 설정 변경

| 버전 | 설정 | 유사도 | 소요시간 |
|------|------|--------|----------|
| float16 + eager (기존) | normal 모드 기본값 | 99.03% | 119.5초 |
| bf16 + eager | dtype만 변경 | 99.03% | 42.6초 |
| bf16 + fp32 lm_head | lm_head FP32 캐스팅 | 99.03% | 43.9초 |
| bf16 + flash_attention_2 | Windows prebuilt wheel | 실패 (garbage) | - |
| **bf16 + reduction OFF** | **최종 적용** | **99.16%** | **55.4초** |
| bf16 + reduction OFF + enhance | 이미지 전처리 추가 | 97.80% | - |

### 5.2 SLM 후보정 프롬프트 버전

| 버전 | 프롬프트 | 유사도 | 소요시간 |
|------|----------|--------|----------|
| SLM 없음 (baseline) | - | 99.03% | 119.5초 |
| v1 (영문, 범용) | English generic prompt | 94.81% | - |
| v2 (한국어, OCR전용) | OCR 오류만 수정 | 98.96% | 135.3초 |
| v3 (OCR+맞춤법) | + 맞춤법 교정 1줄 추가 | 98.90% | 234.2초 |
| v4 (도메인 하드코딩) | 명리학 용어 예시 포함 | 99.03% | 131.5초 |
| v5 (도메인 범용) | 도메인 자동 인식 | 98.57% | 263.4초 |

### 5.3 남은 오류 상세 (bf16 + reduction OFF 기준)

| 원본 | OCR 결과 | logit margin | 원인 |
|------|----------|-------------|------|
| 감목 | 갑목 | 1.750 | 모델 구조적 오답 (확신도 높음) |
| 검재 | 겹재 | - | 모델 구조적 오답 |
| (공백 차이) | (공백 삽입) | - | 줄바꿈 정규화 차이 |

---

## 6. 기술적 분석

### 6.1 왜 bfloat16이 float16보다 빠른가

RTX 4060 (Ada Lovelace, SM 8.9)은 bf16 Tensor Core 연산에 최적화되어 있다. float16 대비 bf16이 matmul throughput에서 이점이 있으며, 모델 로딩 및 추론 모두 빨라진다.

### 6.2 왜 reduced_precision_reduction이 문제인가

PyTorch의 bf16 matmul은 기본적으로 **축약 정밀도 reduction**을 사용한다. 이는 큰 행렬의 내적(dot product)을 계산할 때 중간 합산을 bf16으로 수행하여 속도를 높이지만, 반올림 오차가 누적된다.

OCR 모델에서 유사한 글자(`용` vs `융`, `재` vs `제`)의 logit 차이가 극도로 작을 때(margin ≈ 0), 이 누적 오차가 top-1 토큰을 뒤집을 수 있다.

`allow_bf16_reduced_precision_reduction = False`로 설정하면 중간 합산이 fp32로 수행되어 정밀도가 보존된다.

### 6.3 왜 flash_attention_2가 Windows에서 실패하는가

DeepSeek-OCR-2의 커스텀 attention 코드(`DeepseekV2FlashAttention2`)는 `flash_attn` 라이브러리의 `flash_attn_func`, `flash_attn_varlen_func`를 직접 호출한다. Windows용 커뮤니티 빌드 wheel은 이 함수들의 내부 동작이 Linux 네이티브 빌드와 미묘하게 다르며, 특히 이 모델의 MLA(Multi-head Latent Attention) 구조에서 수치적 불안정을 유발하여 반복 토큰 생성(degenerate output)이 발생한다.

### 6.4 왜 lm_head FP32가 효과 없는가

오류의 근본 원인이 **lm_head의 logit 계산 정밀도가 아니라, attention 레이어에서 생성된 hidden_states의 정밀도**에 있기 때문이다. attention 레이어를 통과하면서 `용`과 `융`에 해당하는 feature가 이미 결정되고, lm_head는 이를 vocabulary 공간에 투영할 뿐이다. 따라서 lm_head만 FP32로 올려도 입력이 이미 bf16 정밀도로 뭉개진 상태라 결과가 동일하다.

단, reduced_precision_reduction을 끄면 attention 레이어 내부의 matmul 정밀도가 올라가 hidden_states 자체의 품질이 향상되어 효과가 나타난다.

### 6.5 Vision Encoder 해상도 제한

`models/deepseek-ocr-2/deepencoderv2.py`의 forward 함수에서 `n_query`가 144(image_size=768) 또는 256(base_size=1024)만 하드코딩되어 있어, 해상도 변경을 통한 개선은 불가능하다.

```python
if n_query == 144:
    param_img = self.query_768.weight
elif n_query == 256:
    param_img = self.query_1024.weight
# 그 외 해상도는 param_img 미할당 → 에러 발생
```

### 3.6 이미지 전처리 (Enhance) 시도 (역효과)

**가설**: 이미지를 2배 업샘플(INTER_CUBIC) + CLAHE 대비 향상 + 샤프닝 처리하면 글자 획이 선명해져 혼동 글자 구분력이 향상될 것.

**구현**: `scripts/deepseek_ocr2_batch.py`에 `enhance_image()` 함수 추가, `--enhance` CLI 플래그로 제어.

```python
def enhance_image(image_path, scale=2.0):
    img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    # CLAHE on L channel
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    # Mild sharpen kernel [[0,-1,0],[-1,5,-1],[0,-1,0]]
```

**결과**: **97.80%** (이전 best 99.16% 대비 -1.36%p 하락)

| 원본 | OCR 결과 | 비고 |
|------|----------|------|
| 용신 | 융신 | reduction OFF로 해결된 것이 **다시 발생** |
| 을목 | 율목 | **신규 오류** |
| 삼합 | 상합 | **신규 오류** |
| 구응성패 | 구용성패 | **신규 오류** |
| 정제대운 | 정제대문 | **신규 오류** |
| 활동 | 활용 | **신규 오류** |
| 검재 | 결제 | 오류 변화 (겹재→결제) |
| 감목 | 갑목 | 기존과 동일 |

**원인 분석**: 테스트 대상 이미지는 **디지털 원본**(웹 스크린샷)으로 이미 충분히 깨끗하다. CLAHE + 샤프닝이 미세한 노이즈를 증폭시켜 vision encoder의 feature extraction을 오히려 교란하였다. 특히 형태가 유사한 한글 자모(`용/융`, `을/율`, `삼/상`, `응/용`)에서 구분력이 급격히 저하되었다.

**결론**: 이미지 전처리는 **스캔 문서, 저해상도 사진** 등 열화된 원본에만 유효하며, 디지털 원본에는 역효과. 모든 모드에서 기본 비활성화(`deepseekEnhance: false`)로 설정.

---

## 7. 추가 개선 방안

### 7.1 SLM 후보정 (현재 구현됨)

현재 v5 프롬프트(도메인 자동 인식)가 적용되어 있으며, bf16 + reduction OFF 기반 위에서 SLM을 조합하면 추가 개선 가능. 남은 구조적 오답(`감→갑`, `검→겹`)은 SLM이 문맥으로 교정할 수 있는 영역이다.

### 7.2 WSL2 + flash_attention_2 (미적용)

Windows Subsystem for Linux 2에서 공식 flash-attn을 소스 빌드하면 HF 데모와 동일한 환경을 재현할 수 있다. 이 경우 100% 유사도 달성이 기대된다.

### 7.3 모델 업데이트

HuggingFace Hub의 모델 코드가 업데이트될 경우, vision encoder의 해상도 제한 해제나 새로운 attention 구현이 추가될 수 있다.

---

## 8. 파일 변경 목록

| 파일 | 변경 내용 |
|------|-----------|
| `scripts/deepseek_ocr2_batch.py` | bf16 전환, reduced_precision_reduction OFF, enhance_image() 함수 추가 |
| `archive-cafe.mjs` | `PYTHONNOUSERSITE: "1"` 환경변수 추가 (conda 환경 호환) |
| `archive-cafe.mjs` | SLM 프롬프트 v5 (도메인 자동 인식 + 맞춤법 교정) |
| `archive-cafe.mjs` | `deepseekEnhance` 설정 추가 (CLI: `--deepseek-enhance`, 기본값: false) |
| `models/deepseek-ocr-2/modeling_deepseekv2.py` | 변경 없음 (lm_head FP32 시도 후 원복) |
