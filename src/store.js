/* ============================================================================
 * YDC Golf Bet — 저장소
 *
 * localStorage 를 1차 저장(동기, 즉시)으로 쓰고 IndexedDB 를 백업으로 둔다.
 * 네트워크는 전혀 쓰지 않는다. 저장에 실패해도 앱은 계속 동작한다.
 * ==========================================================================*/
var Store = (function () {
  'use strict';

  var KEY = {
    prefs: 'ydcgb:v1:prefs',
    active: 'ydcgb:v1:active',
    archive: 'ydcgb:v1:archive',
    theme: 'ydcgb:v1:theme'
  };

  var memory = {};        // localStorage 를 못 쓸 때(사생활 보호 모드 등) 대체 저장소
  var lsOK = (function () {
    try {
      var k = '__ydcgb_test__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  })();

  function get(k) {
    try {
      if (lsOK) return window.localStorage.getItem(k);
    } catch (e) {}
    return memory[k] === undefined ? null : memory[k];
  }

  function set(k, v) {
    memory[k] = v;
    try {
      if (lsOK) { window.localStorage.setItem(k, v); return true; }
    } catch (e) {}
    return false;
  }

  function del(k) {
    delete memory[k];
    try { if (lsOK) window.localStorage.removeItem(k); } catch (e) {}
  }

  function readJSON(k, fallback) {
    var raw = get(k);
    if (!raw) return fallback;
    try {
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function writeJSON(k, v) {
    try { return set(k, JSON.stringify(v)); } catch (e) { return false; }
  }

  /* ---------------------------------------------------- IndexedDB 백업 */

  var dbPromise = null;

  function idb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no-idb')); return; }
      var req;
      try { req = window.indexedDB.open('ydc-golf-bet', 1); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('idb-open-failed')); };
      req.onblocked = function () { reject(new Error('idb-blocked')); };
    });
    return dbPromise;
  }

  function idbPut(key, value) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('kv', 'readonly');
        var rq = tx.objectStore('kv').get(key);
        rq.onsuccess = function () { resolve(rq.result || null); };
        rq.onerror = function () { reject(rq.error); };
      });
    });
  }

  /* -------------------------------------------------------------- 공개 */

  function loadPrefs() {
    var p = readJSON(KEY.prefs, null);
    if (!p || typeof p !== 'object') return null;
    return p;
  }

  function savePrefs(prefs) {
    return writeJSON(KEY.prefs, prefs || {});
  }

  function loadTheme() {
    var t = get(KEY.theme);
    return (t === 'light' || t === 'dark' || t === 'auto') ? t : 'light';
  }

  function saveTheme(t) { set(KEY.theme, t); }

  // 진행 중인 라운드: localStorage → (없으면) IndexedDB
  function saveActive(round) {
    var ok = writeJSON(KEY.active, round);
    // IndexedDB 백업은 기다리지 않는다(실패해도 무시).
    try { idbPut('active', round).catch(function () {}); } catch (e) {}
    return ok;
  }

  function loadActiveSync() {
    var r = readJSON(KEY.active, null);
    if (r && r.initialPlayers && r.history) return r;
    return null;
  }

  function loadActiveAsync() {
    var sync = loadActiveSync();
    if (sync) return Promise.resolve(sync);
    return idbGet('active').then(function (r) {
      if (r && r.initialPlayers && r.history) {
        writeJSON(KEY.active, r);   // 복구
        return r;
      }
      return null;
    }).catch(function () { return null; });
  }

  function clearActive() {
    del(KEY.active);
    try { idbPut('active', null).catch(function () {}); } catch (e) {}
  }

  function loadArchive() {
    var list = readJSON(KEY.archive, []);
    return Array.isArray(list) ? list : [];
  }

  function loadArchiveAsync() {
    var sync = loadArchive();
    if (sync.length) return Promise.resolve(sync);
    return idbGet('archive').then(function (list) {
      return Array.isArray(list) ? list : [];
    }).catch(function () { return []; });
  }

  function addToArchive(round) {
    if (!round || !round.id) return loadArchive();
    var list = loadArchive().filter(function (r) { return r.id !== round.id; });
    list.unshift(round);
    if (list.length > 30) list = list.slice(0, 30);
    writeJSON(KEY.archive, list);
    try { idbPut('archive', list).catch(function () {}); } catch (e) {}
    return list;
  }

  // 보관함에서 한 라운드만 지운다. localStorage 와 IndexedDB 를 같이 맞춘다.
  // localStorage 목록에 없고 IndexedDB 에만 남아 있는 경우까지 확인해서 지운다.
  function removeFromArchive(id) {
    var before = loadArchive();
    var list = before.filter(function (r) { return r.id !== id; });
    if (list.length !== before.length) {
      writeJSON(KEY.archive, list);
      try { idbPut('archive', list).catch(function () {}); } catch (e) {}
      return Promise.resolve(list);
    }
    return idbGet('archive').then(function (stored) {
      var src = (Array.isArray(stored) && stored.length) ? stored : before;
      var fixed = src.filter(function (r) { return r && r.id !== id; });
      writeJSON(KEY.archive, fixed);
      try { idbPut('archive', fixed).catch(function () {}); } catch (e) {}
      return fixed;
    }).catch(function () { return list; });
  }

  function newId() {
    try {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) {}
    return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function newUid() {
    return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  return {
    KEY: KEY,
    lsOK: lsOK,
    get: get, set: set, del: del,
    readJSON: readJSON, writeJSON: writeJSON,
    loadPrefs: loadPrefs, savePrefs: savePrefs,
    loadTheme: loadTheme, saveTheme: saveTheme,
    saveActive: saveActive,
    loadActiveSync: loadActiveSync,
    loadActiveAsync: loadActiveAsync,
    clearActive: clearActive,
    loadArchive: loadArchive,
    loadArchiveAsync: loadArchiveAsync,
    addToArchive: addToArchive,
    removeFromArchive: removeFromArchive,
    newId: newId,
    newUid: newUid
  };
})();
