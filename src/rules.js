/* ============================================================================
 * YDC Golf Bet — 규칙 엔진 (순수 함수)
 *
 * 이 파일에는 DOM, localStorage, 네트워크 코드가 하나도 없다.
 * 모든 화면은 "history + initialPlayers" 만 있으면 여기서 계산된 결과를 그린다.
 * 즉, 돈 계산의 단일 원천은 history 이고, 화면은 그 결과를 표시만 한다.
 * ==========================================================================*/
var YDC = (function () {
  'use strict';

  var VERSION = '1.0.0';

  var MODE = { YDC: 'ydc', OJANG: 'ojang', TEAM: 'team', UPDOWN: 'updown' };
  function isTeamOnlyMode(m) { return m === MODE.TEAM || m === MODE.UPDOWN; }
  var SCORE_MIN = -3;
  var SCORE_MAX = 5;

  /* 언더파 보너스 배수: 버디 ×1, 이글 ×5, -3 ×10 */
  function underParUnits(score) {
    if (score <= -3) return 10;
    if (score === -2) return 5;
    if (score === -1) return 1;
    return 0;
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function clampScore(v) {
    var n = Math.round(num(v));
    if (n < SCORE_MIN) return SCORE_MIN;
    if (n > SCORE_MAX) return SCORE_MAX;
    return n;
  }

  function won(n) {
    return '₩' + Math.round(num(n)).toLocaleString('ko-KR');
  }

  function signedWon(n) {
    var v = Math.round(num(n));
    return (v > 0 ? '+' : v < 0 ? '-' : '') + '₩' + Math.abs(v).toLocaleString('ko-KR');
  }

  function scoreName(s) {
    var names = {
      '-3': '알바트로스', '-2': '이글', '-1': '버디', '0': '파',
      '1': '보기', '2': '더블보기', '3': '트리플보기', '4': '쿼드러플', '5': '펜타'
    };
    return names[String(s)] || String(s);
  }

  /* ---------------------------------------------------------------- 배율 */

  function countsOf(scores) {
    var map = {}, unique = [];
    for (var i = 0; i < scores.length; i++) {
      var s = scores[i];
      if (map[s] === undefined) { map[s] = 0; unique.push(s); }
      map[s] += 1;
    }
    return { map: map, unique: unique };
  }

  /* YDC 모드: 후보 중 가장 큰 배율 하나만 적용 (중첩 없음) */
  function ydcAnalysis(scores) {
    var list = (scores || []).map(clampScore);
    if (!list.length) return { mult: 1, notes: ['배율 없음 → ×1'], candidates: [1] };
    var c = countsOf(list);
    var n = list.length;
    var anyEdge = list.some(function (s) { return s <= -1 || s >= 3; });
    var allZero = list.every(function (s) { return s === 0; });
    var cands = [1];
    var notes = [];

    if (c.unique.length === 1) {
      if (allZero) { cands.push(10); notes.push('전원 파 → ×10'); }
      else { cands.push(5); notes.push('전원 같은 타수 → ×5'); }
    } else {
      var tie3 = false, tie2 = false;
      c.unique.forEach(function (v) {
        if (c.map[v] === 3) tie3 = true;
        if (c.map[v] === 2) tie2 = true;
      });
      if (tie3) { cands.push(3); notes.push('3명 동타 → ×3'); }
      if (tie2) { cands.push(2); notes.push('2명 동타 → ×2'); }
      if (c.unique.length === n) {
        var mn = Math.min.apply(null, c.unique);
        var mx = Math.max.apply(null, c.unique);
        if (mx - mn + 1 === n) { cands.push(5); notes.push('스트레이트 → ×5'); }
      }
    }
    if (anyEdge) { cands.push(2); notes.push('-1 이하 또는 +3 이상 발생 → ×2'); }

    return {
      mult: Math.max.apply(null, cands),
      notes: notes.length ? notes : ['배율 없음 → ×1'],
      candidates: cands
    };
  }

  /* 오장(스탠다드) 모드 */
  function ojangAnalysis(scores) {
    var list = (scores || []).map(clampScore);
    if (!list.length) return { mult: 1, notes: ['배율 없음 → ×1'], candidates: [1] };
    var notes = [];
    if (list.some(function (s) { return s <= -1; })) notes.push('언더파 발생 → ×2');
    if (list.some(function (s) { return s >= 3; })) notes.push('+3 이상 발생 → ×2');
    var mn = Math.min.apply(null, list);
    var cnt = list.filter(function (s) { return s === mn; }).length;
    if (cnt >= 2) notes.push('최저 타수 동타 → ×2');
    return {
      mult: notes.length ? 2 : 1,
      notes: notes.length ? notes : ['배율 없음 → ×1'],
      candidates: notes.length ? [1, 2] : [1]
    };
  }

  function analysisFor(mode, scores) {
    return mode === MODE.OJANG ? ojangAnalysis(scores) : ydcAnalysis(scores);
  }

  function nextMultiplier(mode, scores) {
    return analysisFor(mode, scores).mult;
  }

  /* ------------------------------------------------------- 홀 기본 정산 */

  /**
   * 모든 짝이 서로 정산: (타수 차) × 기본 배팅 × 배율
   * 낮은 타수(잘 친 사람)가 받는다.
   */
  function settlementForHole(scores, base, mult) {
    var n = scores.length;
    var pairwise = [];
    var netMoney = [];
    for (var i = 0; i < n; i++) netMoney.push(0);

    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
        if (scores[a] === scores[b]) continue;
        var better = scores[a] < scores[b] ? a : b;
        var worse = scores[a] < scores[b] ? b : a;
        var diff = Math.abs(scores[a] - scores[b]);
        var amount = diff * num(base) * num(mult);
        pairwise.push({ from: worse, to: better, amount: amount });
        netMoney[worse] -= amount;
        netMoney[better] += amount;
      }
    }
    return { pairwise: pairwise, netMoney: netMoney };
  }

  /** 언더파 보너스: 버디/이글/-3 은 나보다 못 친 모든 사람에게 각각 받는다. */
  function performanceTransfers(scores, base, mult) {
    var out = [];
    var n = scores.length;
    for (var i = 0; i < n; i++) {
      var units = underParUnits(scores[i]);
      if (!units) continue;
      var amount = units * num(base) * num(mult);
      for (var j = 0; j < n; j++) {
        if (scores[j] > scores[i]) {
          out.push({ from: j, to: i, amount: amount, side: 'performance', units: units });
        }
      }
    }
    return out;
  }

  /**
   * 최소 이체: 채권자/채무자를 금액 큰 순으로 맞춰 없앤다.
   * (기존 앱과 동일한 알고리즘 — 결과가 달라지지 않게 그대로 유지)
   */
  function simplifyTransfers(netMoney) {
    var creditors = [], debtors = [];
    netMoney.forEach(function (v, i) {
      if (v > 0) creditors.push({ i: i, amt: v });
      else if (v < 0) debtors.push({ i: i, amt: -v });
    });
    creditors.sort(function (a, b) { return b.amt - a.amt; });
    debtors.sort(function (a, b) { return b.amt - a.amt; });

    var out = [];
    var ci = 0, di = 0;
    while (ci < creditors.length && di < debtors.length) {
      var c = creditors[ci], d = debtors[di];
      var pay = Math.min(c.amt, d.amt);
      if (pay > 0) out.push({ from: d.i, to: c.i, amount: pay });
      c.amt -= pay;
      d.amt -= pay;
      if (Math.abs(c.amt) < 1e-9) ci++;
      if (Math.abs(d.amt) < 1e-9) di++;
    }
    return out;
  }

  /* ---------------------------------------------------- 니어 / 롱기 정산 */

  /** 지급 단위 = (이월 횟수 + 1) × 기본 배팅 × 배율 */
  function sideUnit(potCount, base, mult) {
    return (Math.max(0, num(potCount)) + 1) * num(base) * num(mult);
  }

  /* ------------------------------------------------------- 오너(티 순서) */

  function scoreOf(entry, uid) {
    if (!entry || !entry.uids) return null;
    var i = entry.uids.indexOf(uid);
    if (i === -1) return null;
    var s = entry.scores ? entry.scores[i] : null;
    return typeof s === 'number' ? s : null;
  }

  /**
   * 다음 홀 오너 순서.
   * 1) 직전 홀 타수 오름차순
   * 2) 같으면 앞 홀들로 거슬러 올라가며 비교
   * 3) 그래도 같으면 최초 순서
   */
  function teeOrderUids(holes, initialOrder, nextHole) {
    var uids = initialOrder.slice();
    var byHole = {};
    (holes || []).forEach(function (h) { byHole[h.hole] = h; });

    if (nextHole <= 1 || !holes || !holes.length) return uids;

    var prev = byHole[nextHole - 1] || null;

    function walkBack(aUid, bUid) {
      for (var h = nextHole - 2; h >= 1; h--) {
        var e = byHole[h];
        if (!e) continue;
        var sa = scoreOf(e, aUid), sb = scoreOf(e, bUid);
        if (sa == null || sb == null) continue;
        if (sa !== sb) return sa - sb;
      }
      var ia = initialOrder.indexOf(aUid);
      var ib = initialOrder.indexOf(bUid);
      if (ia !== -1 && ib !== -1) return ia - ib;
      return 0;
    }

    return uids.slice().sort(function (aUid, bUid) {
      var sa = scoreOf(prev, aUid), sb = scoreOf(prev, bUid);
      if (sa != null && sb != null && sa !== sb) return sa - sb;
      return walkBack(aUid, bUid);
    });
  }

  /* ------------------------------------------------ 라운드 전체 재계산 */

  function normalizeRound(round) {
    var r = round || {};
    var mode = (r.mode === MODE.OJANG || r.mode === MODE.TEAM || r.mode === MODE.UPDOWN) ? r.mode : MODE.YDC;
    var totalHoles = Math.max(1, Math.round(num(r.totalHoles) || 18));
    var baseBet = isTeamOnlyMode(mode) ? 0 : Math.max(0, Math.round(num(r.baseBet)));

    var initialPlayers = [];
    var seen = {};
    (r.initialPlayers || []).forEach(function (p, i) {
      var uid = p && p.uid ? String(p.uid) : 'p' + (i + 1);
      if (seen[uid]) return;
      seen[uid] = true;
      initialPlayers.push({
        uid: uid,
        name: String((p && p.name) || ('플레이어 ' + (i + 1))).slice(0, 20)
      });
    });

    var sideConfig = {
      nearest: { enabled: false, holes: [] },
      longest: { enabled: false, holes: [] }
    };
    ['nearest', 'longest'].forEach(function (t) {
      var c = r.sideConfig && r.sideConfig[t];
      if (!c) return;
      var holes = (c.holes || []).map(function (h) { return Math.round(num(h)); })
        .filter(function (h) { return h >= 1 && h <= totalHoles; });
      holes = holes.filter(function (h, i) { return holes.indexOf(h) === i; })
        .sort(function (a, b) { return a - b; }).slice(0, 4);
      sideConfig[t] = { enabled: !!c.enabled && holes.length > 0, holes: holes };
    });

    var history = [];
    var usedHoles = {};
    (r.history || []).forEach(function (e) {
      if (!e) return;
      var hole = Math.round(num(e.hole));
      if (hole < 1 || hole > totalHoles) return;
      if (usedHoles[hole]) return;           // 같은 홀 중복 기록은 무시
      var uids = (e.uids || []).map(String);
      if (!uids.length) return;
      for (var i = 0; i < uids.length; i++) if (!seen[uids[i]]) return; // 모르는 선수 → 무시
      var scores = uids.map(function (u, i) {
        return clampScore(e.scores && e.scores[i] != null ? e.scores[i] : 0);
      });
      usedHoles[hole] = true;
      history.push({
        hole: hole,
        uids: uids,
        scores: scores,
        doubleBy: e.doubleBy ? String(e.doubleBy) : null,
        teamOverride: (e.teamOverride === 'A' || e.teamOverride === 'B' || e.teamOverride === 'tie') ? e.teamOverride : null,
        sides: e.sides || {},
        note: e.note || ''
      });
    });
    history.sort(function (a, b) { return a.hole - b.hole; });

    var teamPlay = null;
    if (r.teamPlay && r.teamPlay.enabled && r.teamPlay.teamOf) {
      teamPlay = {
        enabled: true,
        teamOf: r.teamPlay.teamOf,
        nameA: String(r.teamPlay.nameA || '제우스').slice(0, 12),
        nameB: String(r.teamPlay.nameB || '아폴론').slice(0, 12),
        adjA: Math.round(num(r.teamPlay.adjA)),
        adjB: Math.round(num(r.teamPlay.adjB))
      };
    }

    return {
      id: String(r.id || ''),
      title: String(r.title || ''),
      mode: mode,
      baseBet: baseBet,
      totalHoles: totalHoles,
      createdAt: r.createdAt || null,
      finishedAt: r.finishedAt || null,
      initialPlayers: initialPlayers,
      teamPlay: teamPlay,
      sideConfig: sideConfig,
      history: history
    };
  }

  /**
   * history 와 initialPlayers 만으로 라운드 전체를 다시 계산한다.
   * net, points, 남은 더블, 이월 횟수, 오너 순서, 모든 이체 내역이 여기서 나온다.
   */
  function teamHolePoints(hole, totalHoles) {
    if (hole <= 9) return 1;
    if (totalHoles === 18 && hole === 18) return 4;
    return 2;
  }

  function recomputeRound(round) {
    var r = normalizeRound(round);
    var mode = r.mode;
    var base = r.baseBet;

    var players = r.initialPlayers.map(function (p) {
      return {
        uid: p.uid, name: p.name,
        net: 0, points: 0,
        doubles: mode === MODE.OJANG ? 2 : 0,
        score: 0
      };
    });
    var byUid = {};
    players.forEach(function (p) { byUid[p.uid] = p; });

    var sidePot = { nearest: 0, longest: 0 };
    var holes = [];
    var prevScores = null;

    r.history.forEach(function (entry) {
      var scores = entry.scores.slice();
      var ruleAnalysis = prevScores
        ? analysisFor(mode, prevScores)
        : { mult: 1, notes: ['첫 홀 · 기본 배율'], candidates: [1] };

      // 오장 모드 수동 더블: 규칙 배율이 2 미만일 때만, 1홀 1회, 1인 2회까지
      var doubleBy = null;
      var doubleRefused = null;
      if (entry.doubleBy && byUid[entry.doubleBy]) {
        var owner = byUid[entry.doubleBy];
        if (mode !== MODE.OJANG) doubleRefused = 'not-ojang';
        else if (ruleAnalysis.mult >= 2) doubleRefused = 'already-2x';
        else if (owner.doubles <= 0) doubleRefused = 'none-left';
        else { doubleBy = entry.doubleBy; owner.doubles -= 1; }
      }

      var mult = doubleBy ? 2 : ruleAnalysis.mult;

      var settlement = settlementForHole(scores, base, mult);
      var perfIdx = performanceTransfers(scores, base, mult);

      // 모든 이체 내역은 선수 uid 기준으로 통일한다(화면·공유가 그대로 쓴다).
      var pairwise = settlement.pairwise.map(function (t) {
        return { from: entry.uids[t.from], to: entry.uids[t.to], amount: t.amount };
      });
      var perf = perfIdx.map(function (t) {
        return { from: entry.uids[t.from], to: entry.uids[t.to], amount: t.amount, units: t.units };
      });

      var sides = {};
      ['nearest', 'longest'].forEach(function (type) {
        var cfg = r.sideConfig[type];
        if (!cfg || !cfg.enabled) return;
        if (cfg.holes.indexOf(entry.hole) === -1) return;
        var raw = (entry.sides && entry.sides[type]) || {};
        var decision = raw.decision || 'accum';
        var winners = (raw.winners || []).map(String).filter(function (u) { return !!byUid[u]; });
        var out = {
          type: type, decision: decision, winners: winners,
          potBefore: sidePot[type], transfers: [], unit: 0, potPaid: 0
        };

        if (decision === 'paid') {
          if (winners.length) {
            out.unit = sideUnit(sidePot[type], base, mult);
            out.potPaid = sidePot[type] + 1;
            var each = Math.round(out.unit / winners.length);
            var payers = entry.uids.filter(function (u) { return winners.indexOf(u) === -1; });
            payers.forEach(function (from) {
              winners.forEach(function (to) {
                out.transfers.push({ from: from, to: to, amount: each, side: type });
              });
            });
          }
          sidePot[type] = 0;
        } else if (decision === 'accum') {
          sidePot[type] += 1;
        } else if (decision === 'reset' || decision === 'void') {
          out.potBefore = sidePot[type];
          sidePot[type] = 0;
        }
        out.potAfter = sidePot[type];
        sides[type] = out;
      });

      var transfers = pairwise.slice();
      perf.forEach(function (t) { transfers.push(t); });
      ['nearest', 'longest'].forEach(function (type) {
        if (sides[type]) sides[type].transfers.forEach(function (t) { transfers.push(t); });
      });

      // 누적: 이 홀의 모든 이체(기본 + 언더파 + 사이드)를 한 번에 반영한다.
      entry.uids.forEach(function (uid, i) {
        byUid[uid].points += scores[i];
        byUid[uid].score = scores[i];
      });
      transfers.forEach(function (t) {
        byUid[t.from].net -= t.amount;
        byUid[t.to].net += t.amount;
      });

      // 이 홀만의 최소 이체 (표시용)
      var holeNet = entry.uids.map(function () { return 0; });
      transfers.forEach(function (t) {
        var fi = entry.uids.indexOf(t.from);
        var ti = entry.uids.indexOf(t.to);
        if (fi >= 0) holeNet[fi] -= t.amount;
        if (ti >= 0) holeNet[ti] += t.amount;
      });
      var holeSimplified = simplifyTransfers(holeNet).map(function (t) {
        return { from: entry.uids[t.from], to: entry.uids[t.to], amount: t.amount };
      });

      var nextAnalysis = analysisFor(mode, scores);

      holes.push({
        hole: entry.hole,
        uids: entry.uids.slice(),
        scores: scores,
        mult: mult,
        ruleMult: ruleAnalysis.mult,
        multNotes: ruleAnalysis.notes,
        doubleBy: doubleBy,
        doubleRefused: doubleRefused,
        pairwise: pairwise,
        perf: perf,
        sides: sides,
        transfers: transfers,
        simplified: holeSimplified,
        nextMult: nextAnalysis.mult,
        nextNotes: nextAnalysis.notes,
        note: entry.note || ''
      });

      prevScores = scores;
    });

    var last = holes.length ? holes[holes.length - 1] : null;
    var nextHole = last ? Math.min(r.totalHoles, last.hole + 1) : 1;
    var finished = !!r.finishedAt || (holes.length >= r.totalHoles && last && last.hole >= r.totalHoles);

    var teeOrder = teeOrderUids(holes, r.initialPlayers.map(function (p) { return p.uid; }),
      finished ? r.totalHoles + 1 : nextHole);

    // ---- YDC 모드 라운드 최종 정산 (총 타수 기준, 잘 친 사람 → 못 친 사람) ----
    var roundEndRows = [];
    if (mode === MODE.YDC && holes.length) {
      var byScoreOrder = players.map(function (p, idx) {
        return { p: p, idx: idx };
      }).sort(function (a, b) {
        if (a.p.points !== b.p.points) return a.p.points - b.p.points;
        return a.idx - b.idx;
      });
      for (var i = 0; i < byScoreOrder.length; i++) {
        for (var j = 0; j < byScoreOrder.length; j++) {
          if (i === j) continue;
          var pi = byScoreOrder[i].p;
          var pj = byScoreOrder[j].p;
          if (pi.points < pj.points) {
            roundEndRows.push({
              from: pi.uid,
              to: pj.uid,
              amount: (pj.points - pi.points) * base,
              diff: pj.points - pi.points
            });
          }
        }
      }
    }
    var roundEndAdjust = {};
    players.forEach(function (p) { roundEndAdjust[p.uid] = 0; });
    roundEndRows.forEach(function (t) {
      roundEndAdjust[t.from] -= t.amount;
      roundEndAdjust[t.to] += t.amount;
    });

    // 최종 정산(홀 정산 + 라운드 정산)을 한 번에 상계
    var finalNetArr = players.map(function (p) { return p.net + roundEndAdjust[p.uid]; });
    var finalSettlements = simplifyTransfers(finalNetArr).map(function (t) {
      return { from: players[t.from].uid, to: players[t.to].uid, amount: t.amount };
    });
    var holeOnlySettlements = simplifyTransfers(players.map(function (p) { return p.net; })).map(function (t) {
      return { from: players[t.from].uid, to: players[t.to].uid, amount: t.amount };
    });

    // ---- YDC 팀플레이 / 단독 팀플레이 / 업다운 팀플레이 계산 ----
    var teamMatch = null;
    var teamEnabled = (mode === MODE.YDC && r.teamPlay && r.teamPlay.enabled) || isTeamOnlyMode(mode);
    if (teamEnabled && r.teamPlay && players.length === 4 && r.teamPlay.teamOf) {
      var teamOf = r.teamPlay.teamOf;
      var teamA = players.filter(function (p) { return teamOf[p.uid] === 'A'; }).map(function (p) { return p.uid; });
      var teamB = players.filter(function (p) { return teamOf[p.uid] === 'B'; }).map(function (p) { return p.uid; });
      if (teamA.length === 2 && teamB.length === 2) {
        var adjA = Number(r.teamPlay.adjA || 0);
        var adjB = Number(r.teamPlay.adjB || 0);
        var scoreA = adjA, scoreB = adjB;
        var clinchedEarly = null, clinchedAtHole = null;
        var preFinalLead = null;
        var isUpdown = (mode === MODE.UPDOWN);

        function holeMaxPts(hh) {
          return isUpdown ? 2 : teamHolePoints(hh, r.totalHoles);
        }

        function remAfterHole(hh) {
          var s = 0;
          for (var k = hh + 1; k <= r.totalHoles; k++) s += holeMaxPts(k);
          return s;
        }

        holes.forEach(function (h) {
          var ptsNow = holeMaxPts(h.hole);
          var remAfter = remAfterHole(h.hole);
          var diffBefore = Math.abs(scoreA - scoreB);
          var leaderBefore = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : null;
          var trailingBefore = scoreA < scoreB ? 'A' : scoreB < scoreA ? 'B' : null;
          var wasDormie = (!clinchedEarly && h.hole < r.totalHoles && leaderBefore !== null &&
            diffBefore > remAfter && diffBefore <= ptsNow + remAfter);
          if (h.hole === r.totalHoles) preFinalLead = leaderBefore;

          var sMap = {};
          h.uids.forEach(function (u, idx) { sMap[u] = h.scores[idx]; });
          var a1 = sMap[teamA[0]] || 0, a2 = sMap[teamA[1]] || 0;
          var b1 = sMap[teamB[0]] || 0, b2 = sMap[teamB[1]] || 0;

          var gainA = 0, gainB = 0;
          var hWinner = null;
          var manualTeam = false;
          var sumA, sumB, isOdd = (h.hole % 2 === 1);
          var bestA = Math.min(a1, a2), bestB = Math.min(b1, b2);
          var worstA = Math.max(a1, a2), worstB = Math.max(b1, b2);

          if (isUpdown) {
            sumA = bestA; sumB = bestB;
            if (h.teamOverride === 'A') { gainA = 2; hWinner = 'A'; manualTeam = true; }
            else if (h.teamOverride === 'B') { gainB = 2; hWinner = 'B'; manualTeam = true; }
            else if (h.teamOverride === 'tie') { hWinner = null; manualTeam = true; }
            else {
              var birdA = (a1 <= -1 ? 1 : 0) + (a2 <= -1 ? 1 : 0);
              var birdB = (b1 <= -1 ? 1 : 0) + (b2 <= -1 ? 1 : 0);
              if (bestA < bestB) {
                gainA += (trailingBefore === 'A' && birdA >= 1) ? 2 : 1;
              } else if (bestB < bestA) {
                gainB += (trailingBefore === 'B' && birdB >= 1) ? 2 : 1;
              }
              if (worstA < worstB) {
                gainA += (trailingBefore === 'A' && birdA >= 2) ? 2 : 1;
              } else if (worstB < worstA) {
                gainB += (trailingBefore === 'B' && birdB >= 2) ? 2 : 1;
              }
              hWinner = gainA > gainB ? 'A' : gainB > gainA ? 'B' : null;
            }
            scoreA += gainA;
            scoreB += gainB;
          } else {
            sumA = isOdd ? bestA : (a1 + a2);
            sumB = isOdd ? bestB : (b1 + b2);
            hWinner = sumA < sumB ? 'A' : sumB < sumA ? 'B' : null;
            if (h.teamOverride === 'A') { hWinner = 'A'; manualTeam = true; }
            else if (h.teamOverride === 'B') { hWinner = 'B'; manualTeam = true; }
            else if (h.teamOverride === 'tie') { hWinner = null; manualTeam = true; }
            if (hWinner === 'A') { gainA = ptsNow; scoreA += ptsNow; }
            else if (hWinner === 'B') { gainB = ptsNow; scoreB += ptsNow; }
          }

          var diffAfter = Math.abs(scoreA - scoreB);
          var leaderAfter = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : null;
          var clinchedNow = false;
          if (!clinchedEarly && h.hole < r.totalHoles && leaderAfter !== null && diffAfter > remAfter) {
            clinchedEarly = leaderAfter;
            clinchedAtHole = h.hole;
            clinchedNow = true;
          }

          h.teamResult = {
            ruleType: isUpdown ? 'updown' : (isOdd ? 'best' : 'sum'),
            sumA: sumA,
            sumB: sumB,
            worstA: worstA,
            worstB: worstB,
            gainA: gainA,
            gainB: gainB,
            pts: isUpdown ? Math.max(gainA, gainB) : ptsNow,
            winner: hWinner,
            manual: manualTeam,
            scoreA: scoreA,
            scoreB: scoreB,
            wasDormie: wasDormie,
            clinchedNow: clinchedNow
          };
        });

        var curHole = finished ? r.totalHoles : nextHole;
        var curPts = holeMaxPts(curHole);
        var curRemAfter = remAfterHole(curHole);
        var diffCur = Math.abs(scoreA - scoreB);
        var leaderCur = scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : null;
        var nextIsDormie = (!finished && !clinchedEarly && curHole < r.totalHoles && leaderCur !== null &&
          diffCur > curRemAfter && diffCur <= curPts + curRemAfter);

        var finalWinner = null, winReason = '';
        if (holes.length) {
          if (scoreA > scoreB) {
            finalWinner = 'A';
            winReason = clinchedEarly ? (clinchedAtHole + '홀 조기 종료 승리') : '점수 우세 승리';
          } else if (scoreB > scoreA) {
            finalWinner = 'B';
            winReason = clinchedEarly ? (clinchedAtHole + '홀 조기 종료 승리') : '점수 우세 승리';
          } else {
            if (preFinalLead === 'A') {
              finalWinner = 'B';
              winReason = '마지막 홀 동점 역전승 (지다가 비김)';
            } else if (preFinalLead === 'B') {
              finalWinner = 'A';
              winReason = '마지막 홀 동점 역전승 (지다가 비김)';
            } else {
              finalWinner = null;
              winReason = '무승부';
            }
          }
        }

        teamMatch = {
          teamA: teamA,
          teamB: teamB,
          teamOf: teamOf,
          nameA: r.teamPlay.nameA || '제우스',
          nameB: r.teamPlay.nameB || '아폴론',
          adjA: adjA,
          adjB: adjB,
          scoreA: scoreA,
          scoreB: scoreB,
          clinchedEarly: clinchedEarly,
          clinchedAtHole: clinchedAtHole,
          nextPts: curPts,
          nextRuleType: isUpdown ? 'updown' : ((curHole % 2 === 1) ? 'best' : 'sum'),
          nextIsDormie: nextIsDormie,
          dormieLeader: nextIsDormie ? leaderCur : null,
          dormieTrailing: nextIsDormie ? (leaderCur === 'A' ? 'B' : 'A') : null,
          finalWinner: finalWinner,
          winReason: winReason
        };
      }
    }

    return {
      version: VERSION,
      round: r,
      mode: mode,
      baseBet: base,
      totalHoles: r.totalHoles,
      players: players,
      byUid: byUid,
      holes: holes,
      holeCount: holes.length,
      nextHole: finished ? r.totalHoles : nextHole,
      finished: finished,
      teeOrderUids: teeOrder,
      sidePot: sidePot,
      lastHole: last,
      teamMatch: teamMatch,
      roundEnd: {
        rows: roundEndRows,
        adjust: roundEndAdjust,
        finalNet: finalNetArr,
        settlements: finalSettlements,
        holeOnlySettlements: holeOnlySettlements
      },
      nextAnalysis: last ? analysisFor(mode, last.scores) : { mult: 1, notes: ['첫 홀 · 기본 배율'], candidates: [1] }
    };
  }

  /* ------------------------------------------------------------- 검증 */

  function validateRound(round) {
    var problems = [];
    if (!round || typeof round !== 'object') return { ok: false, problems: ['라운드 데이터가 없습니다.'] };
    var players = round.initialPlayers || [];
    if (players.length < 2) problems.push('선수가 2명 이상이어야 합니다.');
    if (players.length > 4) problems.push('선수는 최대 4명입니다.');
    var names = players.map(function (p) { return (p.name || '').trim(); });
    names.forEach(function (n, i) { if (!n) problems.push((i + 1) + '번 선수 이름이 비어 있습니다.'); });
    if (!round.totalHoles || round.totalHoles < 1) problems.push('홀 수가 올바르지 않습니다.');
    var holes = (round.history || []).map(function (h) { return h.hole; });
    for (var i = 1; i < holes.length; i++) {
      if (holes[i] !== holes[i - 1] + 1) { problems.push('홀 기록이 연속되지 않습니다.'); break; }
    }
    return { ok: problems.length === 0, problems: problems };
  }

  /* --------------------------------------------------- 공유용 텍스트 */

  function pad(s, n) {
    s = String(s);
    var w = 0;
    for (var i = 0; i < s.length; i++) w += (s.charCodeAt(i) > 255 ? 2 : 1);
    var out = s;
    while (w < n) { out += ' '; w += 1; }
    return out;
  }

  function buildShareText(view, opts) {
    opts = opts || {};
    var r = view.round;
    var nameOf = {};
    view.players.forEach(function (p) { nameOf[p.uid] = p.name; });

    var modeLabel = view.mode === MODE.OJANG ? '오장 모드'
      : view.mode === MODE.TEAM ? '팀플레이'
      : view.mode === MODE.UPDOWN ? '업다운 팀플레이'
      : 'YDC 모드';
    var lines = [];
    var title = (r.title || '').trim() || ('YDC 골프 내기 · ' + modeLabel);
    lines.push('⛳ ' + title);
    lines.push(modeLabel + ' · ' + view.totalHoles + '홀' + (isTeamOnlyMode(view.mode) ? '' : ' · 기본 ' + won(view.baseBet) + '/타'));
    lines.push('');

    if (!isTeamOnlyMode(view.mode)) {
      // 최종 순위 (최종 정산액 기준)
      var ranked = view.players.map(function (p, i) {
        return { name: p.name, net: p.net, adj: view.roundEnd.adjust[p.uid] || 0, final: view.roundEnd.finalNet[i], points: p.points };
      }).sort(function (a, b) { return b.final - a.final; });

      lines.push('■ 최종 결과');
      ranked.forEach(function (p, i) {
        var sign = p.final > 0 ? '+' : p.final < 0 ? '-' : '';
        lines.push((i + 1) + '. ' + p.name + '  ' + p.points + '타  ' + sign + won(Math.abs(p.final)));
      });
      lines.push('');

      if (view.mode === MODE.YDC && view.roundEnd.rows.length) {
        lines.push('■ 타수 차이 돌려주기');
        view.roundEnd.rows.forEach(function (t) {
          lines.push(nameOf[t.from] + ' → ' + nameOf[t.to] + ': ' + won(t.amount) + ' (' + t.diff + '타 차)');
        });
        lines.push('');
      }

      // 정산 내역
      lines.push(view.mode === MODE.YDC ? '■ 최종 정산 (돌려준 후)' : '■ 정산');
      if (view.roundEnd.settlements.length === 0) {
        lines.push('정산할 금액이 없습니다.');
      } else {
        view.roundEnd.settlements.forEach(function (t) {
          lines.push(nameOf[t.from] + ' → ' + nameOf[t.to] + ': ' + won(t.amount));
        });
      }
    }

    if (opts.includeHoles && view.holes.length) {
      lines.push('');
      lines.push('■ 홀별 배율');
      var parts = view.holes.map(function (h) {
        return 'H' + h.hole + ' ×' + h.mult;
      });
      lines.push(parts.join(' · '));
    }

    if (view.teamMatch) {
      var tm = view.teamMatch;
      var namesA = tm.teamA.map(function (u) { return nameOf[u]; }).join('·');
      var namesB = tm.teamB.map(function (u) { return nameOf[u]; }).join('·');
      lines.push('');
      lines.push('■ 팀플레이 (2:2)');
      lines.push(tm.nameA + '(' + namesA + ') ' + tm.scoreA + '점 vs ' + tm.scoreB + '점 ' + tm.nameB + '(' + namesB + ')');
      if (tm.finalWinner) {
        var winTeamName = tm.finalWinner === 'A' ? tm.nameA : tm.nameB;
        var winNames = tm.finalWinner === 'A' ? namesA : namesB;
        lines.push('우승: ' + winTeamName + '(' + winNames + ') · ' + tm.winReason);
      } else {
        lines.push('결과: 무승부');
      }
    }

    if (!isTeamOnlyMode(view.mode)) {
      var receive = 0, pay = 0;
      view.roundEnd.finalNet.forEach(function (v) { if (v > 0) receive += v; else pay += -v; });
      lines.push('');
      lines.push('받을 돈 합계 ' + won(receive) + ' / 줄 돈 합계 ' + won(pay));
    }
    return lines.join('\n');
  }

  return {
    VERSION: VERSION,
    MODE: MODE,
    isTeamOnlyMode: isTeamOnlyMode,
    SCORE_MIN: SCORE_MIN,
    SCORE_MAX: SCORE_MAX,
    underParUnits: underParUnits,
    clampScore: clampScore,
    won: won,
    signedWon: signedWon,
    scoreName: scoreName,
    ydcAnalysis: ydcAnalysis,
    ojangAnalysis: ojangAnalysis,
    analysisFor: analysisFor,
    nextMultiplier: nextMultiplier,
    settlementForHole: settlementForHole,
    performanceTransfers: performanceTransfers,
    simplifyTransfers: simplifyTransfers,
    sideUnit: sideUnit,
    teeOrderUids: teeOrderUids,
    normalizeRound: normalizeRound,
    teamHolePoints: teamHolePoints,
    recomputeRound: recomputeRound,
    validateRound: validateRound,
    buildShareText: buildShareText
  };
})();
