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
| `prompt` | yes | The question text. Line breaks (`\n`) are kept. |
| `code` | no | A full code listing shown under the prompt as a numbered, syntax-highlighted block (see [Code questions](#code-questions)). |
| `lang` | no | `"text"` turns highlighting off for `code`. Anything else (or nothing) highlights it as Python. |
| `answer` | yes | The correct answer. For `mc` it must exactly match one of `choices`. For `tf` it is `"True"` or `"False"`. |
| `choices` | `mc`, `tf` | Answer options. Multiple choice options are shuffled every time; true/false stays in order. |
| `accept` | `fib` only | Extra typed answers that also count as correct. |
| `explain` | no | Shown after you answer. |
| `prev` | no | Old IDs of this question (from before it was reworded). Progress saved under an old ID moves to the new one. |

In `prompt`, `choices` and `explain`, text wrapped in `` `backticks` `` is shown as inline code.

Copy this template into `questions.js` and replace the example questions:

```js
// M = multiple choice, T = true/false, F = fill in the blank (typed).
var QUESTIONS = [];
(function () {
  var W1 = "Week 1", W2 = "Week 2";

  // IDs are a hash of the prompt (and code), so adding, removing or reordering questions keeps
  // saved progress attached to the right question. Rewording a prompt gives it a new ID;
  // list the old ID in `prev` to carry its progress over.
  var usedIds = {};
  function hash(s) {
    var h = 0x811c9dc5; // FNV-1a
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  }
  function add(q) {
    var p = q.prompt;
    if (typeof p !== "string") { // from code() or reworded()
      q.prompt = p.text;
      if (p.code) q.code = p.code;
      if (p.lang) q.lang = p.lang;
      if (p.prev) q.prev = [].concat(p.prev);
    }
    var base = "h" + hash(q.code ? q.code + "\n\n" + q.prompt : q.prompt), id = base, n = 2;
    while (usedIds[id]) id = base + "-" + n++;
    usedIds[id] = true;
    q.id = id;
    q.legacyId = "q" + (QUESTIONS.length + 1);
    QUESTIONS.push(q);
  }
  // code([code lines], "question", "old id") : a prompt with a full code block under it.
  function code(lines, text, prev) { return { code: lines.join("\n"), text: text, prev: prev }; }
  // reworded("new prompt", "old id") : a text-only prompt that keeps the old wording's progress.
  function reworded(text, prev) { return { text: text, prev: prev }; }
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

  t = "Code";
  M(W2, t, code([
      "import numpy as np",
      "from sklearn.model_selection import train_test_split",
      "",
      "X = np.random.rand(150, 10)",
      "y = np.random.randint(0, 2, size=150)",
      "",
      "X_train, X_test, y_train, y_test = train_test_split(",
      "    X, y, test_size=0.3, random_state=42)",
      "",
      "print(X_train.shape)"
    ], "What does this code print?"),
    "(105, 10)", ["(105, 10)", "(45, 10)", "(150, 7)", "None of the above"],
    "30% of 150 = 45 test rows, so 105 train rows. `train_test_split` never changes the column count.");
  F(W2, t, code([
      "model = DecisionTreeClassifier()",
      "model.____(X_train, y_train)"
    ], "Fill in the method that trains the model."),
    ["fit", "fit()"], "`fit` trains the model on the training data.");
})();
```

### Code questions

Pass `code([...lines], "question")` as the prompt of any `M`, `T` or `F` question to show a full code listing. Each array item is one line, so indentation is written exactly as it should appear (no `\n` escapes). The question text appears above the block.

- The block has line numbers, keeps indentation, and scrolls sideways instead of wrapping long lines (on phones too).
- Python is highlighted (keywords, strings, numbers, comments, function calls). Set `lang: "text"` on the question to show code without highlighting.
- A run of three or more underscores (`____`) inside code is highlighted as a blank, which works well with fill in the blank questions.
- For several questions that share a setup, build the lines once (e.g. `var SETUP = [...]`) and reuse them with `SETUP.concat([...])`.
- Put short code in answers or explanations in `` `backticks` `` so it shows as inline code.

Tips:

- Set `t` once per topic, then list that topic's questions under it.
- Questions are introduced in the order their weeks first appear in the file, shuffled within each week.
- Multiple choice: put the correct answer in `choices` as well, spelled exactly the same as `answer`.
- Fill in the blank: put the answer you want shown first, then any alternatives (abbreviations, other spellings, written-out numbers).
- Changing a prompt's wording (or its code) resets that question's progress, since its ID comes from the prompt text and code. Fixing an answer, choices or explanation does not. To keep the progress, pass the old ID as the last argument of `code(...)` or `reworded(...)` (find it by running `QUESTIONS` in the browser console before you change the question).
- To rename the app, change the `<title>`, `<h1>` and subtitle in `index.html`.

## How it works

### Answering

- **Code questions:** any question can show a full code listing under the prompt, with line numbers and syntax highlighting. Wide code scrolls sideways inside the card.
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
