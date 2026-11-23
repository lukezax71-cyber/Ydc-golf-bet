#!/usr/bin/env python3
"""실제 헤드리스 크로미움(390x844, 아이폰 크기)에서 앱을 조작하며 검증한다.

확인하는 것
  · YDC / 오장 두 모드로 여러 홀을 실제로 입력
  · 중간 새로고침(앱 종료·재실행) 후에도 기록이 그대로인지
  · 마지막 홀 되돌리기 / 수정이 누적 금액을 정확히 다시 계산하는지
  · 니어 이월 결정, 오장 더블 소모
  · 최종 정산 화면 숫자 = 규칙 엔진 재계산 값, 합계 0
  · 오프라인(비행기 모드)에서 다시 열어도 동작하는지, 외부 요청이 0건인지
  · 주요 화면 스크린샷 저장(screens/)

실행: python3 tests/test_browser.py
"""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from playwright.sync_api import sync_playwright
import browser_util as bu

ROOT = bu.ROOT
CSV = os.path.join(ROOT, 'screens')
os.makedirs(CSV, exist_ok=True)

RESULTS = []


def ok(name, cond, detail=''):
    RESULTS.append((bool(cond), name, detail))
    print(('  ✓ ' if cond else '  ✗ ') + name + ('' if cond else '  << ' + str(detail)))


def shot(page, name, full=False):
    # 전체 화면 캡처에서 고정 헤더가 중간에 찍히는 현상을 막는다(캡처용 스타일).
    if full:
        page.add_style_tag(content='.topbar{position:static !important}'
                           '.footer-bar{position:static !important;background:none !important;padding:0 !important;margin-top:16px}'
                           '.footer-inner{max-width:none}')
        page.wait_for_timeout(60)
    page.screenshot(path=os.path.join(CSV, name), full_page=full)
    print('    · 스크린샷', name)


def names(page):
    return page.eval_on_selector_all('.player .name', 'els => els.map(e => e.textContent.trim())')


def set_score(page, name, target):
    cards = page.locator('.player')
    for i in range(cards.count()):
        c = cards.nth(i)
        if c.locator('.name').inner_text().strip() == name:
            cur = int(c.locator('.score-btn .num').inner_text().replace('+', ''))
            delta = target - cur
            btn = '[data-act="play:inc"][data-d="%d"]' % (1 if delta > 0 else -1)
            for _ in range(abs(delta)):
                c.locator(btn).click()
            return
    raise AssertionError('선수 카드를 찾지 못함: %s (현재 %s)' % (name, names(page)))


def fill_scores(page, mapping):
    for nm, s in mapping.items():
        set_score(page, nm, s)
    page.wait_for_timeout(60)


def storage_round(page):
    raw = page.evaluate("localStorage.getItem('ydcgb:v1:active')")
    return json.loads(raw) if raw else None


def recompute_in_page(page, rnd):
    return page.evaluate("""(r) => {
        const v = YDC.recomputeRound(r);
        return {
          nets: v.players.map(p => ({name: p.name, net: p.net, points: p.points, doubles: p.doubles})),
          nextHole: v.nextHole, holeCount: v.holeCount,
          finished: v.finished,
          finalNet: v.roundEnd.finalNet,
          settlements: v.roundEnd.settlements.map(t => ({from: t.from, to: t.to, amount: t.amount})),
          sidePot: v.sidePot,
          mult: v.lastHole ? v.lastHole.mult : null
        };
    }""", rnd)


def ui_nets(page):
    """결과 화면 '누적 현황' 표에서 이름→누적금액."""
    rows = page.eval_on_selector_all('.card table.data tbody tr',
                                     'trs => trs.map(tr => Array.from(tr.children).map(td => td.textContent.trim()))')
    out = {}
    for r in rows:
        if len(r) >= 2:
            amt = r[1].replace('₩', '').replace(',', '').replace('+', '')
            try:
                out[r[0]] = int(amt)
            except ValueError:
                pass
    return out


def summary_rows(page):
    return page.eval_on_selector_all('.card table.data tbody tr',
                                     'trs => trs.map(tr => Array.from(tr.children).map(td => td.textContent.trim()))')


def start_round(page, mode, players, base=1000, holes=9, sides=None, title='', shuffle=False):
    if page.locator('[data-act="setup:start"]').count() == 0:
        page.click('[data-act="nav:setup"]')
        page.wait_for_timeout(120)
    page.click('[data-act="setup:mode"][data-mode="%s"]' % mode)
    page.click('[data-act="setup:count"][data-n="%d"]' % len(players))
    page.click('[data-act="setup:holes"][data-n="%d"]' % holes)
    page.fill('[data-act="setup:title"]', title)
    page.fill('[data-act="setup:base"]', str(base))
    inputs = page.locator('[data-act="setup:name"]')
    for i, nm in enumerate(players):
        inputs.nth(i).fill(nm)
    if not shuffle:
        page.locator('[data-act="setup:shuffle"]').uncheck()
    for side, hole_list in (sides or {}).items():
        page.locator('[data-act="setup:side"][data-type="%s"]' % side).check()
        page.wait_for_timeout(80)
        for idx, h in enumerate(hole_list):
            page.select_option('[data-act="setup:hole"][data-type="%s"][data-idx="%d"]' % (side, idx), str(h))
            page.wait_for_timeout(60)
    page.click('[data-act="setup:start"]')
    page.wait_for_timeout(250)


def finish(page, side_choice='이월하기'):
    """홀 완료 → (사이드 결정 모달이 뜨면 처리) → 결과 화면."""
    page.click('[data-act="play:finish"]')
    page.wait_for_timeout(250)
    if page.locator('#modalBack').count():
        btn = page.locator('#modalBack button', has_text=side_choice).first
        if btn.count() == 0:
            btn = page.locator('#modalBack button').first
        btn.click()
        page.wait_for_timeout(350)


def modal_click(page, text):
    page.wait_for_selector('#modalBack', timeout=4000)
    page.locator('#modalBack button', has_text=text).first.click()
    page.wait_for_timeout(150)


def run():
    httpd, url = bu.start_server()
    try:
        with sync_playwright() as pw:
            browser, ctx = bu.launch(pw)

            # ================= 시나리오 1: YDC 4인, 니어 이월 =================
            print('\n[1] YDC 4인 · 니어 이월 · 새로고침 · 되돌리기 · 수정')
            page = ctx.new_page()
            errors, external = [], []
            page.on('pageerror', lambda e: errors.append(str(e)))
            page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            page.on('request', lambda r: external.append(r.url) if not r.url.startswith(url) else None)

            page.goto(url, wait_until='load')
            page.wait_for_timeout(300)
            shot(page, '01-home.png')
            ok('홈 화면 로딩', '새 라운드 시작' in page.inner_text('#root'))

            page.click('[data-act="nav:setup"]')
            page.wait_for_timeout(150)
            shot(page, '02-setup-empty.png', full=True)

            start_round(page, 'ydc', ['김영덕', '이정훈', '박켈리', '최민수'], base=1000, holes=9,
                        sides={'nearest': [1, 2, 3]}, title='토요일 라운드')
            shot(page, '03-play-hole1.png', full=True)
            ok('4명 플레이 화면', names(page) == ['김영덕', '이정훈', '박켈리', '최민수'], names(page))
            ok('1홀 배율 ×1', '×1' in page.inner_text('.mult-box'))

            # 1홀: 전원 파, 니어 승자 없음 → 이월
            fill_scores(page, {'김영덕': 0, '이정훈': 0, '박켈리': 0, '최민수': 0})
            shot(page, '04-play-side-chips.png')
            page.click('[data-act="play:finish"]')
            modal_click(page, '이월하기')
            page.wait_for_timeout(250)
            ok('1홀 결과 화면', '1번 홀 결과' in page.inner_text('#root'))
            ok('다음 배율 ×10', '×10' in page.inner_text('.next-mult'))
            shot(page, '05-result-hole1.png', full=True)

            r = storage_round(page)
            v = recompute_in_page(page, r)
            ok('저장된 홀 수 1', v['holeCount'] == 1, v['holeCount'])
            ok('니어 이월 1회 저장', v['sidePot']['nearest'] == 1, v['sidePot'])

            # 2홀: 버디 1명 + 니어 승자 지정
            page.click('[data-act="result:next"]')
            page.wait_for_timeout(200)
            ok('2홀 배율 ×10', '×10' in page.inner_text('.mult-box'))
            fill_scores(page, {'김영덕': -1, '이정훈': 0, '박켈리': 0, '최민수': 1})
            # 니어 승자 = 최민수
            cards = page.locator('.player')
            for i in range(cards.count()):
                if cards.nth(i).locator('.name').inner_text().strip() == '최민수':
                    cards.nth(i).locator('[data-act="play:side"][data-val="win"]').first.click()
            page.wait_for_timeout(100)
            shot(page, '06-play-hole2-sides.png', full=True)
            page.click('[data-act="play:finish"]')
            page.wait_for_timeout(350)
            body = page.inner_text('#root')
            ok('니어 정산 표시', '니어' in body)
            ok('이월 반영 2배 지급', '2배' in body or '₩20,000' in body, body[:200])
            shot(page, '07-result-hole2.png', full=True)

            v = recompute_in_page(page, storage_round(page))
            # 2홀 기본 정산 +70,000 에 니어 이월 2배(20,000×3명 지급)가 더해져 50,000
            ok('2홀 후 누적 김영덕 +50,000', v['nets'][0]['net'] == 50000, v['nets'])
            ok('니어 승자 최민수 +60,000 반영', v['nets'][3]['net'] == 10000, v['nets'])
            ok('화면 누적 = 엔진 누적', ui_nets(page) == {n['name']: n['net'] for n in v['nets']}, ui_nets(page))

            # --- 새로고침(앱 껐다 켜기) ---
            page.reload(wait_until='load')
            page.wait_for_timeout(400)
            body = page.inner_text('#root')
            ok('새로고침 후 결과 유지', '2번 홀 결과' in body, body[:120])
            shot(page, '08-reload-persisted.png', full=True)
            v2 = recompute_in_page(page, storage_round(page))
            ok('새로고침 후에도 같은 금액', v2['nets'] == v['nets'], v2['nets'])

            # 3홀 입력 후 되돌리기
            page.click('[data-act="result:next"]')
            page.wait_for_timeout(200)
            fill_scores(page, {'김영덕': 1, '이정훈': 1, '박켈리': 2, '최민수': 3})
            finish(page)
            v3 = recompute_in_page(page, storage_round(page))
            ok('3홀 누적', v3['holeCount'] == 3, v3['holeCount'])
            page.click('[data-act="play:undo"]')
            modal_click(page, '기록 취소')
            page.wait_for_timeout(300)
            ok('되돌리면 3홀 입력 화면', '3' in page.inner_text('.hole-num'))
            v4 = recompute_in_page(page, storage_round(page))
            ok('되돌리면 2홀 상태', v4['holeCount'] == 2 and v4['nets'] == v['nets'], v4['nets'])
            ok('되돌린 뒤 다시 3홀 배율', v4['nextHole'] == 3)
            shot(page, '09-after-undo.png', full=True)

            # 3홀 다시 입력 (다른 점수로) + 수정
            fill_scores(page, {'김영덕': 0, '이정훈': 2, '박켈리': 2, '최민수': 2})
            finish(page)
            before_edit = recompute_in_page(page, storage_round(page))
            page.click('[data-act="play:edit"]')
            page.wait_for_timeout(250)
            ok('수정 화면 진입', '수정 중' in page.inner_text('#root') or '수정 저장' in page.inner_text('#root'))
            shot(page, '10-edit-hole.png', full=True)
            fill_scores(page, {'김영덕': 0, '이정훈': 2, '박켈리': 2, '최민수': 5})
            finish(page)
            after_edit = recompute_in_page(page, storage_round(page))
            ok('수정해도 홀 수 그대로', after_edit['holeCount'] == 3)
            ok('수정하면 금액이 다시 계산됨', after_edit['nets'] != before_edit['nets'])

            # 라운드 종료 → 요약 (결과 화면 → 다음 홀 → 메뉴)
            page.click('[data-act="result:next"]')
            page.wait_for_timeout(250)
            page.click('[data-act="play:menu"]')
            modal_click(page, '라운드 종료')
            modal_click(page, '종료하고 정산')
            page.wait_for_timeout(400)
            body = page.inner_text('#root')
            ok('요약 화면', '라운드 결과' in body or '최종 정산' in body, body[:100])
            shot(page, '11-summary.png', full=True)

            vf = recompute_in_page(page, storage_round(page))
            rows = summary_rows(page)
            ok('요약 표 4명', len(rows) == 4, rows)
            ok('최종 정산 합 0', sum(vf['finalNet']) == 0, vf['finalNet'])
            total_shown = 0
            for row in rows:
                total_shown += int(row[-1].replace('₩', '').replace(',', '').replace('+', ''))
            ok('화면 최종 합계 0', total_shown == 0, rows)

            # 공유 텍스트
            page.click('[data-act="share:text"]')
            page.wait_for_timeout(250)
            clip = page.evaluate("navigator.clipboard.readText().catch(() => '')")
            ok('공유 문구 복사', '최종 결과' in clip and '정산' in clip, clip[:160])
            shot(page, '12-share-toast.png')

            # 공유 카드
            page.click('[data-act="share:card"]')
            page.wait_for_selector('#modalBack img', timeout=15000)
            page.wait_for_timeout(200)
            data = page.evaluate("""() => {
                const img = document.querySelector('#modalBack img');
                return img ? img.src.slice(0, 30) : '';
            }""")
            ok('결과 카드 생성', data.startswith('data:image/png'), data)
            img_src = page.evaluate("document.querySelector('#modalBack img').src")
            with open(os.path.join(CSV, '13-share-card.png'), 'wb') as f:
                f.write(base64.b64decode(img_src.split(',')[1]))
            shot(page, '13-share-card-modal.png')
            page.locator('#modalBack button', has_text='닫기').first.click()
            page.wait_for_timeout(150)

            # 보관함
            page.click('[data-act="nav:home"]')
            page.wait_for_timeout(300)
            body = page.inner_text('#root')
            ok('홈에 지난 라운드', '토요일 라운드' in body, body[:200])
            shot(page, '14-home-with-archive.png', full=True)

            ok('콘솔 오류 없음', not errors, errors)
            ok('외부 네트워크 요청 0건', not external, external[:5])
            page.close()

            # ================= 시나리오 2: 오장 2인 + 더블 =================
            print('\n[2] 오장 모드 · 더블 2회')
            ctx2 = browser.new_context(viewport=bu.MOBILE, device_scale_factor=2, locale='ko-KR')
            p2 = ctx2.new_page()
            errs2 = []
            p2.on('pageerror', lambda e: errs2.append(str(e)))
            p2.goto(url, wait_until='load')
            p2.wait_for_timeout(200)
            start_round(p2, 'ojang', ['영덕', '정훈'], base=2000, holes=9, title='오장 테스트')
            shot(p2, '21-ojang-play.png', full=True)
            ok('오장 모드 표시', '오장' in p2.inner_text('.mult-box') or '오장' in p2.inner_text('#root'))

            fill_scores(p2, {'영덕': 0, '정훈': 2})
            p2.click('[data-act="play:finish"]')
            p2.wait_for_timeout(300)
            ok('오장 1홀 다음 배율 ×1', '×1' in p2.inner_text('.next-mult'), p2.inner_text('.next-mult'))

            p2.click('[data-act="result:next"]')
            p2.wait_for_timeout(200)
            ok('더블 버튼 있음', p2.locator('[data-act="play:double"]').count() == 2)
            p2.locator('[data-act="play:double"]').first.click()
            p2.wait_for_timeout(200)
            ok('더블 누르면 ×2', '×2' in p2.inner_text('.mult-box'), p2.inner_text('.mult-box'))
            shot(p2, '22-ojang-double.png', full=True)
            fill_scores(p2, {'영덕': 0, '정훈': 1})
            p2.click('[data-act="play:finish"]')
            p2.wait_for_timeout(300)
            v = recompute_in_page(p2, storage_round(p2))
            ok('더블 적용 홀 배율 2', v['mult'] == 2, v)
            ok('더블 1회 소모', v['nets'][0]['doubles'] == 1, v['nets'])
            ok('2배 정산 금액(1·2홀 합 8,000)', v['nets'][0]['net'] == 8000, v['nets'])
            shot(p2, '23-ojang-result.png', full=True)

            # 3홀: 더블 다시 사용
            p2.click('[data-act="result:next"]')
            p2.wait_for_timeout(200)
            p2.locator('[data-act="play:double"]').first.click()
            p2.wait_for_timeout(150)
            fill_scores(p2, {'영덕': 2, '정훈': 1})
            p2.click('[data-act="play:finish"]')
            p2.wait_for_timeout(300)
            v = recompute_in_page(p2, storage_round(p2))
            ok('더블 2회 소모', v['nets'][0]['doubles'] == 0, v['nets'])
            ok('오장 최종 = 홀 정산', sum(v['finalNet']) == 0, v['finalNet'])
            ok('오장 콘솔 오류 없음', not errs2, errs2)
            ctx2.close()

            # ================= 시나리오 3: 오프라인 =================
            print('\n[3] 오프라인 재실행')
            ctx3 = browser.new_context(viewport=bu.MOBILE, device_scale_factor=2, locale='ko-KR')
            p3 = ctx3.new_page()
            p3.goto(url, wait_until='load')
            p3.wait_for_timeout(400)
            # 서비스워커가 제어할 때까지
            p3.wait_for_function("navigator.serviceWorker && navigator.serviceWorker.controller !== null", timeout=8000)
            start_round(p3, 'ydc', ['가', '나', '다', '라'], base=1000, holes=9, title='오프라인 테스트')
            fill_scores(p3, {'가': -1, '나': 0, '다': 1, '라': 2})
            p3.click('[data-act="play:finish"]')
            p3.wait_for_timeout(300)
            before = recompute_in_page(p3, storage_round(p3))
            ctx3.set_offline(True)
            p3.reload(wait_until='load')
            p3.wait_for_timeout(500)
            body = p3.inner_text('#root')
            ok('오프라인에서 앱이 열림', 'YDC 골프 내기' in body and len(body) > 60, body[:120])
            after = recompute_in_page(p3, storage_round(p3))
            ok('오프라인에서도 기록 유지', after['holeCount'] == 1 and after['nets'] == before['nets'], after['nets'])
            shot(p3, '31-offline-result.png', full=True)
            ctx3.set_offline(False)
            ctx3.close()

            # ================= 시나리오 4: 어두운 테마 =================
            print('\n[4] 다크 테마')
            ctx4 = browser.new_context(viewport=bu.MOBILE, device_scale_factor=2, locale='ko-KR')
            p4 = ctx4.new_page()
            p4.goto(url, wait_until='load')
            p4.wait_for_timeout(250)
            p4.click('[data-act="ui:theme"]')
            p4.wait_for_timeout(250)
            theme = p4.evaluate("document.documentElement.getAttribute('data-theme')")
            ok('다크 테마 적용', theme == 'dark', theme)
            shot(p4, '41-dark-home.png')
            p4.reload(wait_until='load')
            p4.wait_for_timeout(300)
            ok('다크 테마 유지', p4.evaluate("document.documentElement.getAttribute('data-theme')") == 'dark')
            ctx4.close()

            # ================= 시나리오 5: 9홀 끝까지 · 요약에서 수정 =================
            print('\n[5] 9홀 완주 · 자동 종료 · 요약에서 마지막 홀 수정')
            ctx5 = browser.new_context(viewport=bu.MOBILE, device_scale_factor=2, locale='ko-KR')
            p5 = ctx5.new_page()
            errs5 = []
            p5.on('pageerror', lambda e: errs5.append(str(e)))
            p5.goto(url, wait_until='load')
            p5.wait_for_timeout(250)
            start_round(p5, 'ydc', ['가', '나', '다'], base=5000, holes=9, title='9홀 완주')
            script = [
                [0, 0, 0], [0, 1, 1], [-1, 0, 2], [1, 1, 1],
                [0, 0, 1], [2, 1, 0], [-2, 1, 1], [1, 2, 3], [0, 0, 0],
            ]
            for idx, scores in enumerate(script, start=1):
                order = names(p5)
                fill_scores(p5, dict(zip(order, scores)))
                p5.click('[data-act="play:finish"]')
                p5.wait_for_timeout(220)
                if p5.locator('#modalBack').count():
                    p5.locator('#modalBack button').first.click()
                    p5.wait_for_timeout(220)
                if idx < 9:
                    p5.click('[data-act="result:next"]')
                    p5.wait_for_timeout(160)
            body = p5.inner_text('#root')
            ok('9홀 뒤 결과 화면', '9번 홀 결과' in body, body[:100])
            ok('마지막 홀 안내', '라운드 결과 보기' in body)
            shot(p5, '51-final-hole-result.png', full=True)
            p5.click('[data-act="result:next"]')
            p5.wait_for_timeout(400)
            ok('9홀 완주 후 요약', '최종 정산' in p5.inner_text('#root'))
            shot(p5, '52-summary-9holes.png', full=True)
            v9 = recompute_in_page(p5, json.loads(p5.evaluate("localStorage.getItem('ydcgb:v1:archive')"))[0])
            ok('9홀 기록 수', v9['holeCount'] == 9, v9['holeCount'])
            ok('9홀 정산 합 0', sum(v9['finalNet']) == 0, v9['finalNet'])
            ok('보관함 1개', len(json.loads(p5.evaluate("localStorage.getItem('ydcgb:v1:archive')"))) == 1)

            # 요약에서 마지막 홀 수정
            p5.click('[data-act="summary:edit"]')
            p5.wait_for_timeout(300)
            ok('요약에서 수정 진입', '9' in p5.inner_text('.hole-num') and '수정' in p5.inner_text('#root'))
            order = names(p5)
            fill_scores(p5, dict(zip(order, [3, 3, 5])))
            p5.click('[data-act="play:finish"]')
            p5.wait_for_timeout(300)
            if p5.locator('#modalBack').count():
                p5.locator('#modalBack button').first.click()
                p5.wait_for_timeout(250)
            ok('수정 뒤 다시 결과', '9번 홀 결과' in p5.inner_text('#root'))
            p5.click('[data-act="result:next"]')
            p5.wait_for_timeout(400)
            ok('수정 뒤 요약 복귀', '최종 정산' in p5.inner_text('#root'))
            arch = json.loads(p5.evaluate("localStorage.getItem('ydcgb:v1:archive')"))
            ok('수정본이 보관함에 반영', arch[0]['history'][-1]['scores'] == [3, 3, 5], arch[0]['history'][-1]['scores'])
            v9b = recompute_in_page(p5, arch[0])
            ok('수정 뒤 합계 0', sum(v9b['finalNet']) == 0, v9b['finalNet'])
            ok('수정 뒤 금액 변화', v9b['finalNet'] != v9['finalNet'])
            ok('9홀 콘솔 오류 없음', not errs5, errs5)
            shot(p5, '53-summary-after-edit.png')
            ctx5.close()

            # ================= 시나리오 6: 니어 + 롱기 동시 지정 =================
            print('\n[6] 니어 + 롱기 같은 홀')
            ctx6 = browser.new_context(viewport=bu.MOBILE, device_scale_factor=2, locale='ko-KR')
            p6 = ctx6.new_page()
            errs6 = []
            p6.on('pageerror', lambda e: errs6.append(str(e)))
            p6.goto(url, wait_until='load')
            p6.wait_for_timeout(200)
            start_round(p6, 'ydc', ['가', '나', '다'], base=1000, holes=9,
                        sides={'nearest': [2], 'longest': [2]}, title='사이드 둘')
            # 1홀은 사이드 없음
            ok('1홀엔 사이드 칩 없음', p6.locator('.side-chips').count() == 0)
            fill_scores(p6, {'가': 1, '나': 1, '다': 1})
            p6.click('[data-act="play:finish"]')
            p6.wait_for_timeout(250)
            p6.click('[data-act="result:next"]')
            p6.wait_for_timeout(200)
            ok('2홀엔 선수마다 사이드 칩 2줄', p6.locator('.player').first.locator('.side-chips').count() == 2,
               p6.locator('.player').first.locator('.side-chips').count())
            fill_scores(p6, {'가': 0, '나': 1, '다': 2})
            cards = p6.locator('.player')
            for i in range(cards.count()):
                nm = cards.nth(i).locator('.name').inner_text().strip()
                if nm == '가':
                    cards.nth(i).locator('.side-chips').nth(0).locator('[data-val="win"]').click()
                if nm == '다':
                    cards.nth(i).locator('.side-chips').nth(1).locator('[data-val="win"]').click()
            p6.wait_for_timeout(120)
            shot(p6, '61-play-two-sides.png', full=True)
            p6.click('[data-act="play:finish"]')
            p6.wait_for_timeout(350)
            v6 = recompute_in_page(p6, storage_round(p6))
            h2 = None
            p6_body = p6.inner_text('#root')
            ok('니어·롱기 둘 다 표시', '니어' in p6_body and '롱기' in p6_body, p6_body[:300])
            ok('사이드 둘 다 정산(합 0)', sum(v6['finalNet']) == 0, v6['finalNet'])
            ok('사이드 콘솔 오류 없음', not errs6, errs6)
            shot(p6, '62-result-two-sides.png')
            ctx6.close()

            # ================= 시나리오 7: 지난 라운드 삭제 =================
            print('\n[7] 지난 라운드 삭제 · 확인 모달 · 새로고침 뒤에도 삭제 유지')
            ctx7 = browser.new_context(viewport=bu.MOBILE, device_scale_factor=2, locale='ko-KR')
            p7 = ctx7.new_page()
            errs7 = []
            p7.on('pageerror', lambda e: errs7.append(str(e)))
            p7.on('console', lambda m: errs7.append(m.text) if m.type == 'error' else None)

            def archive_js(p):
                raw = p.evaluate("localStorage.getItem('ydcgb:v1:archive')")
                return json.loads(raw) if raw else []

            def idb_archive(p):
                return p.evaluate("""() => new Promise((resolve) => {
                    const req = indexedDB.open('ydc-golf-bet', 1);
                    req.onupgradeneeded = () => {};
                    req.onsuccess = () => {
                      const db = req.result;
                      if (!db.objectStoreNames.contains('kv')) return resolve(null);
                      const tx = db.transaction('kv', 'readonly');
                      const g = tx.objectStore('kv').get('archive');
                      g.onsuccess = () => resolve(g.result || null);
                      g.onerror = () => resolve(null);
                    };
                    req.onerror = () => resolve(null);
                })""")

            def make_round(p, title):
                start_round(p, 'ydc', ['가', '나', '다'], base=1000, holes=9, title=title)
                order = names(p)
                fill_scores(p, dict(zip(order, [0, 1, 1])))
                p.click('[data-act="play:finish"]')
                p.wait_for_timeout(300)
                if p.locator('#modalBack').count():
                    p.locator('#modalBack button').first.click()
                    p.wait_for_timeout(250)
                p.click('[data-act="result:next"]')
                p.wait_for_timeout(200)
                p.click('[data-act="play:menu"]')
                modal_click(p, '라운드 종료')
                modal_click(p, '종료하고 정산')
                p.wait_for_timeout(400)

            def home_titles(p):
                return p.eval_on_selector_all('.round-item .title', 'els => els.map(e => e.textContent.trim())')

            p7.goto(url, wait_until='load')
            p7.wait_for_timeout(300)
            for t in ['삭제 A', '삭제 B', '삭제 C', '삭제 D', '삭제 E']:
                make_round(p7, t)
                if t != '삭제 E':
                    p7.click('[data-act="nav:home"]')
                    p7.wait_for_timeout(250)
            ok('다섯 라운드 보관', len(archive_js(p7)) == 5, len(archive_js(p7)))

            # 마지막 라운드는 요약 화면에 있으므로 홈으로 나온다
            p7.click('[data-act="nav:home"]')
            p7.wait_for_timeout(400)
            body = p7.inner_text('#root')
            ok('홈 카드 3개에 삭제 버튼', p7.locator('.round-item .round-del').count() == 3,
               p7.locator('.round-item .round-del').count())
            ok('홈 카드 순서', home_titles(p7) == ['삭제 E', '삭제 D', '삭제 C'], home_titles(p7))
            ok('전체 보기 버튼', '전체 5개 보기' in body, body[:300])
            del_box = p7.evaluate("""() => {
                    const b = document.querySelector('.round-item .round-del');
                    const r = b.getBoundingClientRect();
                    return {w: Math.round(r.width), h: Math.round(r.height)};
                }""")
            ok('삭제 버튼 44px 이상', del_box['w'] >= 44 and del_box['h'] >= 44, del_box)
            ok('삭제 버튼 라벨 있음', '삭제' in (p7.locator('.round-item .round-del').first.get_attribute('aria-label') or ''),
               p7.locator('.round-item .round-del').first.get_attribute('aria-label'))
            shot(p7, '81-home-delete-button.png', full=True)

            # 삭제 버튼을 눌러도 요약이 열리지 않고 확인 모달만 뜬다
            p7.locator('.round-item .round-del').nth(1).click()
            p7.wait_for_timeout(250)
            ok('삭제 누르면 요약 안 열림', '최종 정산' not in p7.inner_text('#root'), p7.inner_text('#root')[:120])
            ok('확인 모달 뜸', p7.locator('#modalBack').count() == 1)
            modal_text = p7.inner_text('#modalBack')
            ok('모달에 라운드 제목', '삭제 D' in modal_text, modal_text)
            ok('모달에 날짜·정보', '2026.11.' in modal_text and '1홀' in modal_text, modal_text)
            ok('모달에 취소·삭제 버튼',
               p7.locator('#modalBack button', has_text='취소').count() == 1 and
               p7.locator('#modalBack button', has_text='삭제').count() == 1)
            shot(p7, '82-delete-confirm.png')

            # 취소하면 그대로 남는다
            modal_click(p7, '취소')
            p7.wait_for_timeout(250)
            ok('취소하면 삭제 안 됨', len(archive_js(p7)) == 5, len(archive_js(p7)))
            ok('취소하면 목록 그대로', home_titles(p7) == ['삭제 E', '삭제 D', '삭제 C'], home_titles(p7))

            # 실제 삭제: 홈 카드에서 E를 지운다
            p7.locator('.round-item .round-del').first.click()
            p7.wait_for_timeout(200)
            ok('모달이 E를 가리킴', '삭제 E' in p7.inner_text('#modalBack'), p7.inner_text('#modalBack'))
            modal_click(p7, '삭제')
            p7.wait_for_timeout(400)
            body = p7.inner_text('#root')
            ok('삭제 뒤 홈에 E 없음', '삭제 E' not in body, body[:200])
            ok('삭제 뒤 목록 3개', home_titles(p7) == ['삭제 D', '삭제 C', '삭제 B'], home_titles(p7))
            ok('localStorage 보관 4개', len(archive_js(p7)) == 4, [x['title'] for x in archive_js(p7)])
            ok('IDB 보관 4개', len(idb_archive(p7)) == 4, idb_archive(p7) and len(idb_archive(p7)))
            ok('삭제한 라운드가 진행 중 카드로 재등장 안 함',
               '끝난 라운드' not in p7.inner_text('#root') and '진행 중' not in p7.inner_text('#root'),
               p7.inner_text('#root')[:200])
            shot(p7, '83-home-after-delete.png', full=True)

            # 보관함(전체 보기) 화면에서도 삭제
            p7.click('[data-act="nav:archive"]')
            p7.wait_for_timeout(300)
            ok('보관함 4개', p7.locator('.round-item').count() == 4, p7.locator('.round-item').count())
            ok('보관함에도 44px 삭제 버튼', p7.evaluate("""() => {
                    const b = document.querySelector('.round-item .round-del');
                    const r = b.getBoundingClientRect();
                    return r.width >= 44 && r.height >= 44;
                }"""))
            p7.locator('.round-item .round-del').last.click()  # 가장 오래된 '삭제 A'
            p7.wait_for_timeout(200)
            ok('보관함 모달에 A', '삭제 A' in p7.inner_text('#modalBack'), p7.inner_text('#modalBack'))
            modal_click(p7, '삭제')
            p7.wait_for_timeout(400)
            ok('보관함에 머무름', '지난 라운드' in p7.inner_text('#root') and '지난 라운드' in p7.inner_text('.page-title'),
               p7.inner_text('#root')[:80])
            ok('보관함 3개', p7.locator('.round-item').count() == 3, p7.locator('.round-item').count())
            ok('A 삭제됨', '삭제 A' not in p7.inner_text('#root'))
            ok('localStorage 3개', len(archive_js(p7)) == 3, [x['title'] for x in archive_js(p7)])
            shot(p7, '84-archive-after-delete.png', full=True)

            # 새로고침해도 삭제가 유지되는지
            p7.reload(wait_until='load')
            p7.wait_for_timeout(600)
            ok('새로고침 뒤에도 3개', len(archive_js(p7)) == 3, [x['title'] for x in archive_js(p7)])
            ok('새로고침 뒤 IDB도 3개', len(idb_archive(p7)) == 3, idb_archive(p7) and len(idb_archive(p7)))
            body = p7.inner_text('#root')
            ok('새로고침 뒤 A·E 없음', '삭제 A' not in body and '삭제 E' not in body, body[:200])
            ok('새로고침 뒤 삭제 버튼 3개', p7.locator('.round-item .round-del').count() == 3,
               p7.locator('.round-item .round-del').count())

            # 요약 화면에서도 삭제 (지난 라운드 열람 중)
            p7.locator('.round-item [data-act="archive:open"]').first.click()
            p7.wait_for_timeout(350)
            ok('요약 열림', '최종 정산' in p7.inner_text('#root'))
            ok('요약에 라운드 삭제 버튼', p7.locator('[data-act="archive:del"]').count() >= 1)
            shot(p7, '85-summary-delete-button.png', full=True)
            p7.locator('[data-act="archive:del"]').first.click()
            p7.wait_for_timeout(250)
            ok('요약 삭제 모달', '라운드 삭제' in p7.inner_text('#modalBack'), p7.inner_text('#modalBack'))
            modal_click(p7, '삭제')
            p7.wait_for_timeout(450)
            body = p7.inner_text('#root')
            ok('요약 삭제 뒤 홈', '새 라운드 시작' in body, body[:150])
            ok('요약 삭제 뒤 보관 2개', len(archive_js(p7)) == 2, [x['title'] for x in archive_js(p7)])
            ok('IDB도 2개', len(idb_archive(p7)) == 2, idb_archive(p7) and len(idb_archive(p7)))

            p7.reload(wait_until='load')
            p7.wait_for_timeout(500)
            ok('마지막 새로고침에도 2개', len(archive_js(p7)) == 2, [x['title'] for x in archive_js(p7)])
            ok('목록 2개 유지', home_titles(p7) == ['삭제 C', '삭제 B'], home_titles(p7))
            ok('삭제 콘솔 오류 없음', not errs7, errs7)
            shot(p7, '86-home-final.png', full=True)
            ctx7.close()

            browser.close()
    finally:
        httpd.shutdown()

    bad = [r for r in RESULTS if not r[0]]
    print('\n== 결과: %d개 통과 / %d개 실패 ==' % (len(RESULTS) - len(bad), len(bad)))
    for _, n, d in bad:
        print('  ✗', n, '|', str(d)[:300])
    return 0 if not bad else 1


if __name__ == '__main__':
    sys.exit(run())
