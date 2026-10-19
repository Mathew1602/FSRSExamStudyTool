# FSRS Exam Study Tool

A single-page quiz app for cramming before an exam. It uses the FSRS-5 spaced-repetition algorithm to decide which question to show next, so questions you miss come back quickly and questions you know well fade into the background.

It is plain HTML, CSS and JavaScript with no build step and no dependencies. Open `index.html` in a browser and it runs.

The question bank (`questions.js`) is not included in this repo. You need to write your own (see below).

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout. Loads `questions.js` first, then `app.js`. |
| `app.js` | The scheduler, answer checking, progress saving, stats and backups. |
| `style.css` | Styling. |
| `questions.js` | Your question bank. Ignored by git, so you have to create it. |

## Writing `questions.js`

`app.js` expects a global array named `QUESTIONS`. Each entry is an object like this:

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | A stable, unique ID. Progress is saved against it. |
| `legacyId` | yes | Any unique string. Only used to migrate old saves. |
| `week` | yes | The top-level group, e.g. `"Week 1"`. Shows up in the Topic filter. |
| `topic` | yes | The sub-group inside a week. Shows up in the Topic filter and Stats. |
| `type` | yes | `"mc"` (multiple choice), `"tf"` (true/false) or `"fib"` (fill in the blank). |
| `prompt` | yes | The question text. |
| `answer` | yes | The correct answer. For `mc` it must exactly match one of `choices`. For `tf` it is `"True"` or `"False"`. |
| `choices` | `mc`, `tf` | Answer options. Multiple choice options are shuffled every time; true/false stays in order. |
| `accept` | `fib` only | Extra typed answers that also count as correct. |
| `explain` | no | Shown after you answer. |

Writing those objects by hand is tedious, so the easiest way is to use small helper functions that build them for you and generate IDs from the prompt text. Copy this template into `questions.js` and replace the example questions:

```js
// M = multiple choice, T = true/false, F = fill in the blank (typed).
var QUESTIONS = [];
(function () {
  var W1 = "Week 1", W2 = "Week 2";

  // IDs are a hash of the prompt, so adding, removing or reordering questions keeps
  // saved progress attached to the right question. Rewording a prompt gives it a new ID.
  var usedIds = {};
  function hash(s) {
    var h = 0x811c9dc5; // FNV-1a
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  function add(q) {
    var base = "h" + hash(q.prompt), id = base, n = 2;
    while (usedIds[id]) id = base + "-" + n++;
    usedIds[id] = true;
    q.id = id;
    q.legacyId = "q" + (QUESTIONS.length + 1);
    QUESTIONS.push(q);
  }
  // M(week, topic, prompt, correctAnswer, [all choices incl. the correct one], explanation)
  function M(week, topic, prompt, answer, choices, explain) {
    add({ week: week, topic: topic, type: "mc", prompt: prompt, answer: answer, choices: choices, explain: explain });
  }
  // T(week, topic, prompt, true/false, explanation)
  function T(week, topic, prompt, answer, explain) {
    add({ week: week, topic: topic, type: "tf", prompt: prompt, answer: answer ? "True" : "False", choices: ["True", "False"], explain: explain });
  }
  // F(week, topic, prompt, ["official answer", "other accepted answers"...], explanation)
  function F(week, topic, prompt, answers, explain) {
    if (!Array.isArray(answers)) answers = [answers];
    add({ week: week, topic: topic, type: "fib", prompt: prompt, answer: answers[0], accept: answers.slice(1), explain: explain });
  }

  // ───────── WEEK 1 ─────────
  var t = "Basics";
  M(W1, t, "What is 2 + 2?", "4", ["4", "3", "5", "22"], "Simple addition.");
  T(W1, t, "The sky is green.", false, "It is blue.");
  F(W1, t, "Water freezes at ____ degrees Celsius.", ["0", "zero"], "0 °C at sea level.");

  // ───────── WEEK 2 ─────────
  t = "More basics";
  M(W2, t, "Which is a prime number?", "7", ["7", "8", "9", "10"]);
})();
```

Tips:

- Set `t` once per topic, then list that topic's questions under it.
- Questions are introduced in the order their weeks first appear in the file, shuffled within each week.
- Multiple choice: put the correct answer in `choices` as well, spelled exactly the same as `answer`.
- Fill in the blank: put the answer you want shown first, then any alternatives (abbreviations, other spellings, written-out numbers).
- Changing a prompt's wording resets that question's progress, since its ID comes from the prompt text. Fixing an answer or explanation does not.
- To rename the app, change the `<title>`, `<h1>` and subtitle in `index.html`.

## How it works

### Answering

- **Multiple choice and true/false:** click an option or press `1`–`4`.
- **Fill in the blank:** type the answer and press `Enter`. Matching ignores case, accents, punctuation, `$` and commas, extra spaces, hyphens and a leading "the/a/an". A near miss (one typo, or two for answers of 8+ characters) is flagged as a spelling slip but still counts as wrong. Numbers have to be exact.
- **Rating:** after a correct answer you rate it Hard, Good or Easy (`1`/`2`/`3`). A wrong answer is automatically rated Again.

### Scheduling (FSRS-5)

Every question has its own memory state: **stability** (how long you are likely to remember it) and **difficulty** (how hard it is for you). Each rating updates both using the standard FSRS-5 formulas and default parameters, aiming for 90% recall.

FSRS is built for reviews spread over days, but this app is for cramming, so time is compressed:

- **One FSRS "day" equals one real minute** while you are studying. A card with 5 days of stability comes back after about 5 minutes.
- **Again:** the card comes back 2–3 cards later.
- **Hard:** the card comes back 5–6 cards later.
- **Good / Easy:** the card is scheduled by time, using its new stability.
- **Time away runs at the real rate.** After more than 30 minutes without activity, the clock slows to normal speed, so a night off counts as about one FSRS day rather than 1,440 and your cards haven't all expired by morning.

To pick the next card, the scheduler takes the first match from this list:

1. Cards from Again/Hard that are now due.
2. Cards whose time-based interval has run out (most overdue first).
3. New, unseen cards.
4. Again/Hard cards that are not due yet, so a miss is never skipped.
5. Whichever card you are most likely to have forgotten.

It never shows the same card twice in a row if anything else is available.

A card counts as **mastered** once it has at least two reviews, was last rated Good or Easy, has stability of at least 5, and is still above 90% predicted recall. Mastery wears off as time passes.

### Other features

- **Topic filter:** study everything, a single week, or a single topic. **Missed only** narrows it to questions you have gotten wrong.
- **Remove question:** hides a question from your bank. **Restore removed** brings removed questions back.
- **Stats:** accuracy by topic, weakest topics first.
- **Time left:** estimates how long it will take to see every question in the current filter and to master them all. The mastery estimate runs the scheduler forward in a simulation. It learns your pace per question type, or you can set it to Fast, Normal or Slow.
- **Progress saving:** progress is saved in the browser's `localStorage` automatically and stays in sync across tabs.
- **Backup file:** in Chrome and Edge you can link a `.json` file that is updated automatically as you study. In any browser you can download or import a backup by hand, for example to move your progress to another computer. Importing merges with your current progress rather than replacing it.
- **Reset progress:** clears all saved progress.
