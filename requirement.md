# Requirements For Cross-PC Reproducibility

이 문서는 `models/`(가중치) 파일을 Git에 포함하지 않는 대신,
다른 컴퓨터에서도 같은 환경/설정으로 개발할 수 있도록 기준을 고정한다.

## 1. Git 정책

- Git에는 코드/스크립트/문서만 포함한다.
- 아래 항목은 `.gitignore`로 제외한다.
  - `models/`
  - `*.safetensors`
  - `*.gguf`
  - `node_modules/`, `.venv*/`, `out/`

즉, 가중치는 각 개발 PC에서 별도 준비해야 한다.

## 2. 다른 PC 준비 체크리스트

### OS / HW

- Windows 10/11 (PowerShell 기준)
- NVIDIA GPU (CUDA 사용 가능)
- 페이지파일(가상 메모리) 권장: 최소 32GB 이상
  - DeepSeek 모델 로드 시 `os error 1455`가 나면 페이지파일이 부족한 상태

### 런타임 버전(현재 기준)

- Node.js: `v22.22.0`
- npm: `10.9.4`
- Python: `3.10.11` (`.venv-deepseekocr2`)
- PyTorch: `2.6.0+cu124`
- transformers: `4.46.3`
- tokenizers: `0.20.3`
- bitsandbytes: `0.49.2`

## 3. 필수 로컬 파일(가중치)

아래는 Git에 없으므로 수동으로 준비:

- `models/deepseek-ocr-2/` (DeepSeek OCR 모델 디렉터리 전체)
- `models/Qwen3-VL-4B-Instruct-Q6_K.gguf` (QwenVL 엔진 사용 시)

확인 명령:

```powershell
Test-Path .\models\deepseek-ocr-2
Test-Path .\models\Qwen3-VL-4B-Instruct-Q6_K.gguf
```

## 4. 재현용 고정 실행 파라미터

`archive-cafe.mjs`에서 결과 재현에 영향이 큰 값:

- `--engine deepseek`
- `--ocr-mode fast|normal|high`
- `--scale`
- `--deepseek-max-tokens`
- `--deepseek-4bit`
- `--deepseek-base-size`
- `--deepseek-image-size`
- `--deepseek-crop`
- `--deepseek-parallel`
- `--deepseek-high-multipass`

권장 기본(재현성 우선):

```powershell
node archive-cafe.mjs `
  --url "https://cafe.naver.com/chiusin/43374" `
  --out "out/run-normal" `
  --engine deepseek `
  --ocr-mode normal `
  --deepseek-python ".\\.venv-deepseekocr2\\Scripts\\python.exe" `
  --deepseek-model-dir ".\\models\\deepseek-ocr-2"
```

## 5. high 모드 / 병렬 주의사항

- `high`는 품질 우선으로 내부적으로 non-4bit를 사용한다.
- `--deepseek-high-multipass true`는 느리고 메모리 사용량이 커진다.
- `--deepseek-parallel > 1`은 VRAM/페이지파일 요구량이 급증한다.
- 병렬을 강하게 쓰면 속도 이득보다 실패/품질 하락이 먼저 발생할 수 있다.

## 6. 신규 PC 세팅 순서

1. 저장소 클론
2. `npm install`
3. Python 가상환경 생성/활성화 (`.venv-deepseekocr2`)
4. DeepSeek 관련 패키지 설치(위 버전 기준)
5. `models/` 가중치 복사
6. 페이지파일 크기 확인(32GB+ 권장)
7. `normal` 모드로 스모크 테스트 후 `high`/병렬 실험

예시 명령:

```powershell
npm install
python -m venv .venv-deepseekocr2
.\\.venv-deepseekocr2\\Scripts\\python.exe -m pip install --upgrade pip
.\\.venv-deepseekocr2\\Scripts\\python.exe -m pip install torch==2.6.0+cu124 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
.\\.venv-deepseekocr2\\Scripts\\python.exe -m pip install transformers==4.46.3 tokenizers==0.20.3 bitsandbytes==0.49.2 accelerate safetensors
```

잠금 파일(권장):

- `requirements-lock.txt`를 우선 사용하면 현재 개발 환경과 가장 유사하게 재현 가능

```powershell
.\\.venv-deepseekocr2\\Scripts\\python.exe -m pip install -r requirements-lock.txt --extra-index-url https://download.pytorch.org/whl/cu124
```

## 7. 커밋 전 점검

대용량 파일 추적 여부 확인:

```powershell
git ls-files | ForEach-Object { Get-Item $_ } | Where-Object { $_.Length -gt 100MB } | Select-Object FullName,Length
```

결과가 나오면 `.gitignore` 또는 Git LFS 정책을 먼저 정리한다.
