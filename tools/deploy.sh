#!/bin/sh
# YDC 골프 내기 배포: main 에 올리고, 발행 브랜치(gh-pages)를 main 과 같게 맞춘다.
#
#   sh tools/deploy.sh
#
# 이 저장소의 GitHub Pages 는 gh-pages 브랜치를 바라보도록 설정되어 있다.
# (설정 화면에서 main 으로 바꿔도 되고, 그 뒤로는 gh-pages 동기화는 필요 없다.)
set -e
cd "$(dirname "$0")/.."

if [ ! -f index.html ]; then
  echo "index.html 이 없습니다. 먼저 python3 tools/build.py 를 실행하세요." >&2
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "main 브랜치에서 실행하세요 (현재: $BRANCH)" >&2
  exit 1
fi

git push -u origin main
git push origin main:gh-pages --force

URL="https://lukezax71-cyber.github.io/Ydc-golf-bet/"
i=0
while [ "$i" -lt 30 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || echo 000)
  echo "$(date +%H:%M:%S) $code $URL"
  [ "$code" = "200" ] && break
  sleep 5
  i=$((i + 1))
done
echo "확인: 브라우저에서 캐시를 비우고(?v=$(date +%s)) 열어 보세요."
