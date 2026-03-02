# URL OCR Archive

Naver Cafe URL -> Markdown 아카이브 파이프라인입니다.

DeepSeek OCR을 로컬 CUDA로 실행하고, 결과를 `manifest.json`과 `.md`로 저장합니다.

## OCR 모드 (3가지)

`--ocr-mode`로 3가지 모드를 사용할 수 있습니다.

- `fast`: 속도 우선
- `normal`: 균형(기본값)
- `high`: 정확도 우선, 99.9% 유사도 목표 모드

중요: `high`는 99.9%를 목표로 튜닝된 모드이지만, 입력 이미지 품질에 따라 보장되지는 않습니다.

## 요구 사항

- Windows + NVIDIA GPU
- CUDA 사용 가능한 PyTorch 환경
- Node.js
- DeepSeek OCR 모델 디렉터리
  - 기본: `./models/deepseek-ocr-2`

주의: DeepSeek OCR은 **CUDA 필수**입니다. CPU 실행은 실패 처리됩니다.

## 설치

```bash
npm install
```

선택: SLM 보정(Ollama) 설치

```bash
npm run install:slm
```

## 기본 실행 예시

```bash
node archive-cafe.mjs \
  --url "https://cafe.naver.com/chiusin/46983" \
  --out "D:/cafe-archive/chiusin" \
  --engine deepseek \
  --ocr-mode normal \
  --deepseek-python "D:/skill-project/url_ocr/.venv-deepseekocr2/Scripts/python.exe" \
  --deepseek-model-dir "D:/skill-project/url_ocr/models/deepseek-ocr-2"
```

## 모드별 기본값

`engine=deepseek` 기준:

- `fast`
  - `--scale 4`
  - `--deepseek-4bit true`
  - `--deepseek-max-tokens 900`
  - `--deepseek-base-size 1024`
  - `--deepseek-image-size 768`
  - `--deepseek-crop true`
  - `--deepseek-attn eager`
- `normal` (기본)
  - `--scale 4`
  - `--deepseek-4bit false`
  - `--deepseek-max-tokens 1200`
  - `--deepseek-base-size 1024`
  - `--deepseek-image-size 768`
  - `--deepseek-crop true`
  - `--deepseek-attn eager`
- `high` (정확도 우선)
  - `--scale 5`
  - `--deepseek-4bit false`
  - `--deepseek-max-tokens 1600`
  - `--deepseek-base-size 1024`
  - `--deepseek-image-size 768`
  - `--deepseek-crop true`
  - `--deepseek-attn eager`
  - 추가로 DeepSeek 다중 패스를 실행해 결과를 비교 선택

## 추천 사용 방법

- 빠른 대량 처리: `--ocr-mode fast`
- 일반 운영: `--ocr-mode normal`
- 학습 데이터 수집/정밀 추출: `--ocr-mode high`

## 옵션 우선순위

1. CLI에서 직접 지정한 옵션
2. `--ocr-mode`가 주는 기본값
3. 코드 fallback 기본값

예시:

```bash
node archive-cafe.mjs --url ... --out ... --engine deepseek --ocr-mode fast --deepseek-4bit false
```

위 경우 `deepseek-4bit` 최종값은 `false`입니다.

## 시간 측정 예시 (PowerShell)

```powershell
$sw=[System.Diagnostics.Stopwatch]::StartNew()
node archive-cafe.mjs --url "https://cafe.naver.com/chiusin/43374" --out "out/run-fast" --engine deepseek --ocr-mode fast
$sw.Stop()
"elapsed_sec=$([math]::Round($sw.Elapsed.TotalSeconds,2))"
```

## 출력 구조

- `<slug>.md`
- `assets/original/*`
- `assets/preprocessed/*`
- `assets/ocr/*`
- `manifest.json`

`manifest.json`에는 입력 설정, OCR 통계, 경고/오류, 엔진 선택 정보가 기록됩니다.

## 주요 옵션

- `--engine`: `tesseract | winrt | qwenvl | deepseek | both | all` (default: `qwenvl`)
- `--ocr-mode`: `fast | normal | high` (default: `normal`)
- `--scale`: preprocess resize scale
- `--parts`: split count
- `--overlap`: split overlap ratio
- `--threshold`: `true | false`
- `--deepseek-python`: DeepSeek runner python 경로
- `--deepseek-model-dir`: DeepSeek model dir
- `--deepseek-timeout`: timeout ms
- `--deepseek-max-tokens`: max tokens
- `--deepseek-prompt`: OCR prompt
- `--deepseek-device`: `auto | cuda | cuda:0 ...` (CUDA required)
- `--deepseek-device-map`: device map (`auto` 권장)
- `--deepseek-4bit`: `true | false`
- `--deepseek-attn`: attention implementation
- `--deepseek-base-size`: base size
- `--deepseek-image-size`: image size
- `--deepseek-crop`: `true | false`
- `--slm`: `true | false`
- `--slm-model`: SLM model name
- `--slm-host`: SLM endpoint/base URL
- `--slm-key`: optional API key
- `--slm-timeout`: timeout ms
- `--cdp`: Chrome DevTools endpoint
- `--headless`: `true | false`

## 참고

- `engine=all`은 `tesseract + winrt + qwenvl + deepseek`를 모두 실행합니다.
- `deepseek` 엔진은 이미지를 배치 처리해서 모델 재로딩 비용을 줄입니다.
