(function () {
  "use strict";

  // ───────────────────────── FSRS-5 core ─────────────────────────
  // Standard FSRS-5 default parameters. Time is compressed for cramming:
  // one FSRS "day" = one real minute, and a lapse (Again) is requeued
  // a couple of cards later instead of waiting at all.
  var W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
           1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
  var DECAY = -0.5;
  var FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // = 19/81, so R = 0.9 when t = S
  var DESIRED_RETENTION = 0.9;
  var MS_PER_FSRS_DAY = 60 * 1000;            // compression: 1 day -> 1 minute
  // Compression only applies while you're studying. Time away (a gap of more than
  // IDLE_MS between actions) runs at the real rate: a night off = 1 FSRS day, not 1440.
  var IDLE_MS = 30 * 60 * 1000;
  var AWAY_SLOWDOWN = 24 * 60 * 60 * 1000 / MS_PER_FSRS_DAY;
  var AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

  function retrievability(elapsedDays, S) {
    return Math.pow(1 + FACTOR * elapsedDays / S, DECAY);
  }
  function initStability(g) { return Math.max(W[g - 1], 0.1); }
  function initDifficulty(g) { return clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10); }
  function nextDifficulty(D, g) {
    var delta = -W[6] * (g - 3);
    var dPrime = D + delta * (10 - D) / 9;               // linear damping
    return clamp(W[7] * initDifficulty(EASY) + (1 - W[7]) * dPrime, 1, 10); // mean reversion
  }
  function stabilityAfterSuccess(D, S, R, g) {
    var hardPenalty = g === HARD ? W[15] : 1;
    var easyBonus = g === EASY ? W[16] : 1;
    return S * (1 + Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) *
      (Math.exp(W[10] * (1 - R)) - 1) * hardPenalty * easyBonus);
  }
  function stabilityAfterLapse(D, S, R) {
    var s = W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp(W[14] * (1 - R));
    return Math.min(s, S / Math.exp(W[17] * W[18]));
  }
  // Reviews less than one FSRS day apart (the common case here, since a day is a minute).
  function stabilityShortTerm(S, g) {
    return S * Math.exp(W[17] * (g - 3 + W[18]));
  }
  function intervalDays(S) {
    return (S / FACTOR) * (Math.pow(DESIRED_RETENTION, 1 / DECAY) - 1); // = S at 90% retention
  }

  // Applies one review to a card's memory state. Returns the new state.
  function fsrsReview(c, g, now) {
    if (!c.reps) {
      c.S = initStability(g);
      c.D = initDifficulty(g);
    } else {
      var elapsed = Math.max(0, (now - c.last) / MS_PER_FSRS_DAY);
      var R = retrievability(elapsed, c.S);
      // stability is computed from the difficulty *before* this review, as in reference FSRS
      if (elapsed < 1) c.S = stabilityShortTerm(c.S, g);
      else c.S = g === AGAIN ? stabilityAfterLapse(c.D, c.S, R) : stabilityAfterSuccess(c.D, c.S, R, g);
      c.S = Math.max(c.S, 0.1);
      c.D = nextDifficulty(c.D, g);
    }
    c.reps += 1;
    c.last = now;
    c.lastRating = g;
    if (g === AGAIN) c.lapses += 1;
    return c;
  }

  // ───────────────────────── State ─────────────────────────
  var STORE_KEY = "cloud-econ-fsrs-v1";
  var AGAIN_GAP = [2, 3];   // a missed card comes back after 2-3 other cards
  var HARD_GAP = [5, 6];
  var MASTERED_S = 5;       // stability (compressed days = minutes) to count as "mastered"
  var ID_SCHEME = 2;        // 1 = position-based ids ("q12"), 2 = prompt-hash ids
  var DEFAULT_SECS = { mc: 18, tf: 10, fib: 25 }; // seconds per card (read, answer, explanation) before your pace is learned
  var PACE_MULT = { fast: 0.6, normal: 1, slow: 1.5 };

  var byId = {}, legacyToId = {};
  QUESTIONS.forEach(function (q) { byId[q.id] = q; legacyToId[q.legacyId] = q.id; });

  function isPlainObject(x) { return !!x && typeof x === "object" && !Array.isArray(x); }

  var state = load();
  function blankCard() {
    // last/dueTime are on the study clock; seenAt is the real time of the last review (for merging)
    return { reps: 0, lapses: 0, S: 0, D: 0, last: 0, dueTime: 0, dueStep: null, lastRating: 0, right: 0, wrong: 0, seenAt: 0 };
  }
  // Study clock: follows real time while you're active, and only crawls forward while
  // you're away, so cards decay over days the way they would without the compression.
  function studyNow() {
    var real = Date.now(), k = state.clock, gap = real - k.real;
    if (gap > 0) {
      k.virt += awayToStudy(gap);
      k.real = real;
    }
    return k.virt;
  }
  // How much study-clock time a real gap is worth.
  function awayToStudy(gapMs) {
    return gapMs <= IDLE_MS ? gapMs : IDLE_MS + (gapMs - IDLE_MS) / AWAY_SLOWDOWN;
  }
  // Moves a card's times by delta (study-clock ms), e.g. onto another copy's clock.
  function shiftCard(c, delta) {
    var out = {};
    for (var k in c) out[k] = c[k];
    if (out.reps) out.last += delta;
    if (out.dueTime) out.dueTime += delta;
    return out;
  }
  function load() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { s = null; }
    return normalize(s);
  }
  // Validates and repairs a saved state (from localStorage or a backup file).
  function normalize(s) {
    if (!isPlainObject(s) || !isPlainObject(s.cards)) s = { cards: {}, step: 0, filter: "all", missedOnly: false, idScheme: ID_SCHEME };
    if (typeof s.step !== "number" || !isFinite(s.step)) s.step = 0;
    // savedAt: last real change; resetAt: last "Reset progress" (used when merging with a backup)
    if (typeof s.savedAt !== "number" || !isFinite(s.savedAt)) s.savedAt = 0;
    if (typeof s.resetAt !== "number" || !isFinite(s.resetAt)) s.resetAt = 0;
    if (typeof s.filter !== "string") s.filter = "all";
    s.missedOnly = s.missedOnly === true;
    if (!isPlainObject(s.removed)) s.removed = {};
    if (!isPlainObject(s.pace)) s.pace = {};
    Object.keys(s.pace).forEach(function (k) {
      var p = s.pace[k];
      if (!(k in DEFAULT_SECS) || !isPlainObject(p) || !(p.n > 0) || !(p.avg > 0) || !isFinite(p.avg)) delete s.pace[k];
    });
    if (s.idScheme !== ID_SCHEME) {
      // progress saved with position-based ids: re-key it to the stable ids
      ["cards", "removed"].forEach(function (k) {
        var out = {};
        Object.keys(s[k]).forEach(function (old) { if (legacyToId[old]) out[legacyToId[old]] = s[k][old]; });
        s[k] = out;
      });
      s.idScheme = ID_SCHEME;
    }
    Object.keys(s.removed).forEach(function (id) { if (!byId[id] || !s.removed[id]) delete s.removed[id]; });
    QUESTIONS.forEach(function (q) {
      // fill in any missing/damaged fields so selection never sees undefined or NaN
      var c = s.cards[q.id], d = blankCard();
      if (!c || typeof c !== "object") { s.cards[q.id] = d; return; }
      // saved before the study clock existed: "last" was real time
      if (typeof c.seenAt !== "number" && typeof c.last === "number") c.seenAt = c.last;
      Object.keys(d).forEach(function (k) {
        if (k === "dueStep") { if (typeof c[k] !== "number" || !isFinite(c[k])) c[k] = null; }
        else if (typeof c[k] !== "number" || !isFinite(c[k])) c[k] = d[k];
      });
      if (c.reps && !(c.S > 0)) c.S = 0.1;
    });
    if (!isPlainObject(s.clock) || !isFinite(s.clock.virt) || !isFinite(s.clock.real)) {
      // start the clock at the last review, so older saves get the away-time slowdown too
      var lastReal = 0;
      QUESTIONS.forEach(function (q) { lastReal = Math.max(lastReal, s.cards[q.id].last); });
      lastReal = lastReal || Date.now();
      s.clock = { virt: lastReal, real: lastReal };
    }
    if (s.clockFix !== 1) {
      // one-time: put cards reviewed before the clock existed onto it, using the real
      // time they were seen, so older sessions get the away-time slowdown too
      QUESTIONS.forEach(function (q) {
        var c = s.cards[q.id];
        if (!c.reps) return;
        var last = s.clock.virt - awayToStudy(Math.max(0, s.clock.real - c.seenAt));
        s.cards[q.id] = shiftCard(c, last - c.last);
      });
      s.clockFix = 1;
    }
    return s;
  }
  // persist() just writes the browser copy; save() records a real change and also
  // queues a write to the backup file (if one is linked).
  function persist() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable */ }
  }
  function save() {
    state.savedAt = Date.now();
    persist();
    scheduleBackup();
  }
  // Mastered = reviewed successfully more than once, stable, and not yet due again
  // (still above the target retention), so it wears off as time passes.
  function isMastered(c, now) {
    return c.reps >= 2 && c.lastRating >= GOOD && c.S >= MASTERED_S &&
      retrievability(Math.max(0, (now - c.last) / MS_PER_FSRS_DAY), c.S) >= DESIRED_RETENTION;
  }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // Applies a rating and schedules the card.
  function rate(id, g) {
    var c = state.cards[id];
    var now = studyNow();
    if (id === currentId && shownAt) recordPace(byId[id].type, (Date.now() - shownAt) / 1000);
    shownAt = 0;
    c.seenAt = Date.now();
    fsrsReview(c, g, now);
    scheduleAfter(c, g, now, state.step, Math.random);
    state.step += 1;
    save();
  }
  // Sets when a just-reviewed card comes back. rnd is Math.random, or a seeded one for simulations.
  function scheduleAfter(c, g, now, step, rnd) {
    function gap(r) { return r[0] + Math.floor(rnd() * (r[1] - r[0] + 1)); }
    if (g === AGAIN) {
      c.wrong += 1;
      c.dueStep = step + gap(AGAIN_GAP);
      c.dueTime = 0;
    } else {
      c.right += 1;
      if (g === HARD) {
        c.dueStep = step + gap(HARD_GAP);
        c.dueTime = 0;
      } else {
        c.dueStep = null;
        c.dueTime = now + intervalDays(c.S) * MS_PER_FSRS_DAY;
      }
    }
  }

  // ───────────────────────── Card selection ─────────────────────────
  // Filter values: "all", "week|<week>", or "topic|<week>|<topic>" (a topic name can
  // appear in more than one week).
  function inFilter(q) {
    if (state.filter === "all") return true;
    var parts = state.filter.split("|");
    if (parts[0] === "week") return q.week === parts[1];
    return parts[0] === "topic" && q.week === parts[1] && q.topic === parts[2];
  }
  function pool() {
    return QUESTIONS.filter(function (q) {
      if (state.removed[q.id]) return false;
      if (!inFilter(q)) return false;
      if (state.missedOnly && !state.cards[q.id].lapses) return false;
      return true;
    });
  }

  var newOrder = shuffle(QUESTIONS.map(function (q) { return q.id; }));
  var weekRank = {}; // weeks in the order they appear in the question bank
  QUESTIONS.forEach(function (q) { if (!(q.week in weekRank)) weekRank[q.week] = Object.keys(weekRank).length; });
  newOrder.sort(function (a, b) { return weekRank[byId[a].week] - weekRank[byId[b].week]; });
  var newRank = {};
  newOrder.forEach(function (id, i) { newRank[id] = i; });

  var currentId = null;
  var shownAt = 0; // when the current card was shown, for learning your pace

  // ───────────────────────── Pace / time estimate ─────────────────────────
  // Learns seconds per card for each question type (whole cycle: read, answer, explanation).
  function recordPace(type, secs) {
    if (!(type in DEFAULT_SECS) || secs < 1) return;
    secs = Math.min(secs, 90); // walked away: don't let it skew the average
    var p = state.pace[type] = state.pace[type] || { n: 0, avg: 0 };
    p.n += 1;
    p.avg += (secs - p.avg) / Math.min(p.n, 30); // weighted toward recent cards
  }
  var PACE_MODE_KEY = STORE_KEY + "-pace-mode";
  var paceMode = "auto";
  try { paceMode = localStorage.getItem(PACE_MODE_KEY) || "auto"; } catch (e) { /* storage unavailable */ }
  if (paceMode !== "auto" && !(paceMode in PACE_MULT)) paceMode = "auto";
  function secsPerCard(type) {
    if (paceMode !== "auto") return DEFAULT_SECS[type] * PACE_MULT[paceMode];
    var p = state.pace[type], w = p ? Math.min(p.n, 10) / 10 : 0; // trust your pace more as samples build up
    return w ? w * p.avg + (1 - w) * DEFAULT_SECS[type] : DEFAULT_SECS[type];
  }
  function missRate() {
    var right = 0, wrong = 0;
    QUESTIONS.forEach(function (q) { var c = state.cards[q.id]; right += c.right; wrong += c.wrong; });
    return right + wrong < 10 ? 0.25 : Math.min(0.6, wrong / (right + wrong));
  }
  function estimate() {
    var unseen = { mc: 0, tf: 0, fib: 0 }, nUnseen = 0, waiting = 0, base = 0, waitSecs = 0;
    pool().forEach(function (q) {
      var c = state.cards[q.id];
      if (!c.reps) { unseen[q.type]++; nUnseen++; base += secsPerCard(q.type); }
      else if (c.dueStep !== null) { waiting++; waitSecs += secsPerCard(q.type); }
    });
    var miss = missRate();
    return { unseen: unseen, nUnseen: nUnseen, waiting: waiting, miss: miss,
      repeatSecs: base * miss, total: base * (1 + miss) + waitSecs };
  }
  function formatDuration(secs) {
    var m = Math.round(secs / 60);
    if (m < 1) return "<1 min";
    if (m < 60) return "~" + m + " min";
    var mm = m % 60;
    return "~" + Math.floor(m / 60) + "h " + (mm < 10 ? "0" : "") + mm + "m";
  }

  // Time until every card in the pool counts as mastered at once. Mastery wears off as
  // time passes, so there's no formula: play the real scheduler forward on copies of the
  // cards: a new card is missed at your usual rate, a seen one with the chance FSRS says
  // you've forgotten it (1 - R), and anything not missed is answered Good.
  var MASTERY_CAP_SECS = 48 * 3600, MASTERY_CAP_REVIEWS = 100000;
  function seededRandom(seed) { // mulberry32
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function simulateMasteryOnce(qs, miss, seed) {
    var rnd = seededRandom(seed), cards = {}, now = studyNow(), step = state.step, lastId = null, secs = 0, reviews = 0;
    qs.forEach(function (q) { var c = state.cards[q.id], copy = {}; for (var k in c) copy[k] = c[k]; cards[q.id] = copy; });
    function allMastered() {
      for (var i = 0; i < qs.length; i++) if (!isMastered(cards[qs[i].id], now)) return false;
      return true;
    }
    while (!allMastered()) {
      if (secs > MASTERY_CAP_SECS || reviews >= MASTERY_CAP_REVIEWS) return null;
      var id = pickFrom(qs, cards, step, now, lastId), c = cards[id];
      var pMiss = c.reps ? 1 - retrievability(Math.max(0, (now - c.last) / MS_PER_FSRS_DAY), c.S) : miss;
      var g = rnd() < pMiss ? AGAIN : GOOD;
      fsrsReview(c, g, now);
      scheduleAfter(c, g, now, step, rnd);
      step += 1;
      lastId = id;
      var t = secsPerCard(byId[id].type);
      secs += t;
      now += t * 1000;
      reviews += 1;
    }
    return { secs: secs, reviews: reviews };
  }
  var masteryCache = { key: null, value: null };
  function simulateMastery() {
    var key = [state.step, Math.floor(studyNow() / 60000), state.filter, state.missedOnly, paceMode, Object.keys(state.removed).length].join("|");
    if (masteryCache.key === key) return masteryCache.value;
    var qs = pool(), miss = missRate(), runs = [], value;
    for (var seed = 1; seed <= 3; seed++) runs.push(simulateMasteryOnce(qs, miss, seed));
    if (runs.some(function (r) { return !r; })) value = { over: true };
    else value = {
      secs: runs.reduce(function (a, r) { return a + r.secs; }, 0) / runs.length,
      reviews: Math.round(runs.reduce(function (a, r) { return a + r.reviews; }, 0) / runs.length)
    };
    masteryCache = { key: key, value: value };
    return value;
  }

  function pickNext() {
    return pickFrom(pool(), state.cards, state.step, studyNow(), currentId);
  }
  // The scheduler itself, on any set of cards (the live ones, or a simulation's copies).
  function pickFrom(qs, cards, step, now, lastId) {
    if (!qs.length) return null;
    var others = qs.filter(function (q) { return q.id !== lastId; });
    var cands = others.length ? others : qs;

    // 1) step-requeued cards (Again / Hard) that are due
    var stepDue = cands.filter(function (q) { var c = cards[q.id]; return c.dueStep !== null && c.dueStep <= step; });
    if (stepDue.length) {
      stepDue.sort(function (a, b) { return cards[a.id].dueStep - cards[b.id].dueStep; });
      return stepDue[0].id;
    }
    // 2) time-scheduled cards whose interval has elapsed
    var timeDue = cands.filter(function (q) { var c = cards[q.id]; return c.reps && c.dueStep === null && c.dueTime <= now; });
    if (timeDue.length) {
      timeDue.sort(function (a, b) { return cards[a.id].dueTime - cards[b.id].dueTime; });
      return timeDue[0].id;
    }
    // 3) unseen cards
    var fresh = cands.filter(function (q) { return !cards[q.id].reps; });
    if (fresh.length) {
      fresh.sort(function (a, b) { return newRank[a.id] - newRank[b.id]; });
      return fresh[0].id;
    }
    // 4) nothing due: step-queued cards that aren't due yet come first, so a miss is never skipped
    var waiting = cands.filter(function (q) { return cards[q.id].dueStep !== null; });
    if (waiting.length) {
      waiting.sort(function (a, b) { return cards[a.id].dueStep - cards[b.id].dueStep; });
      return waiting[0].id;
    }
    // 5) otherwise review whichever card you're most likely to have forgotten
    var best = null, bestR = Infinity;
    cands.forEach(function (q) {
      var c = cards[q.id];
      var R = retrievability(Math.max(0, (now - c.last) / MS_PER_FSRS_DAY), c.S);
      if (R < bestR) { bestR = R; best = q.id; }
    });
    return best;
  }

  // ───────────────────────── Answer checking ─────────────────────────
  function norm(s) {
    return String(s).toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "") // é -> e
      .replace(/[‐-―]/g, "-")
      .replace(/[$,]/g, "")
      .replace(/[^a-z0-9.\- ]+/g, " ")
      .replace(/-/g, " ")
      .replace(/\.(?!\d)/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(the|a|an) /, "");
  }
  function levenshtein(a, b) {
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  // Returns "right", "close" (spelling slip, still counted wrong), or "wrong".
  function checkTyped(q, input) {
    var given = norm(input);
    if (!given) return "wrong";
    var targets = [q.answer].concat(q.accept || []).map(norm);
    for (var i = 0; i < targets.length; i++) {
      if (given === targets[i] || given.replace(/ /g, "") === targets[i].replace(/ /g, "")) return "right";
    }
    for (i = 0; i < targets.length; i++) {
      var tol = targets[i].length >= 8 ? 2 : 1;
      if (!/^[\d.]+$/.test(targets[i]) && levenshtein(given, targets[i]) <= tol) return "close";
    }
    return "wrong";
  }

  // ───────────────────────── Rendering ─────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var els = {
    counters: $("counters"), filter: $("filter"), missedOnly: $("missedOnly"),
    statsBtn: $("statsBtn"), resetBtn: $("resetBtn"), bar: $("progressBar"),
    card: $("card"), tagWeek: $("tagWeek"), tagTopic: $("tagTopic"), tagType: $("tagType"), tagAgain: $("tagAgain"),
    prompt: $("prompt"), choices: $("choices"), fibForm: $("fibForm"), fibInput: $("fibInput"),
    feedback: $("feedback"), verdict: $("verdict"), correct: $("correctAnswer"), explain: $("explain"), actions: $("actions"),
    stats: $("stats"), statsBody: $("statsBody"), removeBtn: $("removeBtn"), restoreBtn: $("restoreBtn"),
    announce: $("announce"),
    estimateBtn: $("estimateBtn"), estimatePanel: $("estimatePanel"), estimateHide: $("estimateHide"),
    paceMode: $("paceMode"), estimateBody: $("estimateBody"), estimateTotal: $("estimateTotal"), masteryTotal: $("masteryTotal"),
    backupBtn: $("backupBtn"), backupPanel: $("backupPanel"), backupStatus: $("backupStatus"), backupHide: $("backupHide"),
    backupCreate: $("backupCreate"), backupOpen: $("backupOpen"), backupReconnect: $("backupReconnect"),
    backupDisconnect: $("backupDisconnect"), backupDownload: $("backupDownload"),
    backupImport: $("backupImport"), backupImportFile: $("backupImportFile")
  };
  var TYPE_LABEL = { mc: "Multiple choice", tf: "True / False", fib: "Fill in the blank" };

  // phase: "ask" (waiting for an answer) | "rateRight" (pick Hard/Good/Easy) | "wrong" (Continue -> Again)
  //        | "saved" (answer recorded on the way out, see settlePending) | "empty"
  var phase = "ask";
  var choiceButtons = [];

  function buildFilter() {
    var weeks = [], topics = {};
    QUESTIONS.forEach(function (q) {
      if (weeks.indexOf(q.week) < 0) weeks.push(q.week);
      (topics[q.week] = topics[q.week] || []);
      if (topics[q.week].indexOf(q.topic) < 0) topics[q.week].push(q.topic);
    });
    var values = [];
    function option(parent, value, label) {
      var el = document.createElement("option");
      el.value = value; el.textContent = label;
      parent.appendChild(el);
      values.push(value);
    }
    els.filter.innerHTML = "";
    option(els.filter, "all", "All topics");
    weeks.forEach(function (w) {
      var group = document.createElement("optgroup");
      group.label = w;
      option(group, "week|" + w, w + ": everything");
      topics[w].forEach(function (t) { option(group, "topic|" + w + "|" + t, t); });
      els.filter.appendChild(group);
    });
    var old = state.filter.split("|");
    if (old[0] === "topic" && old.length === 2) {
      // saved before topic filters included the week: use the first week with that topic
      var first = QUESTIONS.filter(function (q) { return q.topic === old[1]; })[0];
      if (first) state.filter = "topic|" + first.week + "|" + old[1];
    }
    if (values.indexOf(state.filter) < 0) state.filter = "all";
    els.filter.value = state.filter;
    els.missedOnly.checked = !!state.missedOnly;
  }

  function counter(label, value) {
    var d = document.createElement("span");
    d.className = "counter";
    var b = document.createElement("b");
    b.textContent = value;
    d.appendChild(b);
    d.appendChild(document.createTextNode(" " + label));
    return d;
  }

  function renderCounters() {
    var qs = pool(), now = studyNow();
    var seen = 0, mastered = 0, missed = 0;
    qs.forEach(function (q) {
      var c = state.cards[q.id];
      if (c.reps) seen++;
      if (isMastered(c, now)) mastered++;
      if (c.reps && c.lastRating === AGAIN) missed++;
    });
    var removedCount = Object.keys(state.removed).length;
    els.restoreBtn.hidden = !removedCount;
    els.restoreBtn.textContent = "Restore removed (" + removedCount + ")";
    els.counters.innerHTML = "";
    els.counters.appendChild(counter("seen / " + qs.length, seen));
    els.counters.appendChild(counter("mastered", mastered));
    els.counters.appendChild(counter("to fix", missed));
    if (removedCount) els.counters.appendChild(counter("removed", removedCount));
    els.bar.style.width = qs.length ? (100 * mastered / qs.length) + "%" : "0";
    renderEstimate();
  }

  function renderEstimate() {
    els.estimateBtn.textContent = "Time left" + (els.estimatePanel.hidden ? " ▸" : " ▾");
    if (els.estimatePanel.hidden) return; // the estimate only shows once the panel is open
    var e = estimate(), done = !e.nUnseen;
    els.estimateTotal.textContent = done ? "Seen all questions" : formatDuration(e.total);
    var m = simulateMastery();
    els.masteryTotal.textContent = m.over ? "over 48h" : !m.reviews ? "All mastered ✓" : formatDuration(m.secs);
    var lines = [];
    if (done) lines.push("You've seen every question in this filter. New cards will come from spaced review." +
      (e.waiting ? " " + e.waiting + " missed/hard card" + (e.waiting === 1 ? " is" : "s are") + " still waiting to come back (" + formatDuration(e.total) + ")." : ""));
    else {
      lines.push(e.nUnseen + " unseen: " + e.unseen.mc + " multiple choice, " + e.unseen.tf + " true/false, " + e.unseen.fib + " fill-in" +
        (e.waiting ? " · plus " + e.waiting + " missed/hard card" + (e.waiting === 1 ? "" : "s") + " waiting to come back" : ""));
      var pace = ["mc", "tf", "fib"].map(function (t) {
        var p = state.pace[t], learned = paceMode === "auto" && p && p.n >= 3;
        return { mc: "MC", tf: "T/F", fib: "Fill-in" }[t] + " " + Math.round(secsPerCard(t)) + "s" + (learned ? " (yours)" : "");
      });
      lines.push("Pace per card: " + pace.join(" · "));
      lines.push("Expected misses ~" + Math.round(e.miss * 100) + "% → " + formatDuration(e.repeatSecs).replace("~", "+") + " for repeats");
    }
    if (m.over) lines.push("Full mastery: more than 48 hours of reviewing at this pace and miss rate.");
    else if (m.reviews) lines.push("Full mastery: ~" + m.reviews + " more reviews. Mastered cards come back on spaced intervals, so this assumes one continuous session (breaks let mastery wear off).");
    els.estimateBody.innerHTML = "";
    lines.forEach(function (text) {
      var li = document.createElement("li");
      li.textContent = text;
      els.estimateBody.appendChild(li);
    });
  }

  function showCard() {
    renderCounters();
    if (!els.stats.hidden) renderStats();
    currentId = pickNext();
    els.feedback.hidden = true;
    els.actions.innerHTML = "";
    els.choices.innerHTML = "";
    els.announce.textContent = "";
    choiceButtons = [];
    els.fibForm.hidden = true;
    els.fibInput.value = "";
    els.fibInput.className = "";
    els.fibInput.disabled = false;

    if (!currentId) {
      phase = "empty";
      els.tagWeek.textContent = ""; els.tagTopic.textContent = ""; els.tagType.textContent = "";
      els.tagAgain.hidden = true;
      els.removeBtn.hidden = true;
      var matching = QUESTIONS.filter(inFilter);
      var allRemoved = matching.length && matching.every(function (q) { return state.removed[q.id]; });
      els.prompt.textContent = allRemoved
        ? "You've removed every question here. Pick another topic, or use \"Restore removed\"."
        : state.missedOnly
        ? "No missed questions in this topic. Nice! Untick \"Missed only\" to keep going."
        : "No questions match this filter.";
      return;
    }
    phase = "ask";
    shownAt = Date.now();
    els.removeBtn.hidden = false;
    var q = byId[currentId], c = state.cards[currentId];
    els.tagWeek.textContent = q.week;
    els.tagTopic.textContent = q.topic;
    els.tagType.textContent = TYPE_LABEL[q.type];
    els.tagAgain.hidden = !c.lapses;
    els.prompt.textContent = q.prompt;

    if (q.type === "fib") {
      els.fibForm.hidden = false;
      els.fibInput.focus();
    } else {
      var choices = q.type === "tf" ? q.choices.slice() : shuffle(q.choices);
      choices.forEach(function (text, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "choice";
        var k = document.createElement("span");
        k.className = "key"; k.textContent = String(i + 1);
        var t = document.createElement("span");
        t.textContent = text;
        b.appendChild(k); b.appendChild(t);
        b.addEventListener("click", function () { answerChoice(text); });
        b.dataset.value = text;
        els.choices.appendChild(b);
        choiceButtons.push(b);
      });
    }
  }

  function answerChoice(text) {
    if (phase !== "ask") return;
    var q = byId[currentId];
    var ok = text === q.answer;
    choiceButtons.forEach(function (b) {
      b.disabled = true;
      if (b.dataset.value === q.answer) b.classList.add("right");
      else if (b.dataset.value === text) b.classList.add("wrong");
    });
    showFeedback(ok ? "right" : "wrong", q);
  }

  function answerTyped() {
    if (phase !== "ask") return;
    // An empty submit is almost always a stray second Enter from the previous card, not an answer.
    if (!els.fibInput.value.trim()) return;
    var q = byId[currentId];
    var result = checkTyped(q, els.fibInput.value);
    els.fibInput.disabled = true;
    els.fibInput.className = result === "right" ? "right" : "wrong";
    showFeedback(result, q);
  }

  // Wraps an action-button handler so it only runs in the phase it was created for.
  // If the answer was already recorded on the way out (phase "saved"), just move on.
  function inPhase(expected, fn) {
    return function () {
      if (phase === "saved") { showCard(); return; }
      if (phase === expected) fn();
    };
  }

  function addAction(label, hint, cls, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = cls || "";
    b.textContent = label;
    if (hint) { var s = document.createElement("small"); s.textContent = hint; b.appendChild(s); }
    b.addEventListener("click", fn);
    els.actions.appendChild(b);
    return b;
  }

  function showRatingButtons() {
    phase = "rateRight";
    els.actions.innerHTML = "";
    var id = currentId;
    addAction("Hard", "1", "r-hard", inPhase("rateRight", function () { rate(id, HARD); showCard(); }));
    addAction("Good", "2 / Enter", "r-good", inPhase("rateRight", function () { rate(id, GOOD); showCard(); }));
    addAction("Easy", "3", "r-easy", inPhase("rateRight", function () { rate(id, EASY); showCard(); }));
  }

  function showFeedback(result, q) {
    // Don't park focus on an action button: in some browsers the Enter press that
    // submitted the answer would then also "click" it. The keydown handler owns Enter.
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    els.feedback.hidden = false;
    els.verdict.className = "verdict " + (result === "right" ? "ok" : result === "close" ? "close" : "no");
    els.verdict.textContent = result === "right" ? "Correct!"
      : result === "close" ? "Close, but check your spelling (spelling counts on the quiz)."
      : "Not quite.";
    var alts = q.type === "fib" && q.accept && q.accept.length ? "  (also accepted: " + q.accept.join(", ") + ")" : "";
    els.correct.textContent = "Answer: " + q.answer + alts;
    els.explain.textContent = q.explain || "";
    els.announce.textContent = els.verdict.textContent + " " + els.correct.textContent;

    if (result === "right") {
      showRatingButtons();
    } else {
      phase = "wrong";
      els.actions.innerHTML = "";
      var id = currentId;
      addAction("Continue", "Enter (comes back in a few cards)", "", inPhase("wrong", function () { rate(id, AGAIN); showCard(); }));
      if (q.type === "fib") {
        addAction("I was right", "", "override", inPhase("wrong", function () {
          els.verdict.className = "verdict ok";
          els.verdict.textContent = "Marked correct.";
          els.announce.textContent = "Marked correct.";
          els.fibInput.className = "right";
          showRatingButtons();
        }));
      }
    }
  }

  function renderStats() {
    var topics = {}, now = studyNow();
    QUESTIONS.forEach(function (q) {
      if (state.removed[q.id]) return;
      var key = q.week + " · " + q.topic;
      var t = topics[key] = topics[key] || { name: key, right: 0, wrong: 0, n: 0, mastered: 0 };
      var c = state.cards[q.id];
      t.right += c.right; t.wrong += c.wrong; t.n++;
      if (isMastered(c, now)) t.mastered++;
    });
    var rows = Object.keys(topics).map(function (k) { return topics[k]; });
    rows.forEach(function (r) { var a = r.right + r.wrong; r.acc = a ? r.right / a : -1; });
    // weakest attempted topics first, untried topics last
    rows.sort(function (a, b) { return (a.acc < 0 ? 2 : a.acc) - (b.acc < 0 ? 2 : b.acc); });
    els.statsBody.innerHTML = "";
    rows.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "stat-row";
      var name = document.createElement("span");
      name.textContent = r.name + " (" + r.mastered + "/" + r.n + " mastered)";
      var barWrap = document.createElement("div");
      barWrap.className = "stat-bar";
      var bar = document.createElement("span");
      var pct = r.acc < 0 ? 0 : Math.round(r.acc * 100);
      bar.style.width = pct + "%";
      bar.style.background = pct >= 80 ? "var(--good)" : pct >= 60 ? "var(--warn)" : "var(--bad)";
      barWrap.appendChild(bar);
      var num = document.createElement("span");
      num.className = "stat-num";
      num.textContent = r.acc < 0 ? "–" : pct + "%";
      row.appendChild(name); row.appendChild(barWrap); row.appendChild(num);
      els.statsBody.appendChild(row);
    });
  }

  // Records an answer that was checked but not yet rated (wrong -> Again, right -> Good),
  // so leaving the card any other way (filter change, remove, closing the tab) never loses it.
  function settlePending() {
    if (currentId && phase === "wrong") rate(currentId, AGAIN);
    else if (currentId && phase === "rateRight") rate(currentId, GOOD);
    if (phase === "wrong" || phase === "rateRight") phase = "saved";
  }

  // Swaps in a new state (another tab's save, a merged backup) and refreshes the view.
  function adoptState(s) {
    state = s;
    if (phase === "empty" || (phase === "ask" && currentId && state.removed[currentId])) { currentId = null; showCard(); return; }
    renderCounters();
    if (!els.stats.hidden) renderStats();
  }

  // ───────────────────────── Backup file ─────────────────────────
  // Progress always lives in localStorage. It can also be mirrored to a JSON file the
  // user picks (e.g. cloud-econ-progress.json next to index.html) using the File System Access
  // API (Chrome/Edge). The file handle is remembered in IndexedDB. When the file is
  // linked, and on every page load, the two copies are merged, so either can be empty.
  var BACKUP_NAME = "cloud-econ-progress.json";
  var canPickFiles = typeof window.showSaveFilePicker === "function" && typeof window.showOpenFilePicker === "function";
  var backup = { handle: null, status: "off", timer: null, writing: null, again: false, lastWrite: 0 };
  var JSON_TYPES = [{ description: "Cloud Economics Cram backup", accept: { "application/json": [".json"] } }];
  var PICKER_ID = STORE_KEY; // file pickers reopen in the folder last used for this app's backup

  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("no IndexedDB")); return; }
      var open = indexedDB.open("cloud-econ-cram", 1);
      open.onupgradeneeded = function () { open.result.createObjectStore("kv"); };
      open.onerror = function () { reject(open.error); };
      open.onsuccess = function () {
        var db = open.result, req;
        try {
          var tx = db.transaction("kv", mode);
          req = fn(tx.objectStore("kv"));
          tx.oncomplete = function () { db.close(); resolve(req && req.result); };
          tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
        } catch (e) { db.close(); reject(e); }
      };
    });
  }
  function rememberHandle(h) {
    return idb("readwrite", function (s) { return h ? s.put(h, "handle") : s.delete("handle"); }).catch(function () {});
  }
  function recallHandle() {
    return idb("readonly", function (s) { return s.get("handle"); }).catch(function () { return null; });
  }

  function backupText() {
    return JSON.stringify({ app: "cloud-econ-cram", version: 1, savedAt: state.savedAt, state: state }, null, 2);
  }
  // Returns a normalized state, null for an empty file, or undefined if it isn't a backup.
  function parseBackup(text) {
    if (!String(text).trim()) return null;
    var d;
    try { d = JSON.parse(text); } catch (e) { return undefined; }
    var s = isPlainObject(d) && d.app === "cloud-econ-cram" ? d.state : d; // also accepts a raw localStorage copy
    return isPlainObject(s) && isPlainObject(s.cards) ? normalize(s) : undefined;
  }

  // Per card, the most recently reviewed copy wins; anything reviewed before the latest
  // reset is dropped. Removed questions come from whichever copy changed last.
  function mergeStates(local, other) {
    var resetAt = Math.max(local.resetAt, other.resetAt);
    var newer = other.savedAt > local.savedAt ? other : local;
    // each copy's card times are on its own study clock: keep the later clock and move
    // the other copy's cards onto it
    var keep = other.clock.real > local.clock.real ? other : local, src = keep === other ? local : other;
    var delta = keep.clock.virt - awayToStudy(keep.clock.real - src.clock.real) - src.clock.virt;
    var out = {
      cards: {}, step: Math.max(local.step, other.step), filter: local.filter, missedOnly: local.missedOnly,
      removed: newer.removed, pace: newer.pace, idScheme: ID_SCHEME, savedAt: Math.max(local.savedAt, other.savedAt), resetAt: resetAt,
      clock: { virt: keep.clock.virt, real: keep.clock.real }, clockFix: 1
    };
    QUESTIONS.forEach(function (q) {
      // the same review in both copies: take the one already on the kept clock
      var k = keep.cards[q.id], o = src.cards[q.id];
      var pick = o.seenAt > k.seenAt || (o.seenAt === k.seenAt && o.reps > k.reps) ? shiftCard(o, delta) : k;
      out.cards[q.id] = pick.seenAt && pick.seenAt < resetAt ? blankCard() : pick;
    });
    return out;
  }

  function setBackupStatus(status, message) {
    backup.status = status;
    var name = backup.handle ? backup.handle.name : BACKUP_NAME;
    var defaults = {
      off: canPickFiles
        ? "Progress is saved in this browser only. Link a file (e.g. " + BACKUP_NAME + " in your Cloud Economics folder) to keep a copy there too."
        : "This browser can't save to a file automatically. Use Download backup / Import backup below.",
      syncing: "Syncing with " + name + "…",
      on: "Saving to " + name + " and this browser." + (backup.lastWrite ? " Last written " + new Date(backup.lastWrite).toLocaleTimeString() + "." : ""),
      paused: "Linked to " + name + ", but the browser needs your OK again before writing to it. Click anywhere (or Reconnect) and allow it.",
      relink: "Backup is on with " + (linkedName() || BACKUP_NAME) + ", but the browser forgot which file it is. Click Reconnect and pick " +
        (linkedName() || BACKUP_NAME) + " again. Nothing is lost: the two copies merge.",
      error: "Something went wrong with the backup file."
    };
    els.backupBtn.textContent = { off: "Backup: off", syncing: "Backup: syncing…", on: "Backup: on", paused: "Backup: paused", relink: "Backup: reconnect", error: "Backup: error" }[status] +
      (els.backupPanel.hidden ? " ▸" : " ▾");
    els.backupBtn.classList.toggle("warn", status === "paused" || status === "relink" || status === "error");
    els.backupStatus.textContent = message || defaults[status];
    els.backupCreate.hidden = els.backupOpen.hidden = !canPickFiles || status === "on" || status === "syncing";
    els.backupReconnect.hidden = status !== "paused" && status !== "relink";
    els.backupDisconnect.hidden = !backup.handle && status !== "relink";
  }
  function backupFailed(e) {
    if (e && e.name === "NotFoundError") {
      // the file was moved or deleted: only now does backup turn off
      var gone = backup.handle ? backup.handle.name : linkedName() || "The backup file";
      disconnectBackup();
      setBackupStatus("off", gone + " is missing (moved or deleted), so backup was turned off. Create or pick a backup file to turn it back on.");
    } else if (e && e.name === "NotAllowedError") setBackupStatus("paused");
    else setBackupStatus("error", "Couldn't use " + (backup.handle ? backup.handle.name : "the backup file") + ": " + ((e && e.message) || e));
  }

  function scheduleBackup() {
    if (backup.status !== "on") return;
    clearTimeout(backup.timer);
    backup.timer = setTimeout(flushBackup, 400);
  }
  function flushBackup() {
    clearTimeout(backup.timer);
    if (!backup.handle) return Promise.resolve();
    if (backup.writing) { backup.again = true; return backup.writing; } // write again once this one ends
    var text = backupText(), written = state.savedAt;
    backup.writing = backup.handle.createWritable()
      .then(function (w) { return w.write(text).then(function () { return w.close(); }); })
      .then(function () {
        backup.writing = null;
        backup.lastWrite = Date.now();
        if (backup.again || state.savedAt !== written) { backup.again = false; return flushBackup(); }
        if (backup.status === "on" || backup.status === "syncing") setBackupStatus("on");
      }, function (e) { backup.writing = null; backup.again = false; backupFailed(e); });
    return backup.writing;
  }

  // Reads the file, merges it with the browser copy, and writes the result to both.
  function syncBackup() {
    setBackupStatus("syncing");
    return backup.handle.getFile()
      .then(function (f) { return f.text(); })
      .then(function (text) {
        var other = parseBackup(text);
        if (other === undefined) {
          // never overwrite a file that isn't ours
          var name = backup.handle.name;
          disconnectBackup();
          setBackupStatus("off", name + " isn't a Cloud Economics Cram backup, so it was left untouched. Pick or create a different file.");
          return;
        }
        if (other) adoptState(mergeStates(state, other));
        persist();
        return flushBackup();
      })
      .catch(backupFailed);
  }

  // The name of the linked file is also kept in localStorage, so if the browser forgets
  // the handle itself the app still knows a backup was on and asks to reconnect
  // instead of quietly showing "off".
  var LINKED_KEY = STORE_KEY + "-backup-linked";
  function linkedName() {
    try { return localStorage.getItem(LINKED_KEY) || ""; } catch (e) { return ""; }
  }
  function setLinkedName(name) {
    try { if (name) localStorage.setItem(LINKED_KEY, name); else localStorage.removeItem(LINKED_KEY); } catch (e) { /* storage unavailable */ }
  }

  function connectBackup(handle) {
    backup.handle = handle;
    rememberHandle(handle);
    setLinkedName(handle.name);
    return syncBackup();
  }
  function disconnectBackup() {
    clearTimeout(backup.timer);
    backup.handle = null;
    rememberHandle(null);
    setLinkedName("");
    setBackupStatus("off");
  }
  function openExistingBackup() {
    window.showOpenFilePicker({ id: PICKER_ID, types: JSON_TYPES, multiple: false })
      .then(function (hs) {
        var h = hs[0];
        return h.requestPermission({ mode: "readwrite" }).then(function (p) {
          if (p === "granted") return connectBackup(h);
          setBackupStatus("error", "The app needs permission to save to " + h.name + " to keep it in sync.");
        });
      }, ignoreCancel);
  }
  // Chrome asks again for write permission after a restart, and only lets a page ask
  // during a click or key press, so the first one anywhere on the page asks for it.
  function reconnectOnNextGesture() {
    function go() {
      document.removeEventListener("pointerdown", go, true);
      document.removeEventListener("keydown", go, true);
      if (backup.status !== "paused" || !backup.handle) return;
      backup.handle.requestPermission({ mode: "readwrite" }).then(function (p) {
        if (p === "granted") return syncBackup();
      }, function () { /* leave it paused; Reconnect still works */ });
    }
    document.addEventListener("pointerdown", go, true);
    document.addEventListener("keydown", go, true);
  }
  function ignoreCancel(e) { if (!e || e.name !== "AbortError") backupFailed(e); }

  function initBackup() {
    var show = false;
    try { show = localStorage.getItem(SHOW_BACKUP_KEY) === "1"; } catch (e) { /* storage unavailable */ }
    showBackupPanel(show);
    setBackupStatus("off");
    if (!canPickFiles) return;
    recallHandle().then(function (h) {
      if (!h || typeof h.queryPermission !== "function") {
        if (linkedName()) setBackupStatus("relink");
        return;
      }
      backup.handle = h;
      if (!linkedName()) setLinkedName(h.name);
      return h.queryPermission({ mode: "readwrite" }).then(function (p) {
        if (p === "granted") return syncBackup();
        setBackupStatus("paused");
        reconnectOnNextGesture();
      });
    }).catch(backupFailed);
  }

  // Show/hide the backup section; the choice is remembered in this browser.
  var SHOW_BACKUP_KEY = "cloud-econ-show-backup";
  function showBackupPanel(open) {
    els.backupPanel.hidden = !open;
    els.backupBtn.setAttribute("aria-expanded", String(open));
    try { localStorage.setItem(SHOW_BACKUP_KEY, open ? "1" : "0"); } catch (e) { /* storage unavailable */ }
    setBackupStatus(backup.status, backup.status === "off" || backup.status === "on" ? undefined : els.backupStatus.textContent);
  }
  els.backupBtn.addEventListener("click", function () { showBackupPanel(els.backupPanel.hidden); });
  els.backupHide.addEventListener("click", function () { showBackupPanel(false); els.backupBtn.focus(); });
  els.backupCreate.addEventListener("click", function () {
    window.showSaveFilePicker({ id: PICKER_ID, suggestedName: BACKUP_NAME, types: JSON_TYPES }).then(connectBackup, ignoreCancel);
  });
  els.backupOpen.addEventListener("click", openExistingBackup);
  els.backupReconnect.addEventListener("click", function () {
    if (!backup.handle) { openExistingBackup(); return; } // browser forgot the file: pick it again
    backup.handle.requestPermission({ mode: "readwrite" }).then(function (p) {
      if (p === "granted") return syncBackup();
      setBackupStatus("paused");
    }, backupFailed);
  });
  els.backupDisconnect.addEventListener("click", disconnectBackup);
  els.backupDownload.addEventListener("click", function () {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([backupText()], { type: "application/json" }));
    a.download = BACKUP_NAME;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  els.backupImport.addEventListener("click", function () { els.backupImportFile.click(); });
  els.backupImportFile.addEventListener("change", function () {
    var f = els.backupImportFile.files[0];
    els.backupImportFile.value = "";
    if (!f) return;
    f.text().then(function (text) {
      var other = parseBackup(text);
      if (!other) { els.backupStatus.textContent = f.name + " isn't a Cloud Economics Cram backup."; return; }
      adoptState(mergeStates(state, other));
      save();
      els.backupStatus.textContent = "Imported " + f.name + " and merged it with this browser's progress.";
    });
  });

  // ───────────────────────── Events ─────────────────────────
  els.fibForm.addEventListener("submit", function (e) { e.preventDefault(); answerTyped(); });
  els.filter.addEventListener("change", function () {
    settlePending();
    state.filter = els.filter.value; save(); currentId = null; showCard();
  });
  els.missedOnly.addEventListener("change", function () {
    settlePending();
    state.missedOnly = els.missedOnly.checked; save(); currentId = null; showCard();
  });
  els.removeBtn.addEventListener("click", function () {
    if (!currentId) return;
    settlePending();
    state.removed[currentId] = true;
    save();
    els.removeBtn.blur(); // so a later Enter can't remove the next question too
    currentId = null;
    showCard();
  });
  els.restoreBtn.addEventListener("click", function () {
    var n = Object.keys(state.removed).length;
    if (!n || !confirm("Bring back all " + n + " removed question" + (n === 1 ? "" : "s") + "?")) return;
    state.removed = {};
    save();
    renderCounters();
    if (!els.stats.hidden) renderStats();
    if (!currentId) showCard();
  });
  // Time-left panel; open/closed is remembered in this browser.
  var SHOW_ESTIMATE_KEY = STORE_KEY + "-show-estimate";
  function showEstimatePanel(open) {
    els.estimatePanel.hidden = !open;
    els.estimateBtn.setAttribute("aria-expanded", String(open));
    try { localStorage.setItem(SHOW_ESTIMATE_KEY, open ? "1" : "0"); } catch (e) { /* storage unavailable */ }
    renderEstimate();
  }
  els.estimateBtn.addEventListener("click", function () { showEstimatePanel(els.estimatePanel.hidden); });
  els.estimateHide.addEventListener("click", function () { showEstimatePanel(false); els.estimateBtn.focus(); });
  els.paceMode.value = paceMode;
  els.paceMode.addEventListener("change", function () {
    paceMode = els.paceMode.value;
    try { localStorage.setItem(PACE_MODE_KEY, paceMode); } catch (e) { /* storage unavailable */ }
    renderEstimate();
  });
  (function () {
    var show = false;
    try { show = localStorage.getItem(SHOW_ESTIMATE_KEY) === "1"; } catch (e) { /* storage unavailable */ }
    els.estimatePanel.hidden = !show;
    els.estimateBtn.setAttribute("aria-expanded", String(show));
  })();

  els.statsBtn.addEventListener("click", function () {
    els.stats.hidden = !els.stats.hidden;
    if (!els.stats.hidden) renderStats();
  });
  els.resetBtn.addEventListener("click", function () {
    if (!confirm("Reset all progress? This clears every card's history.")) return;
    state = { cards: {}, step: 0, filter: state.filter, missedOnly: false, removed: state.removed, pace: state.pace,
      idScheme: ID_SCHEME, savedAt: 0, resetAt: Date.now(), clock: state.clock, clockFix: 1 };
    QUESTIONS.forEach(function (q) { state.cards[q.id] = blankCard(); });
    save();
    els.missedOnly.checked = false;
    currentId = null;
    showCard();
  });

  document.addEventListener("keydown", function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    var tag = (e.target && e.target.tagName) || "";
    var inText = tag === "INPUT" && e.target.type === "text";
    if (tag === "SELECT") return;
    if (phase === "ask" && choiceButtons.length && /^[1-9]$/.test(e.key)) {
      var b = choiceButtons[+e.key - 1];
      if (b) { e.preventDefault(); b.click(); }
      return;
    }
    if (inText) return; // let the form handle typing + Enter
    if (phase === "rateRight") {
      var map = { "1": 0, "2": 1, "3": 2 };
      var btns = els.actions.querySelectorAll("button");
      if (e.key in map) { e.preventDefault(); btns[map[e.key]].click(); }
      else if (e.key === "Enter") { e.preventDefault(); btns[1].click(); }
    } else if (phase === "wrong" && e.key === "Enter") {
      e.preventDefault();
      els.actions.querySelector("button").click();
    }
  });

  // Another tab saved progress: adopt it (keeping this tab's own filter view), so this
  // tab's next save builds on it instead of overwriting it.
  window.addEventListener("storage", function (e) {
    if (e.key !== null && e.key !== STORE_KEY) return;
    var s = load();
    s.filter = state.filter; s.missedOnly = state.missedOnly;
    adoptState(s);
  });

  // Leaving the page: record an answer that was checked but not yet rated, then write
  // everything. pagehide (not beforeunload) only fires when the page really goes away.
  // The file write is async and may not finish; the next load's sync catches it up.
  function flushOnExit() {
    persist();
    if (backup.status === "on") flushBackup();
  }
  window.addEventListener("pagehide", function () { settlePending(); flushOnExit(); });
  // Restored from the back/forward cache after an exit save: move on to a fresh card.
  window.addEventListener("pageshow", function (e) { if (e.persisted && phase === "saved") showCard(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { flushOnExit(); return; }
    // back after a while (maybe days): mastery and due counts have moved on
    renderCounters();
    if (!els.stats.hidden) renderStats();
  });

  persist(); // keep any repairs made while loading
  buildFilter();
  showCard();
  initBackup();
})();
