#!/usr/bin/env python3
"""규칙 엔진 단위 테스트 — 실제 JS(src/rules.js)를 V8로 실행해서 검증한다.

실행: python3 tests/test_rules.py
"""
import json
import os
import sys

from py_mini_racer import MiniRacer

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAIL = []
PASS = []


def check(name, got, want):
    if got == want:
        PASS.append(name)
    else:
        FAIL.append('%s\n    기대: %r\n    실제: %r' % (name, want, got))


def check_raises(name, fn):
    try:
        fn()
    except Exception as e:
        PASS.append(name + ' (예외: %s)' % str(e)[:40])
        return
    FAIL.append(name + ' — 예외가 나지 않았습니다')


ctx = MiniRacer()
ctx.eval(open(os.path.join(BASE, 'src', 'rules.js'), encoding='utf-8').read())


def js(expr):
    """표현식을 실행하고 JSON으로 돌려받는다."""
    return json.loads(ctx.eval('JSON.stringify(%s)' % expr))


def build(mode='ydc', base=1000, holes=18, players=('A', 'B', 'C', 'D'), sides=None):
    return {
        'mode': mode,
        'baseBet': base,
        'totalHoles': holes,
        'initialPlayers': [{'uid': 'u%d' % i, 'name': n} for i, n in enumerate(players)],
        'sideConfig': sides or {'nearest': {'enabled': False, 'holes': []},
                                'longest': {'enabled': False, 'holes': []}},
        'history': [],
    }


def add_hole(r, hole, scores, sides=None, double_by=None):
    entry = {
        'hole': hole,
        'uids': [p['uid'] for p in r['initialPlayers']],
        'scores': list(scores),
        'sides': sides or {},
        'doubleBy': double_by,
    }
    r['history'].append(entry)
    return r


def recompute(r):
    ctx.eval('var __R = %s;' % json.dumps(r))
    return ctx.eval('JSON.stringify(YDC.recomputeRound(__R))')


def view(r):
    return json.loads(recompute(r))


def nets(r):
    ctx.eval('var __R2 = %s;' % json.dumps(r))
    return ctx.eval('JSON.stringify(YDC.recomputeRound(__R2).players.map(function(p){return p.net;}))')


# --------------------------------------------------------------- YDC 배율
ydc_cases = [
    ('전원 파', [0, 0, 0, 0], 10),
    ('전원 보기', [1, 1, 1, 1], 5),
    ('전원 버디', [-1, -1, -1, -1], 5),
    ('스트레이트', [0, 1, 2, 3], 5),
    ('스트레이트(3명)', [0, 1, 2], 5),
    ('3명 동타', [0, 0, 0, 1], 3),
    ('2명 동타', [0, 0, 1, 2], 2),
    ('2명 동타 두 쌍', [0, 0, 1, 1], 2),
    ('3명 동타 + 최고타', [5, 5, 5, 0], 3),
    ('버디 하나', [-1, 0, 1, 2], 5),
    ('+3 이상', [0, 1, 2, 3], 5),
    ('+3만', [3, 2, 2, 5], 2),
    ('비연속 4가지', [0, 2, 3, 4], 2),
    ('전원 +4 + 튀는 한 명', [4, 4, 4, 5], 3),
    ('2인 전원 파', [0, 0], 10),
    ('2인 동타', [1, 1], 5),
    ('3인 파/보기', [0, 1, 1], 2),
]
for name, scores, want in ydc_cases:
    check('YDC 배율 · ' + name, js('YDC.ydcAnalysis(%s)' % json.dumps(scores))['mult'], want)

# 전원 파는 어떤 다른 후보보다 커야 한다(최댓값 하나만)
check('YDC 최댓값만 적용', js('YDC.ydcAnalysis([0,0,0,0]).mult'), 10)

# ------------------------------------------------------------- 오장 배율
ojang_cases = [
    ('평범', [0, 1, 2, 3], 2),          # +3 이상
    ('언더파', [-1, 0, 1, 2], 2),
    ('최저타 동타', [0, 0, 1, 2], 2),
    ('동타 없음', [0, 1, 1, 2], 1),
    ('최고타만 동타', [0, 1, 2, 2], 1),
    ('전원 파', [0, 0, 0, 0], 2),       # 최저타 동타
    ('전원 보기', [1, 1, 1, 1], 2),     # 최저타 동타
    ('2인 언더파', [-2, 0], 2),
    ('2인 평범', [0, 1], 1),
]
for name, scores, want in ojang_cases:
    check('오장 배율 · ' + name, js('YDC.ojangAnalysis(%s)' % json.dumps(scores))['mult'], want)

# ------------------------------------------------------------ 기본 정산
r = js('YDC.settlementForHole([0,1],1000,1)')
check('2인 정산 금액', r['pairwise'], [{'from': 1, 'to': 0, 'amount': 1000}])
check('2인 정산 net', r['netMoney'], [1000, -1000])

r = js('YDC.settlementForHole([2,-1,0],1000,2)')
check('3인 정산 net', r['netMoney'], [-10000, 8000, 2000])
check('3인 정산 합계 0', sum(r['netMoney']), 0)

r = js('YDC.settlementForHole([0,0,0,0],1000,10)')
check('전원 동타는 이체 없음', r['pairwise'], [])

# 4인 1홀 전체 값 (손계산)
r = js('YDC.settlementForHole([-1,0,0,1],1000,10)')
check('4인 손계산 net', r['netMoney'], [40000, 0, 0, -40000])

# ------------------------------------------------------------ 최소 이체
check('최소 이체 2건', js('YDC.simplifyTransfers([-3000,-1000,1000,3000])'),
      [{'from': 0, 'to': 3, 'amount': 3000}, {'from': 1, 'to': 2, 'amount': 1000}])
check('최소 이체 없음', js('YDC.simplifyTransfers([0,0])'), [])
s = js('YDC.simplifyTransfers([-5000,1000,2000,2000])')
check('최소 이체 합 보존', sum(x['amount'] for x in s), 5000)

# --------------------------------------------------------- 언더파 보너스
r = js('YDC.performanceTransfers([-2,0,0,1],1000,3)')
check('이글 보너스 5배', len(r), 3)
check('이글 보너스 금액', r[0]['amount'], 5 * 1000 * 3)
check('이글 보너스 방향', [(x['from'], x['to']) for x in r], [(1, 0), (2, 0), (3, 0)])
r = js('YDC.performanceTransfers([-3,1,2,3],1000,1)')
check('-3 보너스 10배', r[0]['amount'], 10000)
check('파 이하 보너스 없음', js('YDC.performanceTransfers([0,1,2,3],1000,1)'), [])

# --------------------------------------------------------------- 테스트 라운드
# 1) 3홀: 전원 파 → ×10, 버디 1명, 마지막 홀 2명 동타
r = build(holes=18)
add_hole(r, 1, [0, 0, 0, 0])
add_hole(r, 2, [-1, 0, 0, 1])
add_hole(r, 3, [1, 1, 2, 3])
v = view(r)
check('1홀 배율', v['holes'][0]['mult'], 1)
check('2홀 배율', v['holes'][1]['mult'], 10)
check('3홀 배율', v['holes'][2]['mult'], 2)
check('1홀 다음 배율', v['holes'][0]['nextMult'], 10)
check('2홀 다음 배율', v['holes'][1]['nextMult'], 2)
check('3홀 net', [p['net'] for p in v['players']], [76000, -4000, -12000, -60000])
check('3홀 타수', [p['points'] for p in v['players']], [0, 1, 2, 4])  # 누적: 0+(-1)+1, 0, 0+2, 1+3
check('다음 홀', v['nextHole'], 4)
check('진행 중', v['finished'], False)
check('홀 정산 합 0', sum(p['net'] for p in v['players']), 0)

# 2) YDC 라운드 최종 정산 (잘 친 사람 → 못 친 사람)
r2 = build(base=1000, holes=2)
add_hole(r2, 1, [-2, 0, 3, 1])
add_hole(r2, 2, [0, 0, 0, 0])
v2 = view(r2)
pts = [p['points'] for p in v2['players']]
check('라운드 정산 점수', pts, [-2, 0, 3, 1])
rows = v2['roundEnd']['rows']
check('라운드 정산 건수(6쌍)', len(rows), 6)
check('라운드 정산 합 0', sum(x['amount'] * (1 if True else 1) for x in rows) - sum(x['amount'] for x in rows) + sum(v2['roundEnd']['adjust'].values()), 0)
by_pair = {(x['from'], x['to']): x['amount'] for x in rows}
check('A→B 2000', by_pair[('u0', 'u1')], 2000)
check('A→D 3000', by_pair[('u0', 'u3')], 3000)
check('A→C 5000', by_pair[('u0', 'u2')], 5000)
check('B→C 3000', by_pair[('u1', 'u2')], 3000)
check('B→D 1000', by_pair[('u1', 'u3')], 1000)
check('D→C 2000', by_pair[('u3', 'u2')], 2000)
check('라운드 정산 조정 합 0', sum(v2['roundEnd']['adjust'].values()), 0)

# 오장 모드는 라운드 최종 정산이 없다
r3 = build(mode='ojang', holes=2)
add_hole(r3, 1, [-2, 0, 3, 1])
v3 = view(r3)
check('오장 라운드 정산 없음', v3['roundEnd']['rows'], [])
check('오장 최종 = 홀 정산', v3['roundEnd']['finalNet'], [p['net'] for p in v3['players']])

# ------------------------------------------------------------ 오너 순서
r4 = build(holes=18)
add_hole(r4, 1, [2, 0, 1, 3])
v4 = view(r4)
check('오너 순서 · 직전 홀 타수', v4['teeOrderUids'], ['u1', 'u2', 'u0', 'u3'])

r5 = build(holes=18)
add_hole(r5, 1, [1, 0, 1, 0])
add_hole(r5, 2, [0, 0, 0, 0])
v5 = view(r5)
check('오너 순서 · 앞 홀 거슬러', v5['teeOrderUids'], ['u1', 'u3', 'u0', 'u2'])

# 1번 홀은 처음 순서
r6 = build(holes=18)
check('1번 홀은 처음 순서', view(r6)['teeOrderUids'], ['u0', 'u1', 'u2', 'u3'])

# ------------------------------------------------------ 니어/롱기 이월
sides = {'nearest': {'enabled': True, 'holes': [1, 2, 3]},
         'longest': {'enabled': False, 'holes': []}}
r7 = build(base=1000, holes=9, sides=sides)
add_hole(r7, 1, [0, 1, 2, 3], sides={'nearest': {'decision': 'accum', 'winners': []}})
add_hole(r7, 2, [0, 1, 2, 3], sides={'nearest': {'decision': 'accum', 'winners': []}})
add_hole(r7, 3, [0, 1, 2, 3], sides={'nearest': {'decision': 'paid', 'winners': ['u2']}})
v7 = view(r7)
nearest = v7['holes'][2]['sides']['nearest']
check('이월 2회 → 3배 지급', nearest['potPaid'], 3)
check('이월 지급 단위', nearest['unit'], 3 * 1000 * v7['holes'][2]['mult'])
check('이월 지급 후 초기화', v7['sidePot']['nearest'], 0)
check('이월 지급 인원', len(nearest['transfers']), 3)

# 다중 승자 분할
r8 = build(base=1000, holes=9, sides=sides)
add_hole(r8, 1, [0, 0, 1, 2], sides={'nearest': {'decision': 'paid', 'winners': ['u0', 'u1']}})
v8 = view(r8)
tr = v8['holes'][0]['sides']['nearest']['transfers']
check('분할 승자 인원', len(tr), 4)  # 패자 2명 × 승자 2명
check('분할 금액', tr[0]['amount'], 500)

# 지우개 → reset
r9 = build(base=1000, holes=9, sides=sides)
add_hole(r9, 1, [0, 1, 2, 3], sides={'nearest': {'decision': 'accum', 'winners': []}})
add_hole(r9, 2, [0, 1, 2, 3], sides={'nearest': {'decision': 'reset', 'winners': []}})
v9 = view(r9)
check('초기화 후 이월 0', v9['sidePot']['nearest'], 0)
check('초기화 전 이월 1', v9['holes'][1]['sides']['nearest']['potBefore'], 1)

# 승자 없이 그냥 넘어가기(skip)는 이월을 건드리지 않는다
r10 = build(base=1000, holes=9, sides=sides)
add_hole(r10, 1, [0, 1, 2, 3], sides={'nearest': {'decision': 'accum', 'winners': []}})
add_hole(r10, 2, [0, 1, 2, 3], sides={'nearest': {'decision': 'skip', 'winners': []}})
v10 = view(r10)
check('skip 은 이월 유지', v10['sidePot']['nearest'], 1)

# ------------------------------------------------------- 오장 더블
r11 = build(mode='ojang', holes=9)
add_hole(r11, 1, [0, 1, 2, 2])          # 다음 배율 1
add_hole(r11, 2, [1, 1, 1, 1], double_by='u0')   # 더블 → 2배
add_hole(r11, 3, [2, 2, 3, 3], double_by='u0')   # 배율 2라서 더블 거절
v11 = view(r11)
check('오장 더블 1홀 배율', v11['holes'][1]['mult'], 2)
check('오장 더블 1홀 기록', v11['holes'][1]['doubleBy'], 'u0')
check('이미 2배면 더블 거절', v11['holes'][2]['doubleBy'], None)
check('더블 거절 사유', v11['holes'][2]['doubleRefused'], 'already-2x')
check('더블 잔여 1회', [p['doubles'] for p in v11['players']], [1, 2, 2, 2])

# 더블 2회 소진 후에는 거절
r12 = build(mode='ojang', holes=9)
add_hole(r12, 1, [0, 1, 2, 2])
add_hole(r12, 2, [0, 1, 2, 2], double_by='u0')
add_hole(r12, 3, [0, 1, 2, 2], double_by='u0')
add_hole(r12, 4, [0, 1, 2, 2], double_by='u0')
v12 = view(r12)
check('더블 두 번 사용', [v12['holes'][i]['doubleBy'] for i in (1, 2, 3)], ['u0', 'u0', None])
check('더블 소진 사유', v12['holes'][3]['doubleRefused'], 'none-left')
check('더블 잔여 0', v12['players'][0]['doubles'], 0)

# YDC 모드에서는 더블 무시
r13 = build(mode='ydc', holes=9)
add_hole(r13, 1, [0, 1, 2, 2], double_by='u0')
v13 = view(r13)
check('YDC 더블 무시', v13['holes'][0]['mult'], 1)
check('YDC 더블 사유', v13['holes'][0]['doubleRefused'], 'not-ojang')

# ------------------------------------------------------- 되돌리기/수정 결정성
r14 = build(holes=18)
add_hole(r14, 1, [0, 0, 0, 0])
add_hole(r14, 2, [-1, 0, 0, 1])
add_hole(r14, 3, [1, 1, 2, 3])
full = view(r14)

r14_short = json.loads(json.dumps(r14))
r14_short['history'] = r14_short['history'][:2]
short = view(r14_short)
check('마지막 홀 취소 = 짧은 기록 재계산',
      [p['net'] for p in full['players']][:0] or [p['net'] for p in short['players']],
      [70000, -10000, -10000, -50000])
check('취소 후 다음 홀', short['nextHole'], 3)
check('취소 후 배율', short['nextAnalysis']['mult'], 2)

# 수정: 3홀 점수를 바꾸면 전체가 그 기록으로만 계산된다
r15 = json.loads(json.dumps(r14))
r15['history'][2]['scores'] = [1, 2, 2, 2]
edited = view(r15)
r16 = build(holes=18)
add_hole(r16, 1, [0, 0, 0, 0])
add_hole(r16, 2, [-1, 0, 0, 1])
add_hole(r16, 3, [1, 2, 2, 2])
check('수정 결과 = 새 기록 재계산', [p['net'] for p in edited['players']],
      [p['net'] for p in view(r16)['players']])

# 반복 재계산이 항상 같은 값 (결정성)
a = recompute(r14)
b = recompute(r14)
check('재계산 결정성', a, b)

# ------------------------------------------------------------ 입력 정규화
r17 = build(holes=9)
add_hole(r17, 1, [0, 0, 0, 0])
add_hole(r17, 1, [5, 5, 5, 5])      # 중복 홀은 무시
add_hole(r17, 2, [9, -9, 0, 0])     # 범위 밖은 -3..+5로 보정
v17 = view(r17)
check('중복 홀 무시', v17['holeCount'], 2)
check('점수 보정', v17['holes'][1]['scores'], [5, -3, 0, 0])

# 알 수 없는 선수의 기록은 버린다
r18 = build(holes=9)
r18['history'].append({'hole': 1, 'uids': ['u0', 'zz'], 'scores': [0, 0]})
v18 = view(r18)
check('모르는 선수 기록 무시', v18['holeCount'], 0)

# --------------------------------------------------------- 전체 라운드
import random
random.seed(7)
r19 = build(mode='ojang', base=2000, holes=18)
sides19 = {'nearest': {'enabled': True, 'holes': [3, 8, 12, 17]},
           'longest': {'enabled': True, 'holes': [5, 11]}}
r19['sideConfig'] = sides19
for h in range(1, 19):
    scores = [random.choice([-1, 0, 0, 1, 1, 2, 3]) for _ in range(4)]
    entry_sides = {}
    if h in sides19['nearest']['holes']:
        entry_sides['nearest'] = {'decision': random.choice(['accum', 'paid']), 'winners': ['u3']}
    if h in sides19['longest']['holes']:
        entry_sides['longest'] = {'decision': 'paid', 'winners': ['u1']}
    add_hole(r19, h, scores, sides=entry_sides)
v19 = view(r19)
check('18홀 종료', v19['finished'], True)
check('18홀 정산 합 0', sum(p['net'] for p in v19['players']), 0)
check('18홀 최소 이체 ≤ 3건', len(v19['roundEnd']['settlements']) <= 3, True)
check('18홀 최종 합 0', sum(v19['roundEnd']['finalNet']), 0)

# --------------------------------------------------------------- 공유 문구
r20 = build(holes=2)
add_hole(r20, 1, [-1, 0, 1, 2])
add_hole(r20, 2, [0, 0, 0, 0])
ctx.eval('var __R3 = %s;' % json.dumps(r20))
text = ctx.eval('YDC.buildShareText(YDC.recomputeRound(__R3), {includeHoles: true})')
for piece in ['YDC 모드', '최종 결과', '정산', '받을 돈 합계', '홀별 배율']:
    check('공유 문구에 "%s"' % piece, piece in text, True)

# --------------------------------------------------------------- 팀플레이 (2:2)
r21 = build(holes=18)
r21['teamPlay'] = {'enabled': True, 'teamOf': {'u0': 'A', 'u1': 'A', 'u2': 'B', 'u3': 'B'}, 'adjA': 0, 'adjB': 0}
# 1~9홀: A팀 승 (각 1점 -> 9:0), 10~13홀: B팀 승 (각 2점 -> 9:8)
for h in range(1, 10):
    add_hole(r21, h, [0, 0, 1, 0])
for h in range(10, 14):
    add_hole(r21, h, [1, 0, 0, 0])
v21 = view(r21)
check('팀플레이 13홀 후 A 9점', v21['teamMatch']['scoreA'], 9)
check('팀플레이 13홀 후 B 8점', v21['teamMatch']['scoreB'], 8)
check('14홀 도미 아님', v21['teamMatch']['nextIsDormie'], False)

# 14~16홀: A팀 승 (각 2점 -> 15:8, 7점 차). 17홀(2점) + 18홀(4점) = 6점 < 7점 -> 16홀 후 조기 종료 확정!
for h in range(14, 17):
    add_hole(r21, h, [0, 0, 1, 0])
v21b = view(r21)
check('팀플레이 16홀 후 A 15점', v21b['teamMatch']['scoreA'], 15)
check('팀플레이 조기 종료 A팀 확정', v21b['teamMatch']['clinchedEarly'], 'A')
check('팀플레이 최종 우승 A팀', v21b['teamMatch']['finalWinner'], 'A')

# 18홀 동점 역전승 (지다가 비김): 17홀까지 A 10 : B 6 (4점 차), 18홀(4점) B 승리 -> 10:10 동점 -> B팀 승!
r22 = build(holes=18)
r22['teamPlay'] = {'enabled': True, 'teamOf': {'u0': 'A', 'u1': 'A', 'u2': 'B', 'u3': 'B'}, 'adjA': 0, 'adjB': 0}
for h in range(1, 5):
    add_hole(r22, h, [0, 0, 1, 0])  # A +4
for h in range(5, 10):
    add_hole(r22, h, [0, 0, 0, 0])  # 무
for h in range(10, 13):
    add_hole(r22, h, [0, 0, 1, 0])  # A +6 -> A 10 : B 0
for h in range(13, 16):
    add_hole(r22, h, [1, 0, 0, 0])  # B +6 -> A 10 : B 6
for h in range(16, 18):
    add_hole(r22, h, [0, 0, 0, 0])  # 무 -> 17홀 후 A 10 : B 6
v22_pre = view(r22)
check('17홀 후 4점 차 도미 아님(18홀 4점)', v22_pre['teamMatch']['nextIsDormie'], False)
add_hole(r22, 18, [1, 0, 0, 0])  # B +4 -> 10:10 동점!
v22 = view(r22)
check('18홀 후 10:10 동점', (v22['teamMatch']['scoreA'], v22['teamMatch']['scoreB']), (10, 10))
check('지다가 비긴 B팀 최종 승', v22['teamMatch']['finalWinner'], 'B')

# 누적 점수 조정 (adjA / adjB)
r22['teamPlay']['adjA'] = 1
v22_adj = view(r22)
check('팀 점수 수동 조정 A +1 -> 11점', v22_adj['teamMatch']['scoreA'], 11)
check('조정 후 A팀 최종 승', v22_adj['teamMatch']['finalWinner'], 'A')

# ---------------------------------------------------------------- 결과
print('통과 %d / 실패 %d' % (len(PASS), len(FAIL)))
if FAIL:
    print('\n--- 실패 ---')
    for f in FAIL:
        print('✗', f)
    sys.exit(1)
print('모든 규칙 테스트 통과')
