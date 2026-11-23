#!/usr/bin/env python3
"""배포된 사이트(GitHub Pages) 실제 점검.

실행: python3 tests/test_deploy.py
인터넷이 필요하다. 배포 직후 1~2분 뒤에 실행한다.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
import browser_util as bu

URL = 'https://lukezax71-cyber.github.io/Ydc-golf-bet/'
OUT = os.path.join(bu.ROOT, 'screens')
RESULTS = []


def ok(name, cond, detail=''):
    RESULTS.append((bool(cond), name, detail))
    print(('  ✓ ' if cond else '  ✗ ') + name + ('' if cond else '  << ' + str(detail)[:200]))


def main():
    with sync_playwright() as pw:
        browser, ctx = bu.launch(pw)
        page = ctx.new_page()
        errs, bad = [], []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('response', lambda r: bad.append((r.status, r.url)) if r.status >= 400 else None)

        page.goto(URL, wait_until='load')
        page.wait_for_timeout(1000)
        ok('사이트 접속', 'YDC 골프 내기' in page.title(), page.title())
        ok('홈 화면 렌더', '새 라운드 시작' in page.inner_text('#root'))
        ok('404 없음', not bad, bad[:3])
        ok('자바스크립트 오류 없음', not errs, errs)
        ok('manifest 200', page.evaluate("fetch('./manifest.webmanifest').then(r=>r.status)") == 200)
        ok('아이콘 200', page.evaluate("fetch('./icons/icon-192.png').then(r=>r.status)") == 200)
        page.screenshot(path=os.path.join(OUT, '71-live-home.png'))

        # 한 홀 실제 진행
        page.click('[data-act="nav:setup"]')
        page.wait_for_timeout(150)
        page.click('[data-act="setup:count"][data-n="4"]')
        page.click('[data-act="setup:holes"][data-n="9"]')
        inputs = page.locator('[data-act="setup:name"]')
        for i, n in enumerate(['김영덕', '이정훈', '박켈리', '최민수']):
            inputs.nth(i).fill(n)
        page.fill('[data-act="setup:title"]', '라이브 점검')
        page.locator('[data-act="setup:shuffle"]').uncheck()
        page.click('[data-act="setup:start"]')
        page.wait_for_timeout(350)
        page.screenshot(path=os.path.join(OUT, '72-live-play.png'))
        cards = page.locator('.player')
        for i in range(cards.count()):
            if cards.nth(i).locator('.name').inner_text().strip() == '김영덕':
                cards.nth(i).locator('[data-act="play:inc"][data-d="-1"]').click()
        page.click('[data-act="play:finish"]')
        page.wait_for_timeout(500)
        ok('한 홀 정산', '1번 홀 결과' in page.inner_text('#root'))

        page.reload(wait_until='load')
        page.wait_for_timeout(700)
        ok('새로고침 후 유지', '1번 홀 결과' in page.inner_text('#root'))

        page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=15000)
        ok('서비스워커 등록', True)
        ctx.set_offline(True)
        page.reload(wait_until='load')
        page.wait_for_timeout(700)
        ok('오프라인 재실행', 'YDC 골프 내기' in page.inner_text('body'))
        ctx.set_offline(False)
        page.screenshot(path=os.path.join(OUT, '73-live-offline.png'))
        browser.close()

    bad_res = [r for r in RESULTS if not r[0]]
    print('\n== 배포 점검: %d개 통과 / %d개 실패 ==' % (len(RESULTS) - len(bad_res), len(bad_res)))
    return 0 if not bad_res else 1


if __name__ == '__main__':
    sys.exit(main())
