/* ============================================================================
 * YDC Golf Bet — 화면
 *
 * 원칙
 *  - 네트워크를 쓰지 않는다(요청 0건). 모든 계산은 YDC(규칙 엔진)에서만 한다.
 *  - 상태 변경 → 즉시 저장 → 다시 그리기. 화면과 저장본이 어긋날 수 없다.
 *  - 모든 입력은 이벤트 위임(data-act)으로 처리한다. 리스너가 쌓여 멈추는 일 없음.
 * ==========================================================================*/
var App = (function () {
  'use strict';

  var S = {
    round: null,        // 현재 라운드(저장 형식 그대로)
    screen: 'home',     // home | setup | play | result | summary | archive
    reading: null,      // 지난 라운드 열람용
    setup: null,
    theme: 'light',
    pending: false      // 처리 중 중복 탭 방지
  };

  var R = null;         // 현재 라운드의 재계산 결과 캐시

  /* ------------------------------------------------------------- 유틸 */

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function won(n) { return YDC.won(n); }
  function signed(n) { return YDC.signedWon(n); }
  function modeLabel(mode) {
    if (mode === 'ojang') return '오장 모드';
    if (mode === 'team') return '팀플레이';
    if (mode === 'updown') return '업다운 팀플레이';
    return 'YDC 모드';
  }

  function toast(msg, ms) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 1900);
  }

  function haptic() {
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
  }

  function todayLabel(ts) {
    var d = ts ? new Date(ts) : new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
  }

  function roundTitle(r) { return ((r && r.title) || '').trim() || '제목 없는 라운드'; }

  function roundMeta(r, v) {
    v = v || YDC.recomputeRound(r);
    return todayLabel(r.createdAt) + ' · ' + modeLabel(r.mode) + ' · ' + v.holeCount + '홀 · ' +
      v.players.length + '명';
  }

  function trashSVG() {
    return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      '<path d="M4 7h16"/><path d="M9.5 4.5h5"/>' +
      '<path d="M6.6 7l.9 12.1a1.9 1.9 0 0 0 1.9 1.9h5.2a1.9 1.9 0 0 0 1.9-1.9L17.4 7"/>' +
      '<path d="M10.2 11v6.2"/><path d="M13.8 11v6.2"/></svg>';
  }

  /* ------------------------------------------------------------- 모달 */

  var modalResolve = null;

  function closeModal(result) {
    var back = $('#modalBack');
    if (back) back.parentNode.removeChild(back);
    if (modalResolve) {
      var r = modalResolve;
      modalResolve = null;
      r(result);
    }
  }

  function showModal(opts) {
    closeModal(null);
    var actionsHTML = (opts.buttons || [{ label: '확인', value: 'ok', kind: 'primary' }]).map(function (b) {
      return '<button class="btn ' + (b.kind === 'primary' ? 'btn-primary' : b.kind === 'gold' ? 'btn-gold'
        : b.kind === 'danger' ? 'btn-danger' : 'btn-ghost') + '" data-modal="' + esc(b.value) + '">' +
        esc(b.label) + '</button>';
    }).join('');

    var back = document.createElement('div');
    back.className = 'modal-back';
    back.id = 'modalBack';
    back.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
        (opts.title ? '<h3>' + esc(opts.title) + '</h3>' : '') +
        '<div class="modal-body">' + (opts.body || '') + '</div>' +
        '<div class="modal-actions">' + actionsHTML + '</div>' +
      '</div>';
    document.body.appendChild(back);

    return new Promise(function (resolve) {
      modalResolve = resolve;
      back.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-modal]');
        if (btn) {
          var v = btn.getAttribute('data-modal');
          document.body.removeChild(back);
          if (modalResolve) { var r = modalResolve; modalResolve = null; r(v); }
          return;
        }
        if (e.target === back) {
          document.body.removeChild(back);
          if (modalResolve) { var r2 = modalResolve; modalResolve = null; r2(null); }
        }
      });
    });
  }

  function confirmModal(title, body, okLabel, danger) {
    return showModal({
      title: title,
      body: body,
      buttons: [
        { label: okLabel || '확인', value: 'ok', kind: danger ? 'danger' : 'primary' },
        { label: '취소', value: 'no', kind: 'ghost' }
      ]
    }).then(function (v) { return v === 'ok'; });
  }

  /* ------------------------------------------------------- 라운드 삭제 */

  // 삭제 전 확인: 어떤 라운드인지(제목·날짜·모드·홀수) 모달에 보여 주고 한 번 더 묻는다.
  function askDeleteRound(r) {
    var body =
      '<div class="del-round">' +
        '<div class="bold">' + esc(roundTitle(r)) + '</div>' +
        '<div class="tiny muted">' + esc(roundMeta(r)) + '</div>' +
      '</div>' +
      '<div class="small mt">이 라운드 기록을 이 기기에서 지웁니다. 되돌릴 수 없습니다.</div>';
    confirmModal('라운드 삭제', body, '삭제', true).then(function (okay) {
      if (!okay) return;
      deleteRound(r.id);
    });
  }

  // localStorage 와 IndexedDB 보관함에서 같이 지우고 화면을 바로 다시 그린다.
  // 그 라운드가 '끝난 라운드'(진행 중 저장본)로도 남아 있으면 그것까지 같이 비운다.
  function deleteRound(id) {
    var active = Store.loadActiveSync();
    var alsoActive = !!(active && active.id === id && active.finishedAt);
    var wasReading = !!(S.reading && S.reading.id === id);
    var viewingSame = !!(S.round && S.round.id === id);

    try { Store.removeFromArchive(id); } catch (e) {}
    if (alsoActive) { try { Store.clearActive(); } catch (e) {} }
    if (wasReading) S.reading = null;
    if (alsoActive || viewingSame) S.round = null;

    if (wasReading || viewingSame) S.screen = 'home';
    else if (S.screen !== 'archive') S.screen = 'home';

    render();
    window.scrollTo(0, 0);
    toast('삭제했습니다');
  }

  /* --------------------------------------------------------- 저장/계산 */

  function recompute() {
    R = S.round ? YDC.recomputeRound(S.round) : null;
    return R;
  }

  function save() {
    if (!S.round || S.reading) return;
    S.round.screen = S.screen;
    Store.saveActive(S.round);
  }

  function nameOf(uid) {
    if (!R) return uid;
    return (R.byUid[uid] && R.byUid[uid].name) || uid;
  }

  /* --------------------------------------------------------- 문구/뷰 조각 */

  function header() {
    var home = S.screen !== 'home'
      ? '<button class="icon-btn" data-act="nav:home" aria-label="홈">⌂</button>' : '';
    var dark = S.theme === 'dark';
    return '' +
      '<div class="topbar">' +
        '<div class="brand"><span class="flag">⛳</span><span>YDC 골프 내기</span></div>' +
        '<div class="spacer"></div>' +
        '<button class="icon-btn" data-act="ui:theme" aria-label="화면 테마">' + (dark ? '☀' : '☾') + '</button>' +
        home +
      '</div>';
  }

  function txList(rows) {
    if (!rows || !rows.length) return '<div class="empty">주고받을 돈이 없습니다.</div>';
    return '<ul class="tx-list">' + rows.map(function (t) {
      return '<li><span class="who">' + esc(nameOf(t.from)) + ' → ' + esc(nameOf(t.to)) + '</span>' +
        '<span class="amt">' + won(t.amount) + '</span></li>';
    }).join('') + '</ul>';
  }

  function netClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : ''; }

  /* ------------------------------------------------------------- 홈 */

  function viewHome() {
    var active = Store.loadActiveSync();
    var finished = active && active.finishedAt;
    var archive = Store.loadArchive();

    var continueCard = '';
    if (active) {
      var av = YDC.recomputeRound(active);
      var canDiscard = !av.holeCount;
      var title = (active.title || '').trim() || '제목 없는 라운드';
      continueCard =
        '<div class="card">' +
          '<div class="pill green">' + (finished ? '끝난 라운드' : '진행 중') + '</div>' +
          '<div style="font-weight:900;font-size:1.12rem;margin:8px 0 2px">' + esc(title) + '</div>' +
          '<div class="small muted">' + modeLabel(active.mode) + ' · ' + av.holeCount + '/' + active.totalHoles +
            '홀 · ' + av.players.length + '명</div>' +
          (canDiscard ? '<div class="mt"><button class="btn btn-ghost btn-sm" data-act="round:discard" style="width:100%">아직 기록 없음 · 이 라운드 버리기</button></div>' : '') +
          '<div class="mt"><button class="btn btn-primary" data-act="nav:resume">' +
            (finished ? '결과 보기' : (active.draft && active.draft.hole ? '이어서 하기 (' + (active.draft.hole) + '홀)' : '이어서 하기')) +
          '</button></div>' +
        '</div>';
    }

    var list = archive.slice(0, 3).map(function (r) {
      var v = YDC.recomputeRound(r);
      var bestIdx = 0;
      for (var bi = 1; bi < v.roundEnd.finalNet.length; bi++) {
        if (v.roundEnd.finalNet[bi] > v.roundEnd.finalNet[bestIdx]) bestIdx = bi;
      }
      var topName = v.players.length ? v.players[bestIdx].name : '';
      var topVal = v.roundEnd.finalNet.length ? v.roundEnd.finalNet[bestIdx] : 0;
      return '<div class="round-item">' +
        '<div class="grow">' +
          '<div class="title">' + esc((r.title || '').trim() || '라운드') + '</div>' +
          '<div class="tiny muted">' + todayLabel(r.createdAt) + ' · ' + modeLabel(r.mode) + ' · ' +
            v.holeCount + '홀 · 1위 ' + esc(topName) + ' ' + signed(topVal) + '</div>' +
        '</div>' +
        '<div class="round-actions">' +
          '<button class="btn btn-soft btn-sm" data-act="archive:open" data-id="' + esc(r.id) + '">보기</button>' +
          '<button class="round-del" data-act="archive:del" data-id="' + esc(r.id) + '" ' +
            'aria-label="' + esc(roundTitle(r)) + ' 삭제" title="라운드 삭제">' + trashSVG() + '</button>' +
        '</div>' +
      '</div>';
    }).join('');

    return header() +
      '<div class="hero">' +
        '<h1>YDC 골프 내기</h1>' +
        '<p>홀마다 자동 저장 · <span class="gold">인터넷 없이</span> 그대로 동작</p>' +
      '</div>' +
      continueCard +
      '<button class="btn btn-gold" data-act="nav:setup" style="min-height:60px;font-size:1.12rem">＋ 새 라운드 시작</button>' +
      '<div class="section-label">지난 라운드</div>' +
      '<div class="card tight">' +
        (list || '<div class="empty">아직 저장된 라운드가 없습니다.</div>') +
        (archive.length > 3 ? '<button class="btn btn-ghost btn-sm" data-act="nav:archive" style="width:100%;margin-top:10px">전체 ' + archive.length + '개 보기</button>' : '') +
      '</div>' +
      '<button class="btn btn-ghost btn-sm" data-act="ui:rules" style="width:100%;margin-bottom:12px">규칙 보기</button>' +
      '<div class="card tight">' +
        '<div class="small bold">아이폰 홈 화면에 추가</div>' +
        '<div class="tiny muted mt">사파리에서 이 페이지를 연 뒤 <b>공유 → 홈 화면에 추가</b>를 누르면 앱처럼 열려요. 한 번 열어 두면 비행기 모드에서도 실행됩니다.</div>' +
      '</div>';
  }

  /* ------------------------------------------------------------- 설정 */

  function defaultSetup() {
    var prefs = Store.loadPrefs() || {};
    var m = (prefs.mode === 'ojang' || prefs.mode === 'team' || prefs.mode === 'updown') ? prefs.mode : 'ydc';
    return {
      mode: m,
      title: '',
      baseBet: prefs.baseBet || 1000,
      count: prefs.count || 4,
      totalHoles: prefs.totalHoles || 18,
      names: (prefs.names || []).slice(0, 4),
      shuffle: prefs.shuffle === false ? false : true,
      teamPlay: {
        enabled: !!(prefs.teamPlay && prefs.teamPlay.enabled),
        nameA: (prefs.teamPlay && prefs.teamPlay.nameA) || '제우스',
        nameB: (prefs.teamPlay && prefs.teamPlay.nameB) || '아폴론',
        teams: (prefs.teamPlay && prefs.teamPlay.teams && prefs.teamPlay.teams.length === 4)
          ? prefs.teamPlay.teams.slice(0, 4) : ['A', 'A', 'B', 'B']
      },
      side: {
        nearest: { enabled: false, holes: [null, null, null, null] },
        longest: { enabled: false, holes: [null, null, null, null] }
      }
    };
  }

  function setupNames(cfg) {
    var out = [];
    for (var i = 0; i < 4; i++) {
      var v = (cfg.names && cfg.names[i]) || '';
      if (i < cfg.count) out.push(v);
    }
    return out;
  }

  function sideSelectHTML(type, idx, cfg) {
    var cur = cfg.side[type].holes[idx];
    var opts = '<option value="">없음</option>';
    for (var h = 1; h <= cfg.totalHoles; h++) {
      var used = cfg.side[type].holes.indexOf(h) !== -1 && cfg.side[type].holes.indexOf(h) !== idx;
      if (used) continue;
      opts += '<option value="' + h + '"' + (cur === h ? ' selected' : '') + '>' + h + '</option>';
    }
    return '<select class="input" data-act="setup:hole" data-type="' + type + '" data-idx="' + idx + '" ' +
      'style="min-height:46px;padding:8px 10px;font-size:.95rem;text-align:center"' +
      (cfg.side[type].enabled ? '' : ' disabled') + '>' + opts + '</select>';
  }

  var GREEK_GODS = ['제우스', '아폴론', '포세이돈', '아레스', '헤르메스', '아테나', '아르테미스', '헤라', '디오니소스', '헤파이스토스'];

  function godSelectHTML(which, cur) {
    return '<select class="input" data-act="setup:team-name" data-team="' + which + '" ' +
      'style="min-height:40px;padding:6px 10px;font-size:.9rem;font-weight:700">' +
      GREEK_GODS.map(function (g) {
        return '<option value="' + g + '"' + (g === cur ? ' selected' : '') + '>' + g + '</option>';
      }).join('') +
    '</select>';
  }

  function viewSetup() {
    var cfg = S.setup || (S.setup = defaultSetup());
    var teamOnly = YDC.isTeamOnlyMode(cfg.mode);
    if (teamOnly) cfg.count = 4;
    var names = setupNames(cfg);
    var showTeam = (cfg.mode === 'ydc' && cfg.count === 4) || teamOnly;
    var tp = cfg.teamPlay || (cfg.teamPlay = { enabled: false, nameA: '제우스', nameB: '아폴론', teams: ['A', 'A', 'B', 'B'] });
    var tpOn = teamOnly || (showTeam && !!tp.enabled);
    var nameA = tp.nameA || '제우스';
    var nameB = tp.nameB || '아폴론';

    var teamTop = '';
    if (showTeam) {
      var teamHeader = teamOnly
        ? '<div class="bold" style="font-size:.95rem">2:2 팀 편성 (그리스 신)</div>' +
          '<div class="tiny muted">' + (cfg.mode === 'updown'
            ? '잘친 사람끼리 1점 + 못친 사람끼리 1점 · 지는 팀 버디 2점(2명 다 버디 4점)'
            : '전반 1 · 10~17홀 2 · 18홀 4점 · 홀수 베스트볼 / 짝수 합산') + '</div>'
        : '<div class="switch-row">' +
            '<div><div class="bold" style="font-size:.95rem">2:2 팀플레이</div>' +
            '<div class="tiny muted">전반 1 · 10~17홀 2 · 18홀 4점 · 홀수 베스트볼 / 짝수 합산</div></div>' +
            '<label class="switch"><input type="checkbox" data-act="setup:team-toggle"' + (tpOn ? ' checked' : '') + '><span></span></label>' +
          '</div>';
      teamTop = '<div class="card tight" style="margin-bottom:10px">' +
        teamHeader +
        (tpOn ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">' +
          '<div><div class="tiny muted bold" style="margin-bottom:4px">팀 1 (그리스 신)</div>' + godSelectHTML('A', nameA) + '</div>' +
          '<div><div class="tiny muted bold" style="margin-bottom:4px">팀 2 (그리스 신)</div>' + godSelectHTML('B', nameB) + '</div>' +
        '</div>' : '') +
      '</div>';
    }

    var nameInputs = '';
    for (var i = 0; i < cfg.count; i++) {
      var teamPick = '';
      if (tpOn) {
        var curT = tp.teams[i] === 'B' ? 'B' : 'A';
        teamPick = '<div class="seg" style="width:146px;flex-shrink:0">' +
          '<button data-act="setup:team-pick" data-idx="' + i + '" data-team="A" class="' + (curT === 'A' ? 'on' : '') + '" style="font-size:.82rem;padding:0 6px">' + esc(nameA) + '</button>' +
          '<button data-act="setup:team-pick" data-idx="' + i + '" data-team="B" class="' + (curT === 'B' ? 'on' : '') + '" style="font-size:.82rem;padding:0 6px">' + esc(nameB) + '</button>' +
        '</div>';
      }
      nameInputs += '<div class="field" style="margin-bottom:10px">' +
        '<label>' + (i === 0 ? '1번 (첫 홀 오너 후보)' : (i + 1) + '번') + '</label>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<input class="input" type="text" maxlength="12" placeholder="이름" data-act="setup:name" data-idx="' + i + '" value="' + esc(names[i] || '') + '">' +
          teamPick +
        '</div>' +
      '</div>';
    }

    var sideBlock = ['nearest', 'longest'].map(function (type) {
      var label = type === 'nearest' ? '니어리스트 (Nearest)' : '롱기스트 (Longest)';
      var cfgT = cfg.side[type];
      return '<div class="card tight" style="margin-bottom:10px">' +
        '<div class="switch-row">' +
          '<div><div class="bold">' + label + '</div>' +
          '<div class="tiny muted">지정 홀 최다 근접/최장타 승자에게 지급 · 무승자면 이월</div></div>' +
          '<label class="switch"><input type="checkbox" data-act="setup:side" data-type="' + type + '"' +
            (cfgT.enabled ? ' checked' : '') + '><span></span></label>' +
        '</div>' +
        (cfgT.enabled ? '<div class="hole-selects mt">' +
          [0, 1, 2, 3].map(function (k) { return sideSelectHTML(type, k, cfg); }).join('') +
          '</div><div class="tiny muted mt">최대 4개 홀까지 지정할 수 있습니다.</div>' : '') +
      '</div>';
    }).join('');

    var modeNote = cfg.mode === 'ojang'
      ? '언더파·+3 이상·최저타 동타가 나오면 다음 홀 ×2. 개인별 <b>더블 2회</b> 사용 가능(1홀 1회, 이미 2배면 사용 안 됨).'
      : cfg.mode === 'team'
      ? '개인 돈 내기 없이 <b>2:2 팀전</b>만 진행합니다. 전반 1점·후반 2점·18홀 4점, 홀수홀 베스트볼·짝수홀 합산, 도미 홀 및 마지막 홀 동점 역전승.'
      : cfg.mode === 'updown'
      ? '팀에서 <b>잘친 사람끼리 1점 + 못친 사람끼리 1점</b> 대결합니다. 지고 있는 팀에서 1명 버디 시 <b>2점</b>, 2명 다 버디 시 <b>4점</b>(도미 홀 · 동점 역전승 포함).'
      : '전원 파 ×10 · 전원 동타 ×5 · 스트레이트 ×5 · 3명 동타 ×3 · 2명 동타 ×2 · 언더파/+3 이상 ×2 중 <b>가장 큰 하나</b>만 적용.';

    return header() +
      '<div class="page-title">라운드 설정</div>' +

      '<div class="field"><label>모드</label>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
          '<button class="btn ' + (cfg.mode === 'ydc' ? 'btn-primary' : 'btn-ghost') + '" data-act="setup:mode" data-mode="ydc" style="min-height:46px">YDC</button>' +
          '<button class="btn ' + (cfg.mode === 'ojang' ? 'btn-primary' : 'btn-ghost') + '" data-act="setup:mode" data-mode="ojang" style="min-height:46px">오장 (스탠다드)</button>' +
          '<button class="btn ' + (cfg.mode === 'team' ? 'btn-primary' : 'btn-ghost') + '" data-act="setup:mode" data-mode="team" style="min-height:46px">팀플레이</button>' +
          '<button class="btn ' + (cfg.mode === 'updown' ? 'btn-primary' : 'btn-ghost') + '" data-act="setup:mode" data-mode="updown" style="min-height:46px">업다운 팀플레이</button>' +
        '</div>' +
        '<div class="note mt">' + modeNote + '</div>' +
      '</div>' +

      '<div class="field"><label>라운드 이름 (선택)</label>' +
        '<input class="input" type="text" maxlength="30" placeholder="예: 금요일 자유CC" data-act="setup:title" value="' + esc(cfg.title) + '">' +
      '</div>' +

      (teamOnly ? '' :
        '<div class="field"><label>기본 배팅 (₩ / 타)</label>' +
          '<input class="input mono" type="number" inputmode="numeric" min="0" step="500" data-act="setup:base" value="' + cfg.baseBet + '">' +
          '<div class="chips mt">' +
            [1000, 2000, 3000, 5000, 10000].map(function (v) {
              return '<button data-act="setup:base-chip" data-v="' + v + '" class="' + (cfg.baseBet === v ? 'on' : '') + '">' + v.toLocaleString('ko-KR') + '</button>';
            }).join('') +
          '</div>' +
        '</div>' +

        '<div class="field"><label>인원</label>' +
          '<div class="seg">' + [2, 3, 4].map(function (n) {
            return '<button data-act="setup:count" data-n="' + n + '" class="' + (cfg.count === n ? 'on' : '') + '">' + n + '명</button>';
          }).join('') + '</div>' +
        '</div>') +

      '<div class="field"><label>홀 수</label>' +
        '<div class="seg">' + [9, 18].map(function (n) {
          return '<button data-act="setup:holes" data-n="' + n + '" class="' + (cfg.totalHoles === n ? 'on' : '') + '">' + n + '홀</button>';
        }).join('') + '</div>' +
      '</div>' +

      '<div class="section-label">선수</div>' + teamTop + nameInputs +

      '<div class="switch-row card tight" style="margin-bottom:12px">' +
        '<div><div class="bold" style="font-size:.95rem">시작 순서 섞기</div>' +
        '<div class="tiny muted">첫 홀 오너를 무작위로 정합니다</div></div>' +
        '<label class="switch"><input type="checkbox" data-act="setup:shuffle"' + (cfg.shuffle ? ' checked' : '') + '><span></span></label>' +
      '</div>' +

      '<div class="section-label">사이드 게임</div>' + sideBlock +

      '<button class="btn btn-primary" data-act="setup:start" style="min-height:60px;font-size:1.1rem;margin-top:6px">라운드 시작</button>' +
      '<div style="height:16px"></div>';
  }

  /* ----------------------------------------------------------- 플레이 */

  function preView() {
    // 마지막 홀을 수정하는 중이면, 그 홀을 뺀 상태를 기준으로 배율/더블 잔여를 계산한다.
    if (S.round && S.round.editing) {
      var copy = JSON.parse(JSON.stringify(S.round));
      copy.history = (copy.history || []).slice(0, -1);
      return YDC.recomputeRound(copy);
    }
    return R;
  }

  function draftOf(pv) {
    var hole = pv.nextHole;
    var d = S.round.draft;
    var uids = pv.teeOrderUids;
    if (!d || d.hole !== hole) {
      d = { hole: hole, scores: {}, sides: {}, doubleBy: null };
      uids.forEach(function (u) { d.scores[u] = 0; });
      S.round.draft = d;
    }
    uids.forEach(function (u) { if (d.scores[u] == null) d.scores[u] = 0; });
    return d;
  }

  function sideTypesForHole(hole) {
    var out = [];
    ['nearest', 'longest'].forEach(function (t) {
      var c = S.round.sideConfig && S.round.sideConfig[t];
      if (c && c.enabled && c.holes.indexOf(hole) !== -1) out.push(t);
    });
    return out;
  }

  function hasFutureSide(type, hole) {
    var c = S.round.sideConfig && S.round.sideConfig[type];
    if (!c) return false;
    return c.holes.some(function (h) { return h > hole; });
  }

  function previewNet(pv, d, uids) {
    var mult = d.doubleBy ? 2 : (pv.nextAnalysis ? pv.nextAnalysis.mult : 1);
    var scores = uids.map(function (u) { return YDC.clampScore(d.scores[u]); });
    var s = YDC.settlementForHole(scores, S.round.baseBet, mult);
    var net = s.netMoney.slice();
    YDC.performanceTransfers(scores, S.round.baseBet, mult).forEach(function (t) {
      net[t.from] -= t.amount; net[t.to] += t.amount;
    });
    return { net: net, mult: mult, scores: scores };
  }

  function viewPlay() {
    var pv = preView();
    var d = draftOf(pv);
    var hole = d.hole;
    var uids = pv.teeOrderUids;
    var editing = !!S.round.editing;
    var activeSides = sideTypesForHole(hole);
    var pvSides = pv.sidePot || { nearest: 0, longest: 0 };

    var ruleMult = pv.nextAnalysis ? pv.nextAnalysis.mult : 1;
    var mult = d.doubleBy ? 2 : ruleMult;
    var per = S.round.baseBet * mult;

    var doublesLeft = {};
    pv.players.forEach(function (p) { doublesLeft[p.uid] = p.doubles; });
    var doubleOwner = d.doubleBy;

    var rows = uids.map(function (uid, idx) {
      var p = pv.byUid[uid];
      var s = YDC.clampScore(d.scores[uid]);
      var cls = s < 0 ? 'under' : s > 0 ? 'over' : '';
      var role = idx === 0 ? '오너' : (idx + 1) + '번';
      var sideChips = activeSides.map(function (type) {
        var label = type === 'nearest' ? '니어' : '롱기';
        var cur = (d.sides[type] && d.sides[type][uid]) || 'none';
        return '<div class="side-chips" data-side-row="' + type + '">' +
          '<span class="side-label">' + label + '</span>' +
          '<button data-act="play:side" data-type="' + type + '" data-uid="' + esc(uid) + '" data-val="win" class="' + (cur === 'win' ? 'on' : '') + '">' + label + ' 승</button>' +
          '<button data-act="play:side" data-type="' + type + '" data-uid="' + esc(uid) + '" data-val="erase" class="erase ' + (cur === 'erase' ? 'on' : '') + '">지우개</button>' +
        '</div>';
      }).join('');

      var doubleBtn = '';
      if (S.round.mode === 'ojang') {
        var left = doublesLeft[uid] || 0;
        var on = doubleOwner === uid;
        var disabled = on ? false : (!left || mult >= 2 || (doubleOwner && doubleOwner !== uid));
        doubleBtn = '<button class="double-btn ' + (on ? 'on' : '') + '" data-act="play:double" data-uid="' + esc(uid) + '"' +
          (disabled ? ' disabled' : '') + '>' +
          (on ? '더블 적용됨 ×2 (다시 누르면 해제)' :
            (left ? '더블 ×2 · ' + left + '회 남음' : '더블 사용 완료')) +
          '</button>';
      }

      return '<div class="player ' + (idx === 0 ? 'honor' : '') + '" data-player="' + esc(uid) + '">' +
        '<div class="player-head">' +
          '<span class="role ' + (idx === 0 ? 'honor' : '') + '">' + role + '</span>' +
          '<span class="name">' + esc(p.name) + '</span>' +
          '<span class="delta" data-delta="' + esc(uid) + '"></span>' +
        '</div>' +
        '<div class="score-row">' +
          '<button class="stepper" data-act="play:inc" data-uid="' + esc(uid) + '" data-d="-1" aria-label="타수 줄이기">−</button>' +
          '<button class="score-btn ' + cls + '" data-act="play:grid" data-uid="' + esc(uid) + '">' +
            '<span class="num">' + (s > 0 ? '+' + s : s) + '</span>' +
            '<span class="word">' + YDC.scoreName(s) + '</span>' +
          '</button>' +
          '<button class="stepper" data-act="play:inc" data-uid="' + esc(uid) + '" data-d="1" aria-label="타수 늘리기">＋</button>' +
        '</div>' +
        sideChips +
        doubleBtn +
      '</div>';
    }).join('');

    var sideNote = activeSides.length ? '<div class="note mt">' + activeSides.map(function (t) {
      var label = t === 'nearest' ? '니어리스트' : '롱기스트';
      var pot = pvSides[t] || 0;
      return label + ': ' + (pot > 0 ? '<b>' + (pot + 1) + '배</b> 걸려 있음 (이월 ' + pot + '회)' : '1배');
    }).join(' · ') + '</div>' : '';

    var teamOnlyMode = YDC.isTeamOnlyMode(S.round.mode);
    var draftSummary = '';
    if (!teamOnlyMode) {
      var pn = previewNet(pv, d, uids);
      draftSummary = '<div class="note mt" id="previewLine">' + previewLineHTML(uids, pn.net) + '</div>';
    }

    var teamBanner = '';
    if (pv.teamMatch) {
      var tm = pv.teamMatch;
      var tA = tm.nameA || '제우스';
      var tB = tm.nameB || '아폴론';
      var namesA = tm.teamA.map(nameOf).join('·');
      var namesB = tm.teamB.map(nameOf).join('·');
      var ov = d.teamOverride || 'auto';
      var dormieHtml = '';
      if (tm.clinchedEarly) {
        var winN = tm.clinchedEarly === 'A' ? namesA : namesB;
        var winT = tm.clinchedEarly === 'A' ? tA : tB;
        dormieHtml = '<div class="note mt" style="background:rgba(247,187,7,.16);border-color:rgba(247,187,7,.5);font-weight:800">' +
          '🏆 ' + esc(winT) + '(' + esc(winN) + ') 승리 확정 (조기 종료)</div>';
      } else if (tm.nextIsDormie) {
        var trN = tm.dormieTrailing === 'A' ? namesA : namesB;
        var trT = tm.dormieTrailing === 'A' ? tA : tB;
        dormieHtml = '<div class="note warn mt" style="font-weight:800">' +
          '⚠️ 도미 홀 · ' + esc(trT) + '(' + esc(trN) + ')이 이 홀을 못 이기면 경기 조기 종료!</div>';
      }
      var ruleLabel = tm.nextRuleType === 'updown' ? '업다운 (잘친1+못친1)' : tm.nextRuleType === 'best' ? '베스트볼' : '합산';
      teamBanner = '<div class="card tight mt">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<div class="small bold">팀플레이 · ' + tm.nextPts + '점 (' + ruleLabel + ')' +
            (tm.nextIsDormie ? ' <span class="tag" style="background:var(--gold);color:#111">도미 홀</span>' : '') + '</div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<div class="small bold">' + esc(tA) + '(' + esc(namesA) + ') ' + tm.scoreA + ' : ' + tm.scoreB + ' ' + esc(tB) + '(' + esc(namesB) + ')</div>' +
            '<button class="btn btn-ghost btn-sm" data-act="play:team-adj" style="min-height:30px;padding:4px 8px;font-size:.78rem">점수 조정</button>' +
          '</div>' +
        '</div>' +
        dormieHtml +
        '<div class="chips mt" style="margin-top:8px">' +
          '<button data-act="play:team" data-v="auto" class="' + (ov === 'auto' ? 'on' : '') + '">자동(타수합)</button>' +
          '<button data-act="play:team" data-v="A" class="' + (ov === 'A' ? 'on' : '') + '">' + esc(tA) + ' 승</button>' +
          '<button data-act="play:team" data-v="B" class="' + (ov === 'B' ? 'on' : '') + '">' + esc(tB) + ' 승</button>' +
          '<button data-act="play:team" data-v="tie" class="' + (ov === 'tie' ? 'on' : '') + '">무승부</button>' +
        '</div>' +
      '</div>';
    }

    return header() +
      '<div class="hole-head">' +
        '<div class="hole-num">' +
          '<div class="label">' + (editing ? '수정 중' : 'HOLE') + '</div>' +
          '<div class="value">' + hole + '<small>/' + S.round.totalHoles + '</small></div>' +
        '</div>' +
        '<div class="mult-box">' +
          (teamOnlyMode
            ? '<div class="top"><span class="mult" style="font-size:1.15rem">' + esc(modeLabel(S.round.mode)) + '</span></div>' +
              '<div class="why">2:2 팀 대결 · 개인 내기 없음</div>' +
              '<div class="per">타수 입력 후 완료를 누르세요</div>'
            : '<div class="top"><span class="mult">×' + mult + '</span>' +
                '<span class="pill ' + (mult > 1 ? 'gold' : '') + '">' + (d.doubleBy ? '더블' : '배율') + '</span></div>' +
              '<div class="why">' + (S.round.mode === 'ojang' ? '오장' : 'YDC') + ' · ' +
                (d.doubleBy ? '더블 적용' : (pv.nextAnalysis && pv.nextAnalysis.notes ? pv.nextAnalysis.notes.join(' · ') : '기본')) + '</div>' +
              '<div class="per">기본 ' + won(S.round.baseBet) + ' × ' + mult + ' = <b>' + won(per) + ' / 타</b></div>') +
        '</div>' +
      '</div>' +
      (sideNote ? sideNote : '') +
      teamBanner +
      '<div class="mt">' + rows + '</div>' +
      draftSummary +
      '<div style="height:90px"></div>' +
      '<div class="footer-bar"><div class="footer-inner">' +
        '<button class="btn btn-ghost side-btn" data-act="play:menu" aria-label="메뉴">⋯</button>' +
        '<button class="btn btn-primary" data-act="play:finish">' + (editing ? '수정 저장' : hole + '홀 완료') + '</button>' +
      '</div></div>';
  }

  function previewLineHTML(uids, net) {
    var parts = uids.map(function (u, i) {
      if (!net[i]) return '';
      return esc(nameOf(u)) + ' ' + signed(net[i]);
    }).filter(Boolean);
    return parts.length ? '<b>이 홀 예상:</b> ' + parts.join(' · ') : '<span class="muted">타수를 입력하면 예상 정산이 보입니다.</span>';
  }

  function refreshPreview() {
    var pv = preView();
    var d = draftOf(pv);
    var uids = pv.teeOrderUids;
    var pn = previewNet(pv, d, uids);
    uids.forEach(function (u, i) {
      var el = document.querySelector('[data-delta="' + u + '"]');
      if (el) {
        el.textContent = pn.net[i] ? signed(pn.net[i]) : '';
        el.className = 'delta ' + netClass(pn.net[i]);
      }
    });
    var line = document.querySelector('#previewLine');
    if (line) line.innerHTML = previewLineHTML(uids, pn.net);
  }

  function updateScoreUI(uid) {
    var pv = preView();
    var d = draftOf(pv);
    var s = YDC.clampScore(d.scores[uid]);
    var card = document.querySelector('[data-player="' + uid + '"]');
    if (!card) return;
    var btn = card.querySelector('.score-btn');
    if (btn) {
      btn.className = 'score-btn ' + (s < 0 ? 'under' : s > 0 ? 'over' : '');
      btn.querySelector('.num').textContent = s > 0 ? '+' + s : String(s);
      btn.querySelector('.word').textContent = YDC.scoreName(s);
    }
    refreshPreview();
  }

  /* ----------------------------------------------------------- 결과 */

  function viewResult() {
    var v = R;
    var h = v.lastHole;
    if (!h) return viewPlay();

    var chips = h.uids.map(function (uid, i) {
      var s = h.scores[i];
      var cls = s < 0 ? 'under' : s > 0 ? 'over' : '';
      return '<span class="score-chip ' + cls + '">' + esc(nameOf(uid)) + ' <b>' + (s > 0 ? '+' + s : s) + '</b>' +
        '<span class="tiny">' + YDC.scoreName(s) + '</span></span>';
    }).join('');

    var sideTx = [];
    ['nearest', 'longest'].forEach(function (t) {
      if (h.sides[t]) h.sides[t].transfers.forEach(function (x) {
        sideTx.push({ from: x.from, to: x.to, amount: x.amount, tag: t === 'nearest' ? '니어' : '롱기' });
      });
    });
    h.perf.forEach(function (x) {
      sideTx.push({ from: x.from, to: x.to, amount: x.amount, tag: '언더파' });
    });

    var isFinal = h.hole >= S.round.totalHoles;
    var nextMult = h.nextMult;

    var totalsRows = v.players.map(function (p) {
      return '<tr><td>' + esc(p.name) + '</td><td class="num ' + netClass(p.net) + '">' + signed(p.net) + '</td>' +
        '<td class="num">' + (p.points > 0 ? '+' + p.points : p.points) + '</td></tr>';
    }).join('');

    var teamResCard = '';
    if (v.teamMatch && h.teamResult) {
      var tm2 = v.teamMatch;
      var tr = h.teamResult;
      var tA2 = tm2.nameA || '제우스';
      var tB2 = tm2.nameB || '아폴론';
      var nA = tm2.teamA.map(nameOf).join('·');
      var nB = tm2.teamB.map(nameOf).join('·');
      var resLine;
      if (tr.ruleType === 'updown') {
        var ptsParts = [];
        if (tr.gainA > 0) ptsParts.push(esc(tA2) + ' +' + tr.gainA + '점');
        if (tr.gainB > 0) ptsParts.push(esc(tB2) + ' +' + tr.gainB + '점');
        resLine = '<b>' + (ptsParts.length ? ptsParts.join(' · ') : '무승부 (0점)') + '</b>' + (tr.manual ? ' (수동 수정)' : '');
      } else {
        resLine = tr.winner
          ? '<b>' + esc(tr.winner === 'A' ? tA2 : tB2) + '(' + esc(tr.winner === 'A' ? nA : nB) + ') +' + tr.pts + '점</b>' + (tr.manual ? ' (수동 수정)' : '')
          : '<b>무승부 (0점)</b>' + (tr.manual ? ' (수동 수정)' : '');
      }
      var alertLine = '';
      if (tr.clinchedNow) {
        var cw = tm2.clinchedEarly === 'A' ? nA : nB;
        var ct = tm2.clinchedEarly === 'A' ? tA2 : tB2;
        alertLine = '<div class="note mt" style="background:rgba(247,187,7,.16);border-color:rgba(247,187,7,.5);font-weight:800">' +
          '🏆 ' + esc(ct) + '(' + esc(cw) + ') 승리 확정 · 경기가 조기 종료되었습니다!</div>';
      } else if (!isFinal && tm2.nextIsDormie) {
        var dt = tm2.dormieTrailing === 'A' ? nA : nB;
        var dtt = tm2.dormieTrailing === 'A' ? tA2 : tB2;
        alertLine = '<div class="note warn mt" style="font-weight:800">' +
          '⚠️ 다음 ' + (h.hole + 1) + '번 홀은 도미 홀입니다 (' + esc(dtt) + ' ' + esc(dt) + ' 패/무 시 조기 종료)</div>';
      }
      var rTitle = tr.ruleType === 'updown' ? '업다운 팀플레이' : '팀플레이 (' + tr.pts + '점 · ' + (tr.ruleType === 'best' ? '베스트볼' : '합산') + ')';
      var rDetail = tr.ruleType === 'updown'
        ? esc(tA2) + ' (잘친 ' + (tr.sumA > 0 ? '+' + tr.sumA : tr.sumA) + ' / 못친 ' + (tr.worstA > 0 ? '+' + tr.worstA : tr.worstA) + ') vs ' +
          esc(tB2) + ' (잘친 ' + (tr.sumB > 0 ? '+' + tr.sumB : tr.sumB) + ' / 못친 ' + (tr.worstB > 0 ? '+' + tr.worstB : tr.worstB) + ') → ' + resLine
        : esc(tA2) + '(' + esc(nA) + ') ' + (tr.ruleType === 'best' ? '최저' : '합') + ' ' + (tr.sumA > 0 ? '+' + tr.sumA : tr.sumA) +
          ' vs ' + esc(tB2) + '(' + esc(nB) + ') ' + (tr.ruleType === 'best' ? '최저' : '합') + ' ' + (tr.sumB > 0 ? '+' + tr.sumB : tr.sumB) + ' → ' + resLine;
      teamResCard = '<div class="card">' +
        '<div class="bold" style="margin-bottom:6px">' + rTitle + (tr.wasDormie ? ' · 도미 홀' : '') + '</div>' +
        '<div class="small">' + rDetail + '</div>' +
        '<div class="small muted mt">누적 점수: <b>' + esc(tA2) + ' ' + tr.scoreA + '</b> : <b>' + tr.scoreB + ' ' + esc(tB2) + '</b></div>' +
        alertLine +
      '</div>';
    }

    var resTeamOnly = YDC.isTeamOnlyMode(S.round.mode);

    return header() +
      '<div class="card">' +
        '<div class="result-head">' +
          '<div class="hole">' + h.hole + '번 홀 결과</div>' +
          '<div class="sub">' + (resTeamOnly ? esc(modeLabel(S.round.mode)) : ('기본 ' + won(S.round.baseBet) + ' × ' + h.mult + ' = ' + won(S.round.baseBet * h.mult) + ' / 타' +
            (h.doubleBy ? ' · ' + esc(nameOf(h.doubleBy)) + ' 더블' : ''))) + '</div>' +
        '</div>' +
        '<div class="score-chips">' + chips + '</div>' +
        (!resTeamOnly && h.multNotes && h.multNotes.length ? '<div class="tiny muted center">이 홀 배율: ' + esc(h.multNotes.join(' · ')) + '</div>' : '') +
      '</div>' +

      (resTeamOnly ? '' :
        '<div class="card">' +
          '<div class="bold" style="margin-bottom:8px">이 홀 정산</div>' +
          txList(h.simplified) +
          (sideTx.length ?
            '<div class="tiny muted bold">내역 상세 (위 정산에 포함)</div>' +
            '<ul class="tx-list">' + sideTx.map(function (t) {
              return '<li><span class="who">' + esc(nameOf(t.from)) + ' → ' + esc(nameOf(t.to)) +
                ' <span class="tag">' + t.tag + '</span></span><span class="amt">' + won(t.amount) + '</span></li>';
            }).join('') + '</ul>' : '') +
          '<details class="mt"><summary class="small muted">1:1 전체 내역 보기</summary>' +
            '<ul class="tx-list mt">' + h.pairwise.map(function (t) {
              return '<li><span class="who">' + esc(nameOf(t.from)) + ' → ' + esc(nameOf(t.to)) +
                '</span><span class="amt">' + won(t.amount) + '</span></li>';
            }).join('') + '</ul>' +
          '</details>' +
        '</div>' +

        '<div class="next-mult">' +
          '<span class="x">×' + nextMult + '</span>' +
          '<span>' + (isFinal ? '마지막 홀입니다' : '다음 홀 배율 · ' + esc((h.nextNotes || []).join(' · '))) + '</span>' +
        '</div>') +

      (resTeamOnly ? '' :
        '<div class="card mt">' +
          '<div class="bold" style="margin-bottom:6px">누적 현황</div>' +
          '<table class="data"><thead><tr><th>선수</th><th class="num">누적</th><th class="num">타수</th></tr></thead>' +
          '<tbody>' + totalsRows + '</tbody></table>' +
        '</div>') +

      teamResCard +

      '<div class="btn-row">' +
        '<button class="btn btn-ghost" data-act="play:undo">홀 취소</button>' +
        '<button class="btn btn-ghost" data-act="play:edit">이 홀 수정</button>' +
      '</div>' +
      '<div class="mt">' +
        '<button class="btn btn-primary" data-act="result:next">' + (isFinal ? '라운드 결과 보기' : (h.hole + 1) + '홀 시작') + '</button>' +
      '</div>' +
      '<div style="height:20px"></div>';
  }

  /* ----------------------------------------------------------- 요약 */

  function viewSummary() {
    var v = R;
    var reading = S.reading;
    var mode = v.mode;
    var sumTeamOnly = YDC.isTeamOnlyMode(mode);
    var ranked = v.players.map(function (p, i) {
      return {
        uid: p.uid, name: p.name, points: p.points, net: p.net,
        adj: v.roundEnd.adjust[p.uid] || 0, final: v.roundEnd.finalNet[i]
      };
    }).sort(function (a, b) { return sumTeamOnly ? (a.points - b.points) : (b.final - a.final); });

    var rankRows = ranked.map(function (p, i) {
      return '<tr>' +
        '<td class="num" style="width:28px;color:var(--muted)">' + (i + 1) + '</td>' +
        '<td>' + esc(p.name) + '</td>' +
        '<td class="num">' + (p.points > 0 ? '+' + p.points : p.points) + '</td>' +
        (sumTeamOnly ? '' :
          (mode === 'ydc' ? '<td class="num ' + netClass(p.net) + '">' + (p.net ? signed(p.net) : '–') + '</td>' : '') +
          (mode === 'ydc' ? '<td class="num ' + netClass(p.adj) + '">' + (p.adj ? signed(p.adj) : '–') + '</td>' : '') +
          '<td class="num ' + netClass(p.final) + '"><b>' + signed(p.final) + '</b></td>') +
      '</tr>';
    }).join('');

    var returnCard = '';
    if (mode === 'ydc') {
      var returnList = v.roundEnd.rows.length
        ? '<ul class="tx-list">' + v.roundEnd.rows.map(function (t) {
            return '<li><span class="who">' + esc(nameOf(t.from)) + ' → ' + esc(nameOf(t.to)) +
              ' <span class="tiny muted">(' + t.diff + '타 차)</span></span>' +
              '<span class="amt">' + won(t.amount) + '</span></li>';
          }).join('') + '</ul>'
        : '<div class="small muted">전원 동타로 돌려줄 금액이 없습니다.</div>';
      returnCard =
        '<div class="card">' +
          '<div class="bold" style="margin-bottom:4px">타수 차이 돌려주기</div>' +
          '<div class="tiny muted" style="margin-bottom:8px">타수가 적은 사람이 많은 사람에게 (타수 차 × 기본 배팅)을 돌려줍니다.</div>' +
          returnList +
        '</div>';
    }

    var settleRows = v.roundEnd.settlements.map(function (t) {
      return { from: t.from, to: t.to, amount: t.amount };
    });

    var receive = 0, pay = 0;
    v.roundEnd.finalNet.forEach(function (x) { if (x > 0) receive += x; else pay += -x; });

    var holeRows = v.holes.map(function (h) {
      var line = h.uids.map(function (u, i) {
        var s = h.scores[i];
        return esc(nameOf(u)) + ' ' + (s > 0 ? '+' + s : s);
      }).join(' · ');
      return '<div class="history-row">' +
        '<div class="hole-badge">' + h.hole + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="small bold">×' + h.mult + (h.doubleBy ? ' (더블)' : '') +
            (h.teamResult ? ' · 팀 ' + (h.teamResult.winner ? h.teamResult.winner + '승(+' + h.teamResult.pts + ')' : '무') +
              (h.teamResult.wasDormie ? ' [도미]' : '') : '') + '</div>' +
          '<div class="tiny muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + line + '</div>' +
        '</div>' +
        '<div class="tiny ' + (h.simplified.length ? 'muted' : '') + '">' +
          (h.simplified.length ? h.simplified.map(function (t) {
            return esc(nameOf(t.from)) + '→' + esc(nameOf(t.to)) + ' ' + won(t.amount);
          }).join('<br>') : '정산 없음') + '</div>' +
      '</div>';
    }).join('');

    var teamSummaryCard = '';
    if (v.teamMatch) {
      var tm3 = v.teamMatch;
      var tA3 = tm3.nameA || '제우스';
      var tB3 = tm3.nameB || '아폴론';
      var nmA = tm3.teamA.map(nameOf).join(' · ');
      var nmB = tm3.teamB.map(nameOf).join(' · ');
      var winBanner = tm3.finalWinner
        ? '<div class="note" style="background:rgba(247,187,7,.16);border-color:rgba(247,187,7,.5);font-weight:900;font-size:1rem;margin-bottom:10px">' +
            '🏆 ' + esc(tm3.finalWinner === 'A' ? tA3 : tB3) + ' (' + esc(tm3.finalWinner === 'A' ? nmA : nmB) + ') 최종 우승! · ' + esc(tm3.winReason) + '</div>'
        : '<div class="note" style="font-weight:800;margin-bottom:10px">🤝 무승부</div>';
      teamSummaryCard = '<div class="card">' +
        '<div class="bold" style="margin-bottom:8px">2:2 팀플레이 결과</div>' +
        winBanner +
        '<ul class="tx-list">' +
          '<li><span class="who">' + esc(tA3) + ' (' + esc(nmA) + ')</span><span class="amt">' + tm3.scoreA + '점</span></li>' +
          '<li><span class="who">' + esc(tB3) + ' (' + esc(nmB) + ')</span><span class="amt">' + tm3.scoreB + '점</span></li>' +
        '</ul>' +
      '</div>';
    }

    return header() +
      '<div class="page-title">' + esc((v.round.title || '').trim() || '라운드 결과') + '</div>' +
      '<div class="small muted" style="margin:-8px 2px 12px">' + modeLabel(mode) + ' · ' + v.holeCount + '/' + v.totalHoles +
        '홀' + (sumTeamOnly ? '' : ' · 기본 ' + won(v.baseBet) + '/타') + ' · ' + todayLabel(v.round.createdAt) + '</div>' +

      (sumTeamOnly ? teamSummaryCard : '') +

      '<div class="card">' +
        '<table class="data compact">' +
          '<thead><tr><th></th><th>선수</th><th class="num">타수</th>' +
            (sumTeamOnly ? '' :
              (mode === 'ydc' ? '<th class="num">홀</th><th class="num">돌려주기</th>' : '') +
              '<th class="num">최종</th>') + '</tr></thead>' +
          '<tbody>' + rankRows + '</tbody>' +
        '</table>' +
        (mode === 'ydc' ? '<div class="tiny muted mt">최종 = 홀 정산 + 돌려주기 (타수 적은 사람이 많은 사람에게 타수 차 × 기본 배팅)</div>' : '') +
      '</div>' +

      (sumTeamOnly ? '' : returnCard + teamSummaryCard +
        '<div class="card">' +
          '<div class="bold" style="margin-bottom:4px">' + (mode === 'ydc' ? '최종 정산 (돌려준 후)' : '최종 정산') + '</div>' +
          (mode === 'ydc' ? '<div class="tiny muted" style="margin-bottom:8px">홀 정산과 타수 차이 돌려주기를 모두 합산한 최종 금액입니다.</div>' : '') +
          txList(settleRows) +
          '<div class="print-line"></div>' +
          '<div class="small">받을 돈 합계 <b class="pos">' + won(receive) + '</b> · 줄 돈 합계 <b class="neg">' + won(pay) + '</b></div>' +
        '</div>') +

      '<div class="card">' +
        '<details><summary class="bold">홀별 기록 (' + v.holeCount + '홀)</summary>' +
          '<div class="mt">' + holeRows + '</div>' +
        '</details>' +
      '</div>' +

      (reading
        ? '<div class="btn-row">' +
            '<button class="btn btn-ghost" data-act="nav:home">홈으로</button>' +
            '<button class="btn btn-danger" data-act="archive:del" data-id="' + esc(v.round.id) + '">라운드 삭제</button>' +
          '</div>'
        : '<div class="btn-row">' +
            '<button class="btn btn-ghost" data-act="share:text">텍스트 복사</button>' +
            '<button class="btn btn-gold" data-act="share:card">결과 카드 공유</button>' +
          '</div>' +
          '<div class="mt"><button class="btn btn-primary" data-act="summary:new">새 라운드 시작</button></div>' +
          '<div class="mt"><button class="btn btn-ghost btn-sm" data-act="summary:edit" style="width:100%">마지막 홀 점검 · 수정</button></div>') +
      '<div style="height:20px"></div>';
  }

  /* ----------------------------------------------------------- 보관함 */

  function viewArchive() {
    var list = Store.loadArchive();
    var body = list.length ? list.map(function (r) {
      var v = YDC.recomputeRound(r);
      var best = v.players.slice().sort(function (a, b) { return b.net - a.net; })[0];
      return '<div class="round-item">' +
        '<div class="grow">' +
          '<div class="title">' + esc((r.title || '').trim() || '라운드') + '</div>' +
          '<div class="tiny muted">' + todayLabel(r.createdAt) + ' · ' + modeLabel(r.mode) + ' · ' + v.holeCount + '홀' +
            (best ? ' · 1위 ' + esc(best.name) : '') + '</div>' +
        '</div>' +
        '<div class="round-actions">' +
          '<button class="btn btn-soft btn-sm" data-act="archive:open" data-id="' + esc(r.id) + '">보기</button>' +
          '<button class="round-del" data-act="archive:del" data-id="' + esc(r.id) + '" ' +
            'aria-label="' + esc(roundTitle(r)) + ' 삭제" title="라운드 삭제">' + trashSVG() + '</button>' +
        '</div>' +
      '</div>';
    }).join('') : '<div class="empty">저장된 라운드가 없습니다.</div>';

    return header() +
      '<div class="page-title">지난 라운드</div>' +
      '<div class="card tight">' + body + '</div>' +
      '<div class="tiny muted center">최근 30개까지 저장됩니다. 기기 안에만 보관돼요.</div>';
  }

  /* ----------------------------------------------------------- 렌더 */

  function render() {
    var root = $('#root');
    if (!root) return;
    try {
      if (S.screen === 'setup') { root.innerHTML = viewSetup(); return; }
      if (S.screen === 'archive') { root.innerHTML = viewArchive(); return; }
      if (!S.round) { S.screen = 'home'; root.innerHTML = viewHome(); return; }

      R = YDC.recomputeRound(S.round);

      if (S.screen === 'play') root.innerHTML = viewPlay();
      else if (S.screen === 'result') root.innerHTML = viewResult();
      else if (S.screen === 'summary') root.innerHTML = viewSummary();
      else { S.screen = 'home'; root.innerHTML = viewHome(); }
    } catch (err) {
      console.error(err);
      root.innerHTML = header() +
        '<div class="card"><div class="note warn"><b>화면을 그리는 중 문제가 생겼습니다.</b><br>' +
        esc(err && err.message ? err.message : String(err)) + '</div>' +
        '<div class="mt"><button class="btn btn-primary" data-act="nav:home">홈으로</button></div></div>';
    }
  }

  function go(screen) {
    S.screen = screen;
    save();
    render();
    window.scrollTo(0, 0);
  }

  /* ------------------------------------------------------- 라운드 시작 */

  function startRound() {
    var cfg = S.setup || defaultSetup();
    var names = setupNames(cfg).map(function (n) { return (n || '').trim(); });
    if (names.length < 2) { toast('선수가 2명 이상이어야 합니다'); return; }
    if (names.some(function (n) { return !n; })) { toast('모든 선수 이름을 입력하세요'); return; }
    var uniq = {};
    for (var i = 0; i < names.length; i++) {
      if (uniq[names[i]]) { toast('이름이 겹칩니다: ' + names[i]); return; }
      uniq[names[i]] = true;
    }
    var baseBet = YDC.isTeamOnlyMode(cfg.mode) ? 0 : Math.max(0, Math.round(Number(cfg.baseBet) || 0));
    if (!YDC.isTeamOnlyMode(cfg.mode) && baseBet <= 0) { toast('기본 배팅을 입력하세요'); return; }

    var teamPlayCfg = null;
    if (YDC.isTeamOnlyMode(cfg.mode) || (cfg.mode === 'ydc' && cfg.count === 4 && cfg.teamPlay && cfg.teamPlay.enabled)) {
      var ts = cfg.teamPlay.teams || ['A', 'A', 'B', 'B'];
      var cntA = ts.filter(function (t) { return t !== 'B'; }).length;
      if (cntA !== 2) { toast('팀플레이는 A팀 2명, B팀 2명으로 나누어야 합니다'); return; }
      teamPlayCfg = { enabled: true, teams: ts.slice(0, 4) };
    }

    // 진행 중이던 라운드가 있으면 지우지 말고 보관함에 남긴다(데이터 유실 방지).
    if (S.round && (S.round.history || []).length) {
      var prev = S.round;
      prev.finishedAt = prev.finishedAt || Date.now();
      Store.addToArchive(prev);
    }

    var players = names.map(function (n, idx) {
      return { uid: Store.newUid(), name: n, team: teamPlayCfg ? (teamPlayCfg.teams[idx] === 'B' ? 'B' : 'A') : null };
    });

      var teamPlayRound = null;
    if (teamPlayCfg) {
      var teamOf = {};
      players.forEach(function (p) { teamOf[p.uid] = p.team; });
      teamPlayRound = {
        enabled: true,
        teamOf: teamOf,
        nameA: (cfg.teamPlay && cfg.teamPlay.nameA) || '제우스',
        nameB: (cfg.teamPlay && cfg.teamPlay.nameB) || '아폴론',
        adjA: 0,
        adjB: 0
      };
    }

    // 시작 순서: 섞기 옵션이 켜져 있으면 무작위
    if (cfg.shuffle) {
      for (var k = players.length - 1; k > 0; k--) {
        var j = Math.floor(Math.random() * (k + 1));
        var tmp = players[k]; players[k] = players[j]; players[j] = tmp;
      }
    }

    var sideConfig = { nearest: { enabled: false, holes: [] }, longest: { enabled: false, holes: [] } };
    ['nearest', 'longest'].forEach(function (t) {
      var c = cfg.side[t];
      var holes = (c.holes || []).filter(function (h) { return h != null && h !== ''; })
        .map(Number).filter(function (h) { return h >= 1 && h <= cfg.totalHoles; })
        .filter(function (h, idx, arr) { return arr.indexOf(h) === idx; })
        .sort(function (a, b) { return a - b; }).slice(0, 4);
      sideConfig[t] = { enabled: !!c.enabled && holes.length > 0, holes: holes };
    });

    S.round = {
      id: Store.newId(),
      title: (cfg.title || '').trim(),
      mode: cfg.mode,
      baseBet: baseBet,
      totalHoles: cfg.totalHoles,
      createdAt: Date.now(),
      finishedAt: null,
      initialPlayers: players.map(function (p) { return { uid: p.uid, name: p.name }; }),
      teamPlay: teamPlayRound,
      sideConfig: sideConfig,
      history: [],
      draft: null,
      editing: false,
      screen: 'play'
    };

    var v = YDC.validateRound(S.round);
    if (!v.ok) { toast(v.problems[0]); return; }

    Store.savePrefs({
      mode: cfg.mode,
      baseBet: baseBet,
      count: cfg.count,
      totalHoles: cfg.totalHoles,
      names: names,
      shuffle: cfg.shuffle,
      teamPlay: cfg.teamPlay
    });

    R = recompute();
    S.round.draft = null;
    S.screen = 'play';
    save();
    render();
    window.scrollTo(0, 0);
  }

  /* --------------------------------------------------------- 홀 마감 */

  function currentEntryInput() {
    var pv = preView();
    var d = draftOf(pv);
    var uids = pv.teeOrderUids;
    var scores = uids.map(function (u) { return YDC.clampScore(d.scores[u]); });

    return {
      pv: pv,
      draft: d,
      entry: {
        hole: d.hole,
        uids: uids.slice(),
        scores: scores,
        doubleBy: d.doubleBy || null,
        teamOverride: d.teamOverride && d.teamOverride !== 'auto' ? d.teamOverride : null,
        sides: {}
      }
    };
  }

  async function finishHole() {
    if (S.pending) return;
    S.pending = true;
    try {
      var ctx = currentEntryInput();
      var d = ctx.draft;
      var entry = ctx.entry;
      var hole = entry.hole;
      var base = S.round.baseBet;
      var mult = d.doubleBy ? 2 : (ctx.pv.nextAnalysis ? ctx.pv.nextAnalysis.mult : 1);
      var activeSides = sideTypesForHole(hole);

      for (var i = 0; i < activeSides.length; i++) {
        var type = activeSides[i];
        var label = type === 'nearest' ? '니어리스트' : '롱기스트';
        var winners = entry.uids.filter(function (u) {
          return (d.sides[type] && d.sides[type][u]) === 'win';
        });
        var eraser = entry.uids.some(function (u) {
          return (d.sides[type] && d.sides[type][u]) === 'erase';
        });
        var pot = (ctx.pv.sidePot && ctx.pv.sidePot[type]) || 0;
        var decision;

        if (winners.length > 0 && !eraser) {
          decision = 'paid';
        } else if (!hasFutureSide(type, hole)) {
          await showModal({
            title: label + ' · 무승자',
            body: '<div class="small">마지막으로 지정된 ' + label + ' 홀입니다. 승자가 없어 이번 사이드 게임은 <b>없던 것으로</b> 처리합니다.' +
              (pot > 0 ? ' (걸려 있던 ' + (pot + 1) + '배는 소멸)' : '') + '</div>',
            buttons: [{ label: '확인', value: 'ok', kind: 'primary' }]
          });
          decision = 'void';
        } else {
          var unitNow = YDC.sideUnit(pot, base, mult);
          var answer = await showModal({
            title: label + ' · 어떻게 할까요?',
            body: '<div class="small" style="line-height:1.6">' +
              (pot > 0 ? '지금 걸려 있는 금액: <b>' + (pot + 1) + '배 = ' + won(unitNow) + '</b><br>' : '') +
              (winners.length ? '선택한 승자: <b>' + winners.map(nameOf).join(', ') + '</b><br>' : '승자가 지정되지 않았습니다.<br>') +
              (eraser ? '지우개가 선택되어 있습니다.<br>' : '') +
              '</div>',
            buttons: [
              { label: winners.length ? '지금 정산 (' + won(unitNow) + ')' : '그냥 넘어가기', value: 'pay', kind: 'primary' },
              { label: '이월하기 (+1배)', value: 'acc', kind: 'ghost' },
              { label: '이월 초기화', value: 'reset', kind: 'ghost' }
            ]
          });
          if (answer === 'pay') decision = winners.length ? 'paid' : 'skip';
          else if (answer === 'acc') decision = 'accum';
          else if (answer === 'reset') decision = 'reset';
          else decision = 'skip';
        }

        entry.sides[type] = {
          decision: decision,
          winners: decision === 'paid' ? winners : []
        };
      }

      // 기록 저장 (수정이면 마지막 홀 교체, 아니면 추가)
      if (S.round.editing) {
        S.round.history = (S.round.history || []).slice(0, -1);
        S.round.editing = false;
      }
      S.round.history = (S.round.history || []).filter(function (h) { return h.hole !== hole; });
      S.round.history.push(entry);
      S.round.history.sort(function (a, b) { return a.hole - b.hole; });
      S.round.draft = null;

      var isFinal = hole >= S.round.totalHoles;
      if (isFinal) S.round.finishedAt = S.round.finishedAt || Date.now();

      R = recompute();
      S.screen = 'result';

      if (isFinal) {
        Store.addToArchive(S.round);
      }
      save();
      render();
      window.scrollTo(0, 0);
      haptic();
    } catch (err) {
      console.error(err);
      toast('저장 중 문제가 생겼습니다. 다시 시도해 주세요.');
    } finally {
      S.pending = false;
    }
  }

  function undoLast() {
    if (!S.round || !S.round.history.length) { toast('취소할 홀이 없습니다'); return; }
    var last = S.round.history[S.round.history.length - 1];
    showModal({
      title: last.hole + '번 홀 기록 취소',
      body: '<div class="small">' + last.hole + '번 홀 기록을 지우고 다시 입력합니다. 이후 누적 금액도 자동으로 다시 계산됩니다.</div>',
      buttons: [
        { label: '기록 취소', value: 'ok', kind: 'danger' },
        { label: '그대로 두기', value: 'no', kind: 'ghost' }
      ]
    }).then(function (v) {
      if (v !== 'ok') return;
      S.round.history = S.round.history.slice(0, -1);
      S.round.finishedAt = null;
      S.round.editing = false;
      S.round.draft = null;
      R = recompute();
      S.screen = 'play';
      draftOf(R);
      save();
      render();
      window.scrollTo(0, 0);
      toast(last.hole + '번 홀을 취소했습니다');
    });
  }

  function editLast() {
    if (!S.round || !S.round.history.length) { toast('수정할 홀이 없습니다'); return; }
    var last = S.round.history[S.round.history.length - 1];
    var d = { hole: last.hole, scores: {}, sides: {}, doubleBy: last.doubleBy || null, teamOverride: last.teamOverride || 'auto' };
    last.uids.forEach(function (u, i) {
      d.scores[u] = last.scores[i];
      ['nearest', 'longest'].forEach(function (t) {
        if (!d.sides[t]) d.sides[t] = {};
        d.sides[t][u] = (last.sides && last.sides[t] && last.sides[t].winners || []).indexOf(u) !== -1 ? 'win' : 'none';
      });
    });
    S.round.draft = d;
    S.round.editing = true;
    S.screen = 'play';
    save();
    render();
    window.scrollTo(0, 0);
  }

  /* --------------------------------------------------------- 공유 */

  function shareText() {
    var text = YDC.buildShareText(R, { includeHoles: true });
    var done = function () { toast('정산 내용을 복사했어요. 카톡에 붙여넣기 하세요.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); }
    catch (e) { toast('복사에 실패했습니다. 화면의 내용을 길게 눌러 복사하세요.'); }
    document.body.removeChild(ta);
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    var words = String(text).split(' ');
    var line = '';
    for (var i = 0; i < words.length; i++) {
      var test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, x, y);
        y += lineHeight;
        line = words[i];
      } else line = test;
    }
    if (line) { ctx.fillText(line, x, y); y += lineHeight; }
    return y;
  }

  function buildShareCard() {
    var W = 1080;
    var fontKR = '"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif';

    var ranked = R.players.map(function (p, i) {
      return { name: p.name, points: p.points, final: R.roundEnd.finalNet[i] };
    }).sort(function (a, b) { return b.final - a.final; });

    var rows = R.roundEnd.settlements;
    var shownRows = rows.slice(0, 8);
    var rowH = ranked.length > 3 ? 108 : 124;

    // 내용에 맞춰 세로 길이를 정확히 계산한다(빈 공간이 크게 남지 않게).
    var HEAD = 330;
    var nShown = rows.length ? Math.min(8, rows.length) + (rows.length > 8 ? 1 : 0) : 1;
    var bodyEnd = HEAD + ranked.length * rowH + 20 + 66 + 56 + nShown * 48;
    var H = Math.round(bodyEnd + 150);

    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var g = cv.getContext('2d');

    var grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#14532d');
    grad.addColorStop(1, '#08170e');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);

    g.fillStyle = '#f7bb07';
    g.fillRect(0, 0, W, 14);

    g.textBaseline = 'alphabetic';

    g.fillStyle = '#f7bb07';
    g.font = '900 44px ' + fontKR;
    g.fillText('YDC GOLF BET', 70, 110);

    var title = (R.round.title || '').trim() || (modeLabel(R.mode) + ' 라운드');
    g.fillStyle = '#ffffff';
    g.font = '900 66px ' + fontKR;
    var ty = wrapText(g, title, 70, 196, W - 140, 78);

    g.fillStyle = 'rgba(255,255,255,.82)';
    g.font = '700 34px ' + fontKR;
    g.fillText(modeLabel(R.mode) + ' · ' + R.holeCount + '/' + R.totalHoles + '홀 · 기본 ' +
      won(R.baseBet) + '/타 · ' + todayLabel(R.round.createdAt), 70, ty + 16);

    var y = HEAD;
    ranked.forEach(function (p, i) {
      var top = y;
      var hh = rowH - 14;
      g.fillStyle = i === 0 ? 'rgba(247,187,7,.18)' : 'rgba(255,255,255,.07)';
      g.beginPath();
      var r = 22;
      g.moveTo(70, top + r);
      g.arcTo(70, top, 70 + r, top, r);
      g.arcTo(W - 70, top, W - 70, top + r, r);
      g.arcTo(W - 70, top + hh, W - 70 - r, top + hh, r);
      g.arcTo(70, top + hh, 70, top + hh - r, r);
      g.closePath();
      g.fill();

      g.fillStyle = '#ffffff';
      g.font = '900 46px ' + fontKR;
      g.fillText((i + 1) + '. ' + p.name, 100, top + hh / 2 + 16);

      g.fillStyle = 'rgba(255,255,255,.72)';
      g.font = '700 34px ' + fontKR;
      var pts = (p.points > 0 ? '+' + p.points : String(p.points)) + '타';
      g.textAlign = 'right';
      g.fillText(pts, W - 380, top + hh / 2 + 12);

      g.fillStyle = p.final > 0 ? '#7ff0a8' : p.final < 0 ? '#ff9a9a' : 'rgba(255,255,255,.85)';
      g.font = '900 46px ' + fontKR;
      g.fillText(signed(p.final), W - 100, top + hh / 2 + 16);
      g.textAlign = 'left';

      y += rowH;
    });

    y += 20;
    g.strokeStyle = 'rgba(247,187,7,.5)';
    g.lineWidth = 3;
    g.beginPath(); g.moveTo(70, y); g.lineTo(W - 70, y); g.stroke();
    y += 66;

    g.fillStyle = '#f7bb07';
    g.font = '900 38px ' + fontKR;
    g.fillText('정산', 70, y);
    y += 56;

    g.font = '700 34px ' + fontKR;
    if (!shownRows.length) {
      g.fillStyle = 'rgba(255,255,255,.8)';
      g.fillText('주고받을 돈이 없습니다.', 70, y);
      y += 48;
    } else {
      shownRows.forEach(function (t) {
        g.fillStyle = '#ffffff';
        g.fillText(nameOf(t.from) + ' → ' + nameOf(t.to), 70, y);
        g.fillStyle = '#ffe08a';
        g.textAlign = 'right';
        g.fillText(won(t.amount), W - 70, y);
        g.textAlign = 'left';
        y += 48;
      });
      if (rows.length > 8) {
        g.fillStyle = 'rgba(255,255,255,.6)';
        g.fillText('외 ' + (rows.length - 8) + '건', 70, y);
        y += 48;
      }
    }

    // 합계
    var receive = 0, pay = 0;
    R.roundEnd.finalNet.forEach(function (v) { if (v > 0) receive += v; else pay += -v; });
    y += 6;
    g.strokeStyle = 'rgba(255,255,255,.18)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(70, y); g.lineTo(W - 70, y); g.stroke();
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.font = '800 32px ' + fontKR;
    g.fillText('받을 돈 ' + won(receive) + '  ·  줄 돈 ' + won(pay), 70, y + 46);

    g.fillStyle = 'rgba(255,255,255,.42)';
    g.font = '700 26px ' + fontKR;
    g.fillText('YDC Golf Bet · 오프라인 자동 저장', 70, H - 40);

    return cv;
  }

  function shareCard() {
    var cv = buildShareCard();
    var dataUrl;
    try { dataUrl = cv.toDataURL('image/png'); }
    catch (e) { toast('이미지를 만들지 못했습니다'); return; }

    cv.toBlob(function (blob) {
      if (!blob) { showImageModal(dataUrl); return; }
      var file = null;
      try { file = new File([blob], 'ydc-golf-result.png', { type: 'image/png' }); } catch (e) {}
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        navigator.share({ files: [file], title: 'YDC 골프 내기 결과', text: '라운드 정산 결과' })
          .catch(function () { showImageModal(dataUrl); });
      } else {
        showImageModal(dataUrl);
      }
    }, 'image/png');
  }

  function showImageModal(dataUrl) {
    showModal({
      title: '결과 카드',
      body: '<div class="small muted" style="margin-bottom:8px">이미지를 길게 눌러 <b>사진에 저장</b> 하거나 아래 버튼으로 저장한 뒤 카톡으로 보내세요.</div>' +
        '<img src="' + dataUrl + '" alt="라운드 결과 카드" style="width:100%;border-radius:12px;border:1px solid var(--line)">',
      buttons: [
        { label: '이미지 저장', value: 'download', kind: 'primary' },
        { label: '닫기', value: 'close', kind: 'ghost' }
      ]
    }).then(function (v) {
      if (v !== 'download') return;
      var a = document.createElement('a');
      a.href = dataUrl;
      a.download = 'ydc-golf-' + todayLabel() + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      toast('이미지를 저장했습니다');
    });
  }

  /* ---------------------------------------------------------- 메뉴 */

  function playMenu() {
    showModal({
      title: '메뉴',
      body: '<button class="btn btn-ghost" data-modal="hist" style="margin-bottom:9px">홀 기록 보기</button>' +
        '<button class="btn btn-ghost" data-modal="rules" style="margin-bottom:9px">규칙 보기</button>' +
        '<button class="btn btn-danger" data-modal="end">라운드 종료 (지금까지 기록으로 정산)</button>',
      buttons: [{ label: '닫기', value: 'close', kind: 'ghost' }]
    }).then(function (v) {
      if (v === 'hist') showHistoryModal();
      else if (v === 'rules') showRulesModal();
      else if (v === 'end') endRoundEarly();
    });
  }

  function showHistoryModal() {
    var v = R;
    var body = v.holes.length ? v.holes.slice().reverse().map(function (h) {
      var line = h.uids.map(function (u, i) {
        var s = h.scores[i];
        return esc(nameOf(u)) + ' ' + (s > 0 ? '+' + s : s);
      }).join(' · ');
      return '<div class="history-row">' +
        '<div class="hole-badge">' + h.hole + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="small bold">×' + h.mult + (h.doubleBy ? ' 더블' : '') + '</div>' +
          '<div class="tiny muted">' + line + '</div>' +
        '</div>' +
        '<div class="tiny muted">' + (h.simplified.length ? h.simplified.length + '건' : '–') + '</div>' +
      '</div>';
    }).join('') : '<div class="empty">아직 기록된 홀이 없습니다.</div>';

    showModal({
      title: '홀 기록',
      body: '<div style="max-height:52vh;overflow:auto">' + body + '</div>',
      buttons: [{ label: '닫기', value: 'close', kind: 'ghost' }]
    });
  }

  function showRulesModal() {
    var mode = (S.round && S.round.mode) || 'ydc';
    var body = '<div class="small" style="line-height:1.65">' +
      '<b>기본 정산</b><br>모든 짝이 (타수 차) × 기본 배팅 × 배율 로 정산하고, 마지막에 최소 이체로 상계합니다.<br><br>' +
      '<b>언더파 보너스</b> (두 모드 공통)<br>버디 ×1 · 이글 ×5 · 알바트로스 ×10 — 나보다 못 친 모든 사람에게 각각 받습니다.<br><br>' +
      '<b>다음 홀 배율</b><br>' +
      (mode === 'ojang'
        ? '오장: 언더파 · +3 이상 · 최저 타수 동타 → ×2. 개인별 더블 2회(1홀 1회, 이미 2배면 사용 안 됨).'
        : 'YDC: 전원 파 ×10 · 전원 동타 ×5 · 스트레이트 ×5 · 3명 동타 ×3 · 2명 동타 ×2 · 언더파/+3 이상 ×2 중 <b>가장 큰 하나</b>만.') +
      '<br><br><b>니어 · 롱기</b><br>지정 홀 승자에게 (이월 + 1) × 기본 × 배율. 무승자·지우개면 이월/초기화를 고릅니다.<br><br>' +
      '<b>오너 순서</b><br>직전 홀 타수 순, 동타면 앞 홀로 거슬러 비교, 그래도 같으면 처음 순서.' +
      '</div>';
    showModal({ title: '규칙', body: body, buttons: [{ label: '닫기', value: 'close', kind: 'ghost' }] });
  }

  function endRoundEarly() {
    var v = R;
    if (!v.holes.length) { toast('기록된 홀이 없습니다'); return; }
    confirmModal('라운드 종료',
      '<div class="small">' + v.holeCount + '홀까지의 기록으로 정산합니다. 남은 홀은 기록되지 않습니다.</div>',
      '종료하고 정산').then(function (ok) {
      if (!ok) return;
      S.round.finishedAt = Date.now();
      Store.addToArchive(S.round);
      go('summary');
    });
  }

  /* --------------------------------------------------------- 이벤트 */

  function onAction(act, el) {
    var type = el.getAttribute('data-type');
    var uid = el.getAttribute('data-uid');

    switch (act) {
      /* 공통 */
      case 'ui:theme': {
        S.theme = S.theme === 'dark' ? 'light' : 'dark';
        Store.saveTheme(S.theme);
        applyTheme();
        render();
        return;
      }
      case 'nav:home': {
        if (S.reading) { S.reading = null; S.round = null; }
        S.screen = 'home';
        if (S.round && S.round.finishedAt) { Store.clearActive(); S.round = null; }
        save();
        render();
        window.scrollTo(0, 0);
        return;
      }
      case 'nav:setup': {
        S.setup = defaultSetup();
        S.reading = null;
        S.screen = 'setup';
        render();
        window.scrollTo(0, 0);
        return;
      }
      case 'ui:rules':
        showRulesModal();
        return;
      case 'nav:archive': {
        S.screen = 'archive';
        render();
        window.scrollTo(0, 0);
        return;
      }
      case 'round:discard': {
        confirmModal('라운드 버리기', '<div class="small">아직 기록된 홀이 없는 라운드입니다. 이 설정을 버릴까요?</div>', '버리기', true)
          .then(function (ok) {
            if (!ok) return;
            Store.clearActive();
            S.round = null;
            S.screen = 'home';
            render();
          });
        return;
      }
      case 'nav:resume': {
        var active = Store.loadActiveSync();
        if (!active) { toast('저장된 라운드가 없습니다'); return; }
        S.round = active;
        R = recompute();
        S.screen = active.finishedAt ? 'summary' : (active.screen === 'result' && R.lastHole ? 'result' : 'play');
        if (S.screen === 'play') draftOf(R);
        render();
        window.scrollTo(0, 0);
        return;
      }

      /* 설정 */
      case 'setup:mode':
        S.setup.mode = el.getAttribute('data-mode');
        if (YDC.isTeamOnlyMode(S.setup.mode)) S.setup.count = 4;
        render();
        return;
      case 'setup:count': {
        S.setup.count = Number(el.getAttribute('data-n'));
        render();
        return;
      }
      case 'setup:holes': {
        var n = Number(el.getAttribute('data-n'));
        S.setup.totalHoles = n;
        ['nearest', 'longest'].forEach(function (t) {
          S.setup.side[t].holes = S.setup.side[t].holes.map(function (h) {
            return (h && h <= n) ? h : null;
          });
        });
        render();
        return;
      }
      case 'setup:base-chip':
        S.setup.baseBet = Number(el.getAttribute('data-v'));
        render();
        return;
      case 'setup:team-pick': {
        var tidx = Number(el.getAttribute('data-idx'));
        var tval = el.getAttribute('data-team') === 'B' ? 'B' : 'A';
        if (!S.setup.teamPlay) S.setup.teamPlay = { enabled: true, teams: ['A', 'A', 'B', 'B'] };
        S.setup.teamPlay.teams[tidx] = tval;
        render();
        return;
      }
      case 'setup:start':
        startRound();
        return;

      /* 플레이 */
      case 'play:inc': {
        var dv = Number(el.getAttribute('data-d'));
        var pv = preView();
        var d = draftOf(pv);
        d.scores[uid] = YDC.clampScore(YDC.clampScore(d.scores[uid]) + dv);
        updateScoreUI(uid);
        save();
        haptic();
        return;
      }
      case 'play:grid': {
        var pv2 = preView();
        var d2 = draftOf(pv2);
        var cur = YDC.clampScore(d2.scores[uid]);
        var cells = '';
        for (var s = YDC.SCORE_MIN; s <= YDC.SCORE_MAX; s++) {
          var bonus = YDC.underParUnits(s);
          cells += '<button class="btn ' + (s === cur ? 'btn-primary' : 'btn-ghost') + '" data-modal="v' + s + '"' +
            ' style="min-height:56px;flex-direction:column;gap:0">' +
            '<span style="font-size:1.15rem">' + (s > 0 ? '+' + s : s) + '</span>' +
            '<span class="tiny" style="font-weight:700;opacity:.8">' + YDC.scoreName(s) + (bonus ? ' ×' + bonus : '') + '</span>' +
            '</button>';
        }
        showModal({
          title: esc(nameOf(uid)) + ' 타수',
          body: '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">' + cells + '</div>',
          buttons: [{ label: '닫기', value: 'close', kind: 'ghost' }]
        }).then(function (val) {
          if (!val || val.indexOf('v') !== 0) return;
          var d3 = draftOf(preView());
          d3.scores[uid] = YDC.clampScore(Number(val.slice(1)));
          updateScoreUI(uid);
          save();
        });
        return;
      }
      case 'play:side': {
        var pv3 = preView();
        var d4 = draftOf(pv3);
        var val = el.getAttribute('data-val');
        if (!d4.sides[type]) d4.sides[type] = {};
        // 한 명만 승자
        if (val === 'win') {
          d4.sides[type][uid] = d4.sides[type][uid] === 'win' ? 'none' : 'win';
        } else {
          d4.sides[type][uid] = d4.sides[type][uid] === 'erase' ? 'none' : 'erase';
        }
        save();
        render();
        return;
      }
      case 'play:double': {
        var pv4 = preView();
        var d5 = draftOf(pv4);
        d5.doubleBy = d5.doubleBy === uid ? null : uid;
        save();
        render();
        return;
      }
      case 'play:team': {
        var pv5 = preView();
        var d6 = draftOf(pv5);
        d6.teamOverride = el.getAttribute('data-v') || 'auto';
        save();
        render();
        return;
      }
      case 'play:team-adj': {
        var pv6 = preView();
        if (!pv6.teamMatch || !S.round.teamPlay) return;
        var tmAdj = pv6.teamMatch;
        var tAdjA = tmAdj.nameA || '제우스';
        var tAdjB = tmAdj.nameB || '아폴론';
        var nmA = tmAdj.teamA.map(nameOf).join('·');
        var nmB = tmAdj.teamB.map(nameOf).join('·');
        showModal({
          title: '팀 점수 조정',
          body: '<div class="small" style="line-height:1.6">' +
            '현재 점수: <b>' + esc(tAdjA) + '(' + esc(nmA) + ') ' + tmAdj.scoreA + '</b> : <b>' + tmAdj.scoreB + ' ' + esc(tAdjB) + '(' + esc(nmB) + ')</b><br>' +
            '<span class="tiny muted">조정할 항목을 누르면 즉시 반영됩니다.</span></div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px">' +
              '<button class="btn btn-ghost" data-modal="a+1">' + esc(tAdjA) + ' +1점</button>' +
              '<button class="btn btn-ghost" data-modal="b+1">' + esc(tAdjB) + ' +1점</button>' +
              '<button class="btn btn-ghost" data-modal="a-1">' + esc(tAdjA) + ' −1점</button>' +
              '<button class="btn btn-ghost" data-modal="b-1">' + esc(tAdjB) + ' −1점</button>' +
            '</div>',
          buttons: [{ label: '닫기', value: 'close', kind: 'primary' }]
        }).then(function (val) {
          if (!val || val === 'close') return;
          if (val === 'a+1') S.round.teamPlay.adjA = (S.round.teamPlay.adjA || 0) + 1;
          else if (val === 'a-1') S.round.teamPlay.adjA = (S.round.teamPlay.adjA || 0) - 1;
          else if (val === 'b+1') S.round.teamPlay.adjB = (S.round.teamPlay.adjB || 0) + 1;
          else if (val === 'b-1') S.round.teamPlay.adjB = (S.round.teamPlay.adjB || 0) - 1;
          R = recompute();
          save();
          render();
        });
        return;
      }
      case 'play:finish':
        finishHole();
        return;
      case 'play:menu':
        playMenu();
        return;
      case 'play:undo':
        undoLast();
        return;
      case 'play:edit':
        editLast();
        return;

      /* 결과 */
      case 'result:next': {
        var isFinal = R.lastHole && R.lastHole.hole >= S.round.totalHoles;
        if (isFinal || S.round.finishedAt) {
          if (!S.round.finishedAt) S.round.finishedAt = Date.now();
          Store.addToArchive(S.round);
          go('summary');
        } else {
          S.screen = 'play';
          S.round.draft = null;
          R = recompute();
          draftOf(R);
          go('play');
        }
        return;
      }

      /* 요약 */
      case 'summary:edit': {
        if (!S.round || !S.round.history.length) { toast('수정할 홀이 없습니다'); return; }
        S.round.finishedAt = null;
        Store.removeFromArchive(S.round.id);
        editLast();
        return;
      }
      case 'summary:new': {
        S.reading = null;
        S.setup = defaultSetup();
        Store.clearActive();
        S.round = null;
        S.screen = 'setup';
        render();
        window.scrollTo(0, 0);
        return;
      }

      /* 공유 */
      case 'share:text':
        shareText();
        return;
      case 'share:card':
        shareCard();
        return;

      /* 보관함 */
      case 'archive:open': {
        var id = el.getAttribute('data-id');
        var found = Store.loadArchive().filter(function (r) { return r.id === id; })[0];
        if (!found) { toast('라운드를 찾을 수 없습니다'); return; }
        S.reading = found;
        S.round = found;
        S.screen = 'summary';
        render();
        window.scrollTo(0, 0);
        return;
      }
      case 'archive:del': {
        var delId = el.getAttribute('data-id');
        var victim = Store.loadArchive().filter(function (r) { return r.id === delId; })[0];
        if (!victim) { toast('라운드를 찾을 수 없습니다'); return; }
        askDeleteRound(victim);
        return;
      }
    }
  }

  function onInput(e) {
    var el = e.target;
    var act = el.getAttribute && el.getAttribute('data-act');
    if (!act) return;
    var cfg = S.setup;
    if (!cfg) return;

    if (act === 'setup:title') { cfg.title = el.value; return; }
    if (act === 'setup:base') {
      var v = Math.max(0, Math.round(Number(el.value) || 0));
      cfg.baseBet = v;
      return;
    }
    if (act === 'setup:name') {
      var idx = Number(el.getAttribute('data-idx'));
      if (!cfg.names) cfg.names = [];
      cfg.names[idx] = el.value;
      return;
    }
    if (act === 'setup:shuffle') { cfg.shuffle = el.checked; return; }
    if (act === 'setup:team-toggle') {
      if (!cfg.teamPlay) cfg.teamPlay = { enabled: false, nameA: '제우스', nameB: '아폴론', teams: ['A', 'A', 'B', 'B'] };
      cfg.teamPlay.enabled = el.checked;
      render();
      return;
    }
    if (act === 'setup:team-name') {
      if (!cfg.teamPlay) cfg.teamPlay = { enabled: true, nameA: '제우스', nameB: '아폴론', teams: ['A', 'A', 'B', 'B'] };
      var which = el.getAttribute('data-team');
      if (which === 'A') cfg.teamPlay.nameA = el.value;
      else cfg.teamPlay.nameB = el.value;
      render();
      return;
    }
    if (act === 'setup:side') {
      var t = el.getAttribute('data-type');
      cfg.side[t].enabled = el.checked;
      if (!el.checked) cfg.side[t].holes = [null, null, null, null];
      render();
      return;
    }
    if (act === 'setup:hole') {
      var tp = el.getAttribute('data-type');
      var i = Number(el.getAttribute('data-idx'));
      var h = el.value ? Number(el.value) : null;
      cfg.side[tp].holes[i] = h;
      // 순서 유지 + 중복 제거
      var arr = cfg.side[tp].holes.filter(function (x) { return x != null; });
      arr = arr.filter(function (x, k) { return arr.indexOf(x) === k; }).sort(function (a, b) { return a - b; });
      cfg.side[tp].holes = [arr[0] || null, arr[1] || null, arr[2] || null, arr[3] || null];
      render();
      return;
    }
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', S.theme === 'dark' ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', S.theme === 'dark' ? '#0b1218' : '#14532d');
  }

  /* --------------------------------------------------------- 부팅 */

  function boot() {
    S.theme = Store.loadTheme();

    document.addEventListener('click', function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
      var act = el.getAttribute('data-act');
      if (!act) return;
      e.preventDefault();
      try { onAction(act, el); }
      catch (err) { console.error(err); toast('처리 중 문제가 생겼습니다'); }
    });

    document.addEventListener('input', onInput);
    document.addEventListener('change', onInput);

    // 첫 화면: 진행 중인 라운드가 있으면 이어서
    var active = Store.loadActiveSync();
    if (active) {
      S.round = active;
      R = recompute();
      if (active.finishedAt) S.screen = 'summary';
      else if (active.screen === 'result' && R.lastHole) S.screen = 'result';
      else if (active.screen === 'home') S.screen = 'home';
      else S.screen = 'play';
      if (S.screen === 'play') draftOf(R);
    } else {
      S.screen = 'home';
    }

    applyTheme();
    render();

    // IndexedDB 백업에서 보관함 복구
    if (!Store.loadArchive().length) {
      Store.loadArchiveAsync().then(function (list) {
        if (list && list.length && !Store.loadArchive().length) {
          try { Store.writeJSON(Store.KEY.archive, list); } catch (e) {}
          if (S.screen === 'home') render();
        }
      });
    }

    // IndexedDB 백업에서 복구 (localStorage 가 비었을 때만)
    if (!active) {
      Store.loadActiveAsync().then(function (r) {
        if (!r || S.round) return;
        S.round = r;
        R = recompute();
        S.screen = r.finishedAt ? 'summary' : (r.screen === 'result' && R.lastHole ? 'result' : 'play');
        if (S.screen === 'play') draftOf(R);
        render();
        toast('백업에서 라운드를 복구했습니다');
      });
    }

    // 홈 화면 추가 안내(설치형이 아닐 때만, 하루 한 번)
    try {
      var standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
      var lastHint = Number(Store.get('ydcgb:v1:installHint') || 0);
      if (!standalone && Date.now() - lastHint > 86400000 && S.screen === 'home') {
        Store.set('ydcgb:v1:installHint', String(Date.now()));
      }
    } catch (e) {}

    // 화면이 다시 보일 때 저장 (사파리가 백그라운드로 보낼 때 유실 방지)
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') save();
    });
    window.addEventListener('pagehide', save);
  }

  return {
    boot: boot,
    _state: S,
    _view: function () { return R; }
  };
})();

document.addEventListener('DOMContentLoaded', function () {
  try { App.boot(); }
  catch (e) {
    console.error(e);
    document.getElementById('root').innerHTML =
      '<div class="card" style="margin-top:20px"><b>앱을 시작하지 못했습니다.</b><br>' +
      String(e && e.message ? e.message : e) + '</div>';
  }
});
