// Run with: node --test tests/
const test = require("node:test")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const Model = require("../Model.js")

function response(models, extra = {}) {
  return JSON.stringify(Object.assign({ fetchedAt: 1700000000, fetchError: false, models }, extra))
}

function model(id, benchmarks, name) {
  return { id, name: name || id, benchmarks }
}

// Enough models reporting one benchmark for it to earn a list.
function field(name, count, extra = {}) {
  const models = []
  for (let i = 0; i < count; i++) models.push(model("lab/m" + i, [Object.assign({ name, score: 50 + i }, extra)]))
  return models
}

test("parse rejects a response that isn't the expected shape", () => {
  for (const text of ["", "not json", "[]", "null", '{"models":{}}']) {
    assert.equal(Model.parse(text).ok, false, text)
  }
})

test("parse drops malformed scores and keeps the rest", () => {
  const parsed = Model.parse(response([
    model("lab/good", [
      { name: "Bench", score: 71.5, source: "https://example.test/a" },
      { name: "Bench", score: "71.5" },
      { name: "Bench", score: -1 },
      { name: "Bench", score: 1e12 },
      { name: "", score: 5 },
      null
    ]),
    model("lab/empty", [{ name: "Bench" }]),
    { id: "lab/nolist", benchmarks: "nope" }
  ]))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.models.length, 1)
  assert.equal(parsed.models[0].entries.length, 1)
  assert.equal(parsed.models[0].entries[0].score, 71.5)
})

test("markup and control characters reach the panel as plain, single-line text", () => {
  const parsed = Model.parse(response([
    model("lab/x", [{ name: "Bench", score: 1, harness: "a\nb\u0000c", variant: "<img src=x>" }], "<b>Model</b>\u2028two")
  ]))
  const entry = parsed.models[0].entries[0]
  assert.equal(parsed.models[0].name, "<b>Model</b> two")
  assert.equal(entry.harness, "a b c")
  assert.equal(entry.variant, "<img src=x>")
  assert.equal(Model.cleanText("x".repeat(500), 40).length, 40)
})

test("only a plain https address survives as a source", () => {
  assert.equal(Model.safeUrl("https://example.test/a?b=1#c"), "https://example.test/a?b=1#c")
  for (const bad of [
    "http://example.test/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "--private https://example.test/",
    "https://example.test/a b",
    "https://example.test/\"x",
    "https://user@example.test/",
    "https://example.test/" + "a".repeat(600),
    42
  ]) assert.equal(Model.safeUrl(bad), "", String(bad))
  assert.equal(Model.urlHost("https://www.example.test/a"), "example.test")
})

test("versions of a benchmark are separate lists, and v2 is 2", () => {
  const models = Model.parse(response([
    ...field("Bench", 13, { version: "2" }),
    model("lab/v", [{ name: "Bench", score: 99, version: "v2" }]),
    ...field("Bench", 12, { version: "4.0" }).map(m => Object.assign(m, { id: m.id + "-4" }))
  ])).models
  const lists = Model.lists(models)
  assert.deepEqual(lists.map(l => [l.label, l.models]), [["Bench 2", 14], ["Bench 4.0", 12]])
  assert.equal(Model.rows(models, lists[1].key).length, 12)
})

test("lists come from coverage, widest first, and a thinly reported benchmark gets none", () => {
  const models = Model.parse(response([
    ...field("Wide", 20),
    ...field("Narrow", Model.MIN_MODELS - 1).map(m => Object.assign(m, { id: m.id + "-n" })),
    ...field("Mid", 14).map(m => Object.assign(m, { id: m.id + "-m" }))
  ])).models
  assert.deepEqual(Model.lists(models).map(l => l.label), ["Wide", "Mid"])
})

test("a model counts once toward coverage but keeps a row per result", () => {
  const models = Model.parse(response([
    model("lab/a", [
      { name: "Bench", score: 60, harness: "One" },
      { name: "Bench", score: 70, harness: "Two" }
    ]),
    model("lab/b", [{ name: "Bench", score: 65 }])
  ])).models
  const lists = Model.lists(models)
  assert.equal(lists[0].models, 2)
  const rows = Model.rows(models, lists[0].key)
  assert.deepEqual(rows.map(r => [r.rank, r.id, r.score, r.harness]), [
    [1, "lab/a", 70, "Two"],
    [2, "lab/b", 65, ""],
    [3, "lab/a", 60, "One"]
  ])
})

test("a score on another scale is left out rather than sorted in", () => {
  const models = Model.parse(response([
    model("lab/a", [{ name: "Elo", score: 1900 }]),
    model("lab/b", [{ name: "Elo", score: 1700 }]),
    model("lab/c", [{ name: "Elo", score: 14, metric: "win rate" }])
  ])).models
  const rows = Model.rows(models, Model.lists(models)[0].key)
  assert.deepEqual(rows.map(r => r.score), [1900, 1700])
  assert.equal(rows[0].decimals, 0)
})

test("age picks the unit the panel's plural strings take", () => {
  assert.deepEqual(Model.age(30), { unit: "minutes", count: 0 })
  assert.deepEqual(Model.age(600), { unit: "minutes", count: 10 })
  assert.deepEqual(Model.age(7200), { unit: "hours", count: 2 })
  assert.deepEqual(Model.age(3 * 86400), { unit: "days", count: 3 })
  assert.deepEqual(Model.age(-5), { unit: "minutes", count: 0 })
})

test("a benchmark the models you use are on gets a list, ahead of the widest ones", () => {
  const used = Model.parseUsed('["mine-a","mine-b","mine-c"]')
  const mine = name => ["lab/mine-a", "lab/mine-b", "lab/mine-c"].map(id => model(id, [{ name, score: 70 }]))
  const others = (name, count, tag) => field(name, count).map(m => Object.assign(m, { id: m.id + tag }))
  const models = Model.parse(response([
    ...others("Old and wide", 30, "-w"),
    // New: only nine models report it, three of them yours.
    ...mine("New"), ...others("New", 6, "-n"),
    // Yours are on it, but with nothing much to compare them against.
    ...mine("Tiny"), ...others("Tiny", 1, "-t"),
    // Wide, with one of yours.
    model("lab/mine-a", [{ name: "Wide with one", score: 70 }]), ...others("Wide with one", 15, "-o")
  ])).models
  assert.deepEqual(Model.lists(models, used).map(l => [l.label, l.models, l.mine]), [
    ["New", 9, 3],
    ["Wide with one", 16, 1],
    ["Old and wide", 30, 0]
  ])
  // With no usage records it is the widest alone, as before.
  assert.deepEqual(Model.lists(models).map(l => l.label), ["Old and wide", "Wide with one"])
})

// ---- The graph: its form follows how the benchmark is built.

// Rows as Model.rows hands them to the chart: best score first.
function chartRows(specs) {
  const models = specs.map((spec, i) => ({
    id: "lab/c" + i,
    name: spec.name || "Model " + i,
    released: spec.when || "",
    benchmarks: [{ name: "Bench", score: spec.score, harness: spec.harness, metric: spec.metric }]
  }))
  const parsed = Model.parse(response(models)).models
  return Model.rows(parsed, Model.lists(parsed.concat(field("Bench", 0)))[0].key)
}

// One score per model, released a month apart from January 2025.
function history(scores) {
  return scores.map((score, i) => ({
    score,
    when: `${2025 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}-15`
  }))
}

test("a benchmark run in harnesses gets a strip of dots for each harness", () => {
  const specs = [
    { score: 90, harness: "Claude Code" }, { score: 85, harness: "Claude Code 2.1.207" }, { score: 84, harness: "claude-code" },
    { score: 80, harness: "Terminus-2" }, { score: 75, harness: "Terminus 2" }, { score: 74, harness: "Terminus 2" },
    { score: 70, harness: "Codex" }, { score: 69, harness: "Codex" }, { score: 68, harness: "Codex" },
    { score: 67, harness: "Rarely Used" }, { score: 66, harness: "Rarely Used" },
    { score: 65, harness: "Fourth" }, { score: 64, harness: "Fourth" }, { score: 63, harness: "Fourth" }
  ]
  for (let i = 0; i < 9; i++) specs.push({ score: 50 - i })
  const rows = chartRows(specs)
  const chart = Model.chart(rows)
  assert.equal(chart.form, "strips")
  // Spellings and versions of one harness are one strip. Three get a strip:
  // a harness with two results can't be compared, and the fourth is one too
  // many. Those and the results naming no harness share the last strip,
  // which the panel words.
  assert.deepEqual(chart.strips.map(strip => strip.label), ["Claude Code", "Codex", "Fourth", ""])
  assert.deepEqual(chart.items.slice(0, 14).map(item => item.strip), [0, 0, 0, 3, 3, 3, 1, 1, 1, 3, 3, 2, 2, 2])
  // Every result is on the graph, and the best of each strip is marked.
  assert.equal(chart.items.length, rows.length)
  assert.deepEqual(chart.items.filter(item => item.record).map(item => rows[item.row].score), [90, 80, 70, 65])
  // The strips tile the graph; the shared one is the widest, but no more than twice a named one.
  const widths = chart.strips.map(strip => strip.w)
  assert.ok(Math.abs(widths.reduce((a, b) => a + b) - 1) < 1e-9)
  assert.ok(Math.abs(widths[3] - 2 * widths[0]) < 1e-9, JSON.stringify(widths))
  // And every dot stays inside its own strip.
  for (const item of chart.items) {
    const strip = chart.strips[item.strip]
    assert.ok(Math.abs(item.x - strip.x) < strip.w / 2 && item.y >= 0 && item.y <= 1, JSON.stringify(item))
  }
})

test("dots that would land on each other in a strip step aside", () => {
  const rows = chartRows([90, 89.9, 89.8, 60].map(score => ({ score, harness: "Codex" })))
  const xs = Model.chart(rows).items.map(item => item.x)
  // Three near-equal scores sit side by side; the distant one is back on the centre line.
  assert.equal(new Set(xs.slice(0, 3)).size, 3)
  assert.equal(xs[3], xs[0])
})

test("a full shared strip spreads its dots across its extra width", () => {
  // Twenty near-equal scores with no harness beside three small named strips.
  const specs = ["A", "B", "C"].flatMap(harness => [70, 60, 50, 40, 30].map(score => ({ score, harness })))
  for (let i = 0; i < 20; i++) specs.push({ score: 80 + i * 0.05 })
  const chart = Model.chart(chartRows(specs))
  const rest = chart.strips[3]
  const xs = chart.items.filter(item => item.strip === 3).map(item => item.x)
  // More places than a named strip has room for, so none of these twenty share one.
  const named = chart.strips[0]
  assert.ok(new Set(xs).size > Math.floor(named.w * 0.84 / 0.024) + 1, new Set(xs).size + " places")
  assert.ok(Math.max(...xs) - Math.min(...xs) > named.w, "spread " + (Math.max(...xs) - Math.min(...xs)))
})

test("a harness named on only a few results doesn't make it an agent benchmark", () => {
  const rows = chartRows(history([10, 20, 30, 40, 50, 60, 70, 80, 90, 95]).map((spec, i) => Object.assign(spec, i < 3 ? { harness: "Claude Code" } : {})))
  assert.deepEqual(Model.harnessGroups(rows), [])
  assert.equal(Model.chart(rows).form, "time")
})

test("one score per model with a long enough history is score over time", () => {
  // Month by month: 40, 30, 55, 50, 70, 65, 60, 72, 71, 90.
  const rows = chartRows(history([40, 30, 55, 50, 70, 65, 60, 72, 71, 90]))
  const chart = Model.chart(rows)
  assert.equal(chart.form, "time")
  assert.equal(chart.items.length, 10)
  // The line steps up only where a model beat everything before it.
  assert.deepEqual(chart.steps.map(step => rows[step.row].score), [40, 55, 70, 72, 90])
  assert.deepEqual(chart.items.filter(item => item.record).map(item => rows[item.row].score).sort((a, b) => a - b), [40, 55, 70, 72, 90])
  // Dots need no zero: the axis keeps to where the scores are.
  assert.deepEqual(chart.axis.ticks, [20, 40, 60, 80, 100])
  for (const item of chart.items) assert.ok(item.x >= 0 && item.x <= 1 && item.y >= 0 && item.y <= 1, JSON.stringify(item))
  // Ten months of data, thinned to at most five month ticks.
  assert.ok(chart.xTicks.length >= 2 && chart.xTicks.length <= 5, String(chart.xTicks.length))
})

test("a short or mostly undated history falls back to plain columns", () => {
  const short = chartRows(history([10, 20, 30, 40, 50, 60, 70, 80]).map(spec => Object.assign(spec, { when: "2026-01-" + String(10 + spec.score / 10).padStart(2, "0") })))
  assert.equal(Model.chart(short).form, "columns")
  // Columns are measured from zero, on round numbers.
  assert.deepEqual(Model.chart(short).axis.ticks, [0, 20, 40, 60, 80])

  const undated = chartRows(history([10, 20, 30, 40, 50, 60, 70, 80, 90, 95]).map((spec, i) => i % 2 ? { score: spec.score } : spec))
  assert.equal(Model.chart(undated).form, "columns")
})

test("ratings with no history are dots on their own axis, not columns from zero", () => {
  // Elo-style scores: from zero, 1850 and 1900 would be columns of the same height.
  const rows = chartRows([1900, 1880, 1850, 1820, 1790, 1700].map(score => ({ score })))
  const chart = Model.chart(rows)
  assert.equal(chart.form, "columns")
  assert.equal(chart.dots, true)
  assert.equal(chart.items.length, 6)
  assert.ok(chart.axis.min > 1000, "axis starts at " + chart.axis.min)
  assert.ok(chart.items[0].y - chart.items[5].y > 0.5, "the spread should fill the axis")
  // Shares of a whole keep their columns from zero.
  assert.equal(Model.chart(chartRows([90, 80, 70].map(score => ({ score })))).dots, false)
})

test("columns show the top results only, and say how many there are", () => {
  const specs = []
  for (let i = 0; i < 30; i++) specs.push({ score: 30 + i })
  const chart = Model.chart(chartRows(specs))
  assert.equal(chart.items.length, Model.MAX_COLUMNS)
  assert.equal(chart.total, 30)
  assert.deepEqual(chart.order, chart.items.map(item => item.row))
  assert.equal(Model.chart([]).form, "")
})

test("the value axis is titled with the metric most results name", () => {
  const named = metrics => Model.chart(chartRows(metrics.map((metric, i) => ({ score: 90 - i, metric })))).metrics
  // One wording covers enough of them; "score" and no metric name nothing.
  assert.deepEqual(named(["resolve rate", "Resolve Rate", "resolve rate", "pass@1", "score", ""]), ["resolve rate"])
  // Split results name both, commonest first, and stop at two.
  assert.deepEqual(named(["pass@1", "success rate", "pass@1", "success rate", "pass@1", "accuracy"]), ["pass@1", "success rate"])
  assert.deepEqual(named(["a", "b", "c", "d"]), ["a", "b"])
  assert.deepEqual(named(["score", "", "score"]), [])
  // A bare sign is no name for an axis.
  assert.deepEqual(named(["%", "%", "pass@1"]), ["pass@1"])
  // A metric named like an object's own machinery is only a name.
  assert.deepEqual(named(["constructor", "__proto__", "constructor"]), ["constructor"])

  // Columns show the top results only, so only those are counted.
  const rows = chartRows(Array.from({ length: 20 }, (_, i) => ({ score: 90 - i, metric: i < 12 ? "accuracy" : "win rate" })))
  assert.deepEqual(Model.chart(rows).metrics, ["accuracy"])
  assert.deepEqual(Model.chart([]).metrics, [])
})

// The rows of a benchmark whose models each report the given results.
function benchRows(models) {
  const parsed = Model.parse(response(Object.entries(models).map(([id, results]) =>
    model("lab/" + id, results.map(result => Object.assign({ name: "Bench" }, result)))))).models
  return Model.rows(parsed, parsed[0].entries[0].key)
}

test("a second metric the same runs were also reported under is left out", () => {
  // Three models give a lenient and a strict number for one run; three more
  // give one number, under another name for the lenient one.
  const rows = benchRows({
    a: [{ score: 78, metric: "mean partial score", variant: "max" }, { score: 39, metric: "binary completion rate", variant: "max" }],
    b: [{ score: 72, metric: "mean partial score", variant: "max" }, { score: 34, metric: "binary completion rate", variant: "max" }],
    c: [{ score: 69, metric: "mean partial score", variant: "max" }, { score: 33, metric: "binary completion rate", variant: "max" }],
    d: [{ score: 89, metric: "partial score" }],
    e: [{ score: 80, metric: "partial score" }],
    f: [{ score: 72, metric: "partial score" }]
  })
  assert.deepEqual(rows.map(row => row.score), [89, 80, 78, 72, 72, 69])
  assert.ok(rows.every(row => row.metric !== "binary completion rate"))
})

test("metrics reported against each other take opposite sides, and the fuller side stays", () => {
  // "partial score" and "mean partial score" never meet in one run, but each
  // is reported against a strict metric, and one of those against both.
  const rows = benchRows({
    a: [{ score: 77, metric: "partial score" }, { score: 41, metric: "strict success rate" }],
    b: [{ score: 66, metric: "mean partial score" }, { score: 32, metric: "binary completion rate" }],
    c: [{ score: 52, metric: "partial score" }, { score: 19, metric: "binary completion rate" }],
    d: [{ score: 81, metric: "partial score" }],
    e: [{ score: 60, metric: "success rate" }]
  })
  assert.deepEqual(rows.map(row => row.metric), ["partial score", "partial score", "mean partial score", "success rate", "partial score"])
})

test("one doubled run, or one number under two names, leaves nothing out", () => {
  const once = benchRows({
    a: [{ score: 70, metric: "pass@1" }, { score: 64, metric: "success rate" }],
    b: [{ score: 60, metric: "pass@1" }],
    c: [{ score: 50, metric: "success rate" }]
  })
  assert.equal(once.length, 4)

  const renamed = benchRows({
    a: [{ score: 70, metric: "pass@1" }, { score: 70, metric: "success rate" }],
    b: [{ score: 60, metric: "pass@1" }, { score: 60, metric: "success rate" }]
  })
  assert.equal(renamed.length, 4)

  // Two harnesses are two runs, whatever their metrics are called.
  const harnesses = benchRows({
    a: [{ score: 70, metric: "pass@1", harness: "Codex" }, { score: 64, metric: "success rate", harness: "Claude Code" }],
    b: [{ score: 60, metric: "pass@1", harness: "Codex" }, { score: 55, metric: "success rate", harness: "Claude Code" }]
  })
  assert.equal(harnesses.length, 4)
})

test("a benchmark where less is better ranks and tracks its best the other way up", () => {
  const months = ["2025-01-10", "2025-04-10", "2025-07-10", "2025-10-10", "2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10"]
  const scores = [0.9, 0.7, 0.8, 0.5, 0.6, 0.3, 0.4, 0.2]
  const parsed = Model.parse(response(scores.map((score, i) => ({
    id: "lab/d" + i, name: "Model " + i, released: months[i],
    benchmarks: [{ name: "Bench", score, metric: "overall edit distance" }]
  })).concat([model("lab/odd", [{ name: "Bench", score: 0.95, metric: "accuracy" }])]))).models
  const rows = Model.rows(parsed, parsed[0].entries[0].key)
  // The lowest is first, and the one result that runs the other way is gone.
  assert.deepEqual(rows.map(row => row.score), [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
  assert.equal(rows[0].rank, 1)

  const chart = Model.chart(rows)
  assert.equal(chart.form, "time")
  assert.equal(chart.lower, true)
  // Each record is lower than the one before it.
  assert.deepEqual(chart.steps.map(step => rows[step.row].score), [0.9, 0.7, 0.5, 0.3, 0.2])

  // A stray lower-is-better result doesn't turn a benchmark over.
  const usual = benchRows({ a: [{ score: 80, metric: "accuracy" }], b: [{ score: 70, metric: "accuracy" }], c: [{ score: 5, metric: "error rate" }] })
  assert.deepEqual(usual.map(row => row.score), [80, 70])
  assert.equal(Model.chart(usual).lower, false)
})

test("an impossible date is no date", () => {
  const parsed = Model.parse(response([
    Object.assign(model("lab/a", [{ name: "Bench", score: 1, date: "2026-13-40" }]), { released: "0000-00-00" }),
    Object.assign(model("lab/b", [{ name: "Bench", score: 2 }]), { released: "2026-05-01" })
  ])).models
  assert.equal(parsed[0].released, "")
  assert.equal(parsed[0].entries[0].date, "")
  assert.equal(parsed[1].released, "2026-05-01")
})

test("record labels keep clear of each other and of the edges", () => {
  const rows = chartRows(history([40, 41, 42, 43, 44, 45, 46, 47, 48, 90]).map((spec, i) => Object.assign(spec, { name: "A model with a very long name " + i })))
  const chart = Model.chart(rows)
  const labels = Model.pointLabels(chart, rows, 300, 200, 7, 12)
  assert.ok(labels.length >= 1 && labels.length <= 4)
  for (const label of labels) {
    assert.ok(label.text.length <= 18)
    assert.ok(label.x >= 0 && label.x + label.w <= 300, JSON.stringify(label))
    // Up and to the left of its dot, where the line never runs.
    const step = chart.steps.find(s => s.row === label.row)
    assert.ok(label.x + label.w < step.x * 300 && label.y + 12 < (1 - step.y) * 200, JSON.stringify(label))
  }
  // The first record is at the left edge with no room for a name: left off.
  assert.ok(!labels.some(label => label.row === chart.steps[0].row))
})

test("the models you use are matched by name, whatever the source calls them", () => {
  const used = Model.parseUsed(JSON.stringify(["claude-opus-5-5", "grok-4.7", "grok-latest", 7, "<b>x</b>"]))
  const models = Model.parse(response([
    model("anthropic/claude-opus-5-5", [{ name: "Bench", score: 80 }]),
    model("xai/grok-4.7", [{ name: "Bench", score: 70 }]),
    model("xai/grok-4.7-fast", [{ name: "Bench", score: 60 }]),
    model("openrouter/anthropic/claude-opus-5-5", [{ name: "Bench", score: 50 }]),
    model("meta/muse-spark", [{ name: "Bench", score: 40 }])
  ])).models
  const rows = Model.rows(models, Model.lists(models.concat(Model.parse(response(field("Bench", 0))).models))[0].key, used)
  // The provider prefix and punctuation don't matter; a longer name is another model.
  assert.deepEqual(rows.map(row => row.mine), [true, true, false, true, false])
  // No usage records, or unreadable ones, mark nothing and break nothing.
  assert.deepEqual(Model.parseUsed("not json"), {})
  assert.deepEqual(Model.parseUsed('{"a":1}'), {})
  assert.ok(Model.rows(models, rows.length ? Model.lists(models)[0].key : "").every(row => row.mine === false))
})

test("a model you use is named on the time graph before the record setters, but never under the line", () => {
  // A record early on, then a long flat run. "Clear" sits well under the run;
  // "Tucked" sits just under it, where its name would be struck through.
  const specs = history([80, 10, 10, 10, 10, 78, 10, 10, 40, 10, 10, 10]).map((spec, i) => Object.assign(spec, { name: "Filler " + i }))
  specs[5].name = "Tucked"
  specs[8].name = "Clear"
  const models = specs.map((spec, i) => ({ id: "lab/" + spec.name.toLowerCase().replace(" ", "-"), name: spec.name, released: spec.when, benchmarks: [{ name: "Bench", score: spec.score }] }))
  const parsed = Model.parse(response(models)).models
  const rows = Model.rows(parsed, Model.lists(parsed)[0].key, Model.parseUsed('["tucked","clear"]'))
  const chart = Model.chart(rows)
  assert.equal(chart.form, "time")
  const labels = Model.pointLabels(chart, rows, 400, 200, 7, 12)
  assert.equal(labels[0].text, "Clear")
  assert.equal(labels[0].mine, true)
  assert.ok(!labels.some(label => label.text === "Tucked"))
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j]
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + 12 <= b.y || b.y + 12 <= a.y, "labels overlap")
  }
  assert.deepEqual(Model.pointLabels(chart, rows, 0, 0, 7, 12), [])
})

// The fetch script itself, against a fake curl, so no test touches the network.
function runFetch(cacheHome, { curl, force = "0", maxAge = "86400" }) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "bench-bin-"))
  fs.writeFileSync(path.join(bin, "curl"), "#!/bin/bash\n" + curl + "\n", { mode: 0o755 })
  const out = execFileSync("bash", ["-c", Model.FETCH_SCRIPT, "bash", Model.SOURCE_URL, maxAge, force], {
    env: Object.assign({}, process.env, { XDG_CACHE_HOME: cacheHome, PATH: bin + ":" + process.env.PATH }),
    encoding: "utf8"
  })
  fs.rmSync(bin, { recursive: true })
  return JSON.parse(out)
}

// A fake curl that writes the given body to its -o target.
function curlWriting(body) {
  return 'while (( $# )); do if [[ $1 == "-o" ]]; then out=$2; fi; shift; done\nprintf %s ' + JSON.stringify(body).replace(/\$/g, "\\$") + ' > "$out"'
}

const upstream = JSON.stringify({
  "lab/scored": { name: "Scored", release_date: "2026-03-01", limit: { context: 1 }, benchmarks: [{ name: "Bench", score: 5 }] },
  "lab/unscored": { name: "Unscored" },
  "lab/empty": { name: "Empty", benchmarks: [] }
})

test("the fetch script caches the file and prints only the models with scores", () => {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cache-"))
  const first = runFetch(cacheHome, { curl: curlWriting(upstream) })
  assert.equal(first.fetchError, false)
  assert.deepEqual(first.models, [{ id: "lab/scored", name: "Scored", released: "2026-03-01", benchmarks: [{ name: "Bench", score: 5 }] }])

  // A fresh cache is read without fetching: this curl would fail if called.
  const second = runFetch(cacheHome, { curl: "exit 22" })
  assert.equal(second.fetchError, false)
  assert.equal(second.models.length, 1)
  fs.rmSync(cacheHome, { recursive: true })
})

test("a failed or malformed refresh keeps the cached copy and reports the error", () => {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cache-"))
  runFetch(cacheHome, { curl: curlWriting(upstream) })

  const offline = runFetch(cacheHome, { curl: "exit 6", force: "1" })
  assert.equal(offline.fetchError, true)
  assert.equal(offline.models.length, 1)

  const garbage = runFetch(cacheHome, { curl: curlWriting("<html>not json</html>"), force: "1" })
  assert.equal(garbage.fetchError, true)
  assert.equal(garbage.models.length, 1)
  assert.deepEqual(fs.readdirSync(path.join(cacheHome, "yamz8.benchmarks")), ["models.json"])
  fs.rmSync(cacheHome, { recursive: true })
})

test("with no cache and no network the script still answers, with nothing", () => {
  const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), "bench-cache-"))
  const result = runFetch(cacheHome, { curl: "exit 6" })
  assert.deepEqual(result, { fetchedAt: 0, fetchError: true, models: [] })
  assert.equal(Model.parse(JSON.stringify(result)).ok, true)
  fs.rmSync(cacheHome, { recursive: true })
})
