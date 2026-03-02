# 네이버 카페 OCR 아카이브 파이프라인 설계명세서 (v1)

## 1) 목표
네이버 카페 게시글 URL을 입력받아:
- 텍스트 본문은 그대로 수집
- 이미지 본문은 OCR 처리
- 결과를 단일 `.md`로 저장

---

## 2) 입력/출력

### 입력
- `url` (예: `https://cafe.naver.com/chiusin/46983`)
- `outDir` (예: `D:\cafe-archive\chiusin`)
- `options`
  - `ocrEngine`: `tesseract | winrt | both`
  - `scale`: 기본 3~4
  - `parts`: 기본 3~5

### 출력
- `<slug>.md`
- `assets/original/*.jpg|png`
- `assets/preprocessed/*.png`
- `assets/ocr/*.txt`
- `manifest.json` (처리 로그/메타)

---

## 3) 모듈 구조
1. `fetchArticle(url, browserContext)`
   - iframe(`cafe_main`) 내부 접근
   - 제목/작성자/작성일/본문 블록 추출
2. `classifyBlocks(blocks)`
   - `text` 블록 / `image` 블록 분리
3. `downloadImages(imageUrls)`
4. `preprocessImage(path, { scale, mode })`
5. `splitImage(path, { parts, overlap })`
6. `ocrTesseract(path)` / `ocrWinRT(path)`
7. `selectBestText(tess, winrt)` (점수 기반)
8. `composeMarkdown(meta, textBlocks, ocrBlocks)`
9. `saveArtifacts(...)`

---

## 4) 핵심 로직
- **A안(텍스트 블록 존재):** HTML 텍스트 우선 저장
- **B안(이미지 블록):**
  - 원본 다운로드
  - 전처리 + 세로 분할 OCR
  - 엔진별 텍스트 비교 후 선택
- 최종 md는 본문 순서 보존(블록 순서대로)

---

## 5) OCR 품질 규칙
- 전처리 기본: `scale=4`, grayscale, normalize, mild sharpen
- threshold(binary)는 옵션화(기본 OFF)
- 분할: 4조각 + 8% overlap
- 점수식(간단 예시):
  - 한글/숫자/영문 비율 ↑
  - 깨짐문자(�), 특수문자 과다 ↓

---

## 6) 인코딩 규칙 (중요)
- 모든 파일 I/O UTF-8 고정
- 콘솔 파이프 의존 최소화, 파일 기반 전달 우선
- PowerShell 사용 시 `Set-Content -Encoding UTF8` 명시
- 가능하면 Node 단일 파이프라인으로 통합 권장

---

## 7) 기술 스택 권장
- 런타임: Node.js
- 브라우저: Playwright/CDP(로그인된 Chrome attach)
- OCR:
  - 1순위: tesseract.js
  - 보조: WinRT OCR(옵션)
- 이미지 처리: sharp

---

## 8) CLI 예시
```bash
node archive-cafe.mjs \
  --url "https://cafe.naver.com/chiusin/46983" \
  --out "D:/cafe-archive/chiusin" \
  --engine both \
  --scale 4 \
  --parts 4
```

---

## 9) 완료 기준(DoD)
- [ ] 텍스트 글은 OCR 없이 md 생성
- [ ] 이미지 글은 OCR 결과 md 생성
- [ ] md가 UTF-8 한글 정상 표시
- [ ] 실패 시 `manifest.json`에 원인 기록

---

## 10) 구현 우선순위 제안
1. HTML 블록 추출 안정화(iframe 처리)
2. 텍스트/이미지 분기 저장
3. 이미지 다운로드 + 전처리 + 단일 OCR
4. 분할 OCR + 엔진 병합
5. 품질 점수/후처리 + manifest 리포트
