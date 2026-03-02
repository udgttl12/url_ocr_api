# Git Push Requirements (Large File 대응)

이 프로젝트는 모델 파일과 가상환경 파일이 매우 커서, 그대로 `git add .` 후 푸시하면 실패할 수 있습니다.

## 1) 기본 원칙

- 소스코드만 Git에 올립니다.
- 생성물(`out/`), 의존성(`node_modules/`, `.venv*/`), 모델 가중치(`models/`, `*.safetensors`, `*.gguf`)는 Git에서 제외합니다.
- 현재 루트의 `.gitignore`에 위 항목이 이미 반영되어 있습니다.

## 2) 리포 생성 및 첫 푸시

```bash
git init
git branch -M main
git add .
git commit -m "chore: initial commit"
git remote add origin <YOUR_REMOTE_URL>
git push -u origin main
```

## 3) 대용량 파일 때문에 푸시 실패할 때

### 방법 A: Git에서 제외(.gitignore)

1. 큰 파일/폴더를 `.gitignore`에 추가
2. 이미 스테이징/추적된 경우 캐시에서 제거

```bash
git rm -r --cached models node_modules out
git rm -r --cached .venv .venv-deepseekocr2 .venv-paddle .venv-paddle310
git commit -m "chore: stop tracking large/generated files"
```

### 방법 B: 꼭 버전관리해야 하는 큰 파일은 Git LFS 사용

```bash
git lfs install
git lfs track "*.safetensors"
git lfs track "*.gguf"
git add .gitattributes
git add <large-file>
git commit -m "chore: track large model files with git-lfs"
git push
```

## 4) 이미 과거 커밋에 큰 파일이 들어간 경우

단순히 `.gitignore` 추가만으로는 해결되지 않습니다. 히스토리에서 제거해야 합니다.

예시(`git filter-repo` 사용):

```bash
git filter-repo --path models --invert-paths
git filter-repo --path-glob "*.safetensors" --invert-paths
git filter-repo --path-glob "*.gguf" --invert-paths
git push --force --all
git push --force --tags
```

주의: 히스토리 재작성(`--force`)은 협업 중인 브랜치에 영향이 큽니다.

## 5) 푸시 전 점검(권장)

100MB 이상 파일 점검:

```bash
Get-ChildItem -File -Recurse | Where-Object { $_.Length -gt 100MB } | Select-Object FullName,Length
```

추적 중인 파일만 점검:

```bash
git ls-files | ForEach-Object { Get-Item $_ } | Where-Object { $_.Length -gt 100MB } | Select-Object FullName,Length
```

