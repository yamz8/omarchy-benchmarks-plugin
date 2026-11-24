// Everything the panel knows about the data: where it comes from, how it is
// fetched and cached, and how the untrusted response becomes rows. Kept free
// of QML so tests/model.test.js can run it under Node.

// The one place the plugin reaches out to. models.dev publishes this file
// under MIT; each score in it carries the page it was taken from.
var SOURCE_URL = "https://models.dev/models.json"
var SOURCE_NAME = "models.dev"

// The cached copy is refetched once it is this old, and only when the panel
// is opened: nothing runs while it is closed.
var MAX_AGE_SECONDS = 86400

var MAX_MODELS = 2000
var MAX_ENTRIES_PER_MODEL = 80
var MAX_ROWS = 120
var MAX_LISTS = 8
// A benchmark few models report is no leaderboard; this many earns it a list.
var MIN_MODELS = 12
// The widest benchmarks are the long-established ones, which the newest
// models are often no longer reported on. So a benchmark also earns a list
// when at least this many of the models you use are on it, with this many
// models to compare them against; up to this many such lists are added.
var MIN_MINE = 2
var MIN_MODELS_WITH_MINE = 5
var MAX_MINE_LISTS = 6

// Fetches into the cache when it is stale (or when forced), then prints the
// models that have scores as one JSON object. The URL, age and force flag
// arrive as arguments, never spliced into the script. A failed fetch keeps
// the cached copy and says so with fetchError.
var FETCH_SCRIPT = [
  'url=$1; max_age=$2; force=$3',
  'dir="${XDG_CACHE_HOME:-$HOME/.cache}/yamz8.benchmarks"',
  'file="$dir/models.json"',
  'mkdir -p "$dir" || exit 1',
  'age=$max_age',
  'if [[ -f $file ]]; then age=$(( $(date +%s) - $(stat -c %Y "$file") )); fi',
  'fetch_error=false',
  'if [[ $force == "1" ]] || (( age >= max_age )); then',
  '  tmp=$(mktemp "$dir/models.XXXXXX") || exit 1',
  '  if curl -fsSL --max-time 20 --max-filesize 8000000 --proto =https --proto-redir =https -o "$tmp" -- "$url" \\',
  '    && jq -e \'type == "object"\' "$tmp" >/dev/null 2>&1; then',
  '    mv -f "$tmp" "$file"',
  '  else',
  '    rm -f "$tmp"',
  '    fetch_error=true',
  '  fi',
  'fi',
  'if [[ ! -f $file ]]; then echo \'{"fetchedAt":0,"fetchError":true,"models":[]}\'; exit 0; fi',
  'jq -c --argjson fetchedAt "$(stat -c %Y "$file")" --argjson fetchError "$fetch_error" \\',
  '  \'{fetchedAt: $fetchedAt, fetchError: $fetchError, models: [to_entries[]',
  '    | select((.value | type) == "object" and ((.value.benchmarks // []) | type) == "array" and ((.value.benchmarks // []) | length) > 0)',
  '    | {id: .key, name: .value.name, released: .value.release_date, benchmarks: .value.benchmarks}]}\' "$file"'
].join("\n")

// The names of the models this machine has used, from the records the agents
// panel keeps (one file an agent, with its tokens by model). Read locally and
// never sent anywhere; a record that can't be read is skipped.
var USED_SCRIPT = [
  'shopt -s nullglob',
  'for file in "$HOME/.local/state/omarchy/agents/usage"/*.json; do',
  '  jq -c \'(.modelUsage? // {}) | objects | keys\' "$file" 2>/dev/null',
  'done | jq -s -c \'add // [] | unique\''
].join("\n")

function usedCommand() {
  return ["bash", "-c", USED_SCRIPT]
}

function fetchCommand(force) {
  return ["bash", "-c", FETCH_SCRIPT, "bash", SOURCE_URL, String(MAX_AGE_SECONDS), force ? "1" : "0"]
}

// One line of plain text, bounded. Control characters and line breaks go, so
// a value can't break a row apart; markup stays as the characters it is,
// because every Text that shows it is PlainText.
function cleanText(value, max) {
  if (typeof value !== "string" && typeof value !== "number") return ""
  var text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim()
  return text.length > max ? text.slice(0, max) : text
}

// Only a plain https address is ever handed to the browser.
function safeUrl(value) {
  if (typeof value !== "string" || value.length > 500) return ""
  return /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s"'<>\\^`{|}]*)?$/i.test(value) ? value : ""
}

function urlHost(url) {
  var match = /^https:\/\/([^\/:]+)/i.exec(String(url || ""))
  return match ? match[1].replace(/^www\./i, "") : ""
}

// What a model is called once the differences between sources are dropped:
// "anthropic/claude-opus-5-5", "claude-opus-5-5" and "Claude Opus 5.5" agree.
function modelKey(name) {
  var text = cleanText(name, 120)
  return text.slice(text.lastIndexOf("/") + 1).toLowerCase().replace(/[^a-z0-9]+/g, "")
}

// USED_SCRIPT's output as a lookup by modelKey.
function parseUsed(text) {
  var used = {}
  var names
  try {
    names = JSON.parse(String(text || ""))
  } catch (e) {
    return used
  }
  if (!Array.isArray(names)) return used
  for (var i = 0; i < names.length && i < 500; i++) {
    var key = modelKey(names[i])
    if (key !== "") used[key] = true
  }
  return used
}

// "v2" and "2" are the same version.
function normalizeVersion(value) {
  return cleanText(value, 16).replace(/^v(?=\d)/i, "")
}

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ""
  var year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10))
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31 ? value : ""
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null
  var name = cleanText(raw.name, 60)
  var score = raw.score
  if (name === "" || typeof score !== "number" || !isFinite(score) || score < 0 || score > 100000) return null
  var version = normalizeVersion(raw.version)
  return {
    // Versions of a benchmark are different tests, so each gets its own list.
    key: name.toLowerCase() + "\u0000" + version.toLowerCase(),
    name: name,
    version: version,
    score: score,
    metric: cleanText(raw.metric, 40),
    harness: cleanText(raw.harness, 40),
    variant: cleanText(raw.variant, 60),
    date: isoDate(raw.date),
    source: safeUrl(raw.source)
  }
}

// The fetch script's output, validated. Anything malformed is dropped rather
// than shown, and an unreadable response is ok: false.
function parse(text) {
  var failed = { ok: false, fetchedAt: 0, fetchError: true, models: [] }
  var data
  try {
    data = JSON.parse(String(text || ""))
  } catch (e) {
    return failed
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.models)) return failed

  var models = []
  for (var i = 0; i < data.models.length && models.length < MAX_MODELS; i++) {
    var raw = data.models[i]
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.benchmarks)) continue
    var id = cleanText(raw.id, 120)
    if (id === "") continue
    var entries = []
    for (var j = 0; j < raw.benchmarks.length && entries.length < MAX_ENTRIES_PER_MODEL; j++) {
      var entry = normalizeEntry(raw.benchmarks[j])
      if (entry) entries.push(entry)
    }
    if (entries.length === 0) continue
    models.push({ id: id, name: cleanText(raw.name, 60) || id, released: isoDate(raw.released), entries: entries })
  }

  var fetchedAt = typeof data.fetchedAt === "number" && isFinite(data.fetchedAt) && data.fetchedAt > 0 ? Math.floor(data.fetchedAt) : 0
  return { ok: true, fetchedAt: fetchedAt, fetchError: data.fetchError === true, models: models }
}

// The benchmarks worth a list: the ones the most models report, and the ones
// the models you use are on (`used`, from parseUsed). Those with more of your
// models come first, then the widest. Nothing here names a benchmark: when
// one falls out of use and another takes over, the lists follow the data.
function lists(models, used) {
  var byKey = {}
  for (var i = 0; i < models.length; i++) {
    var mine = !!used && used[modelKey(models[i].id)] === true
    var seen = {}
    for (var j = 0; j < models[i].entries.length; j++) {
      var entry = models[i].entries[j]
      if (!byKey[entry.key]) byKey[entry.key] = { key: entry.key, name: entry.name, version: entry.version, models: 0, mine: 0 }
      if (!seen[entry.key]) {
        seen[entry.key] = true
        byKey[entry.key].models++
        if (mine) byKey[entry.key].mine++
      }
    }
  }

  var all = []
  for (var key in byKey) {
    var list = byKey[key]
    list.label = list.version !== "" ? list.name + " " + list.version : list.name
    all.push(list)
  }
  function byLabel(a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0 }
  all.sort(function(a, b) { return b.models - a.models || byLabel(a, b) })

  var wide = all.filter(function(list) { return list.models >= MIN_MODELS })
  if (wide.length === 0) wide = all.filter(function(list) { return list.models >= 2 })
  var chosen = wide.slice(0, MAX_LISTS)

  var personal = all.filter(function(list) {
    return list.mine >= MIN_MINE && list.models >= MIN_MODELS_WITH_MINE && chosen.indexOf(list) < 0
  })
  personal.sort(function(a, b) { return b.mine - a.mine || b.models - a.models || byLabel(a, b) })
  chosen = chosen.concat(personal.slice(0, MAX_MINE_LISTS))

  chosen.sort(function(a, b) { return b.mine - a.mine || b.models - a.models || byLabel(a, b) })
  return chosen
}

function median(values) {
  var sorted = values.slice().sort(function(a, b) { return a - b })
  return sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]
}

// Which way a metric runs. The data has no field for it, so the few words
// that leave no doubt are read from the metric's name; every other metric is
// taken as more is better.
var LOWER_IS_BETTER = /\b(error|errors|distance|loss|perplexity)\b|\bhallucination rate\b/i

function lowerIsBetter(metric) {
  return LOWER_IS_BETTER.test(String(metric || ""))
}

// A model that reports one run (same harness, same settings) under two
// metrics with two scores has measured two things, not named one thing
// twice, and the two can't share an axis. One such run could be a slip in the
// data, so it takes this many before any result is left out.
var MIN_CLASH_RUNS = 2

// The metrics to leave out of a benchmark whose results measure two things,
// as lower-case names. Each metric takes the side opposite the ones it was
// reported against ("partial score" against "strict success rate", "mean
// partial score" against "binary completion rate"), the side with more
// results stays, and on a tie the one nearer the results that took no side.
function sideMetrics(rows) {
  var runs = Object.create(null)
  var counts = Object.create(null)
  for (var i = 0; i < rows.length; i++) {
    var metric = rows[i].metric.toLowerCase()
    if (metric === "") continue
    counts[metric] = (counts[metric] || 0) + 1
    var run = rows[i].id + "\n" + harnessKey(rows[i].harness) + "\n" + rows[i].variant.toLowerCase()
    if (!runs[run]) runs[run] = Object.create(null)
    if (!(metric in runs[run])) runs[run][metric] = rows[i].score
  }

  var against = Object.create(null)
  var clashes = 0
  for (var key in runs) {
    var names = Object.keys(runs[key])
    var clashed = false
    for (var a = 0; a < names.length; a++) {
      for (var b = a + 1; b < names.length; b++) {
        if (runs[key][names[a]] === runs[key][names[b]]) continue
        if (!against[names[a]]) against[names[a]] = Object.create(null)
        if (!against[names[b]]) against[names[b]] = Object.create(null)
        against[names[a]][names[b]] = true
        against[names[b]][names[a]] = true
        clashed = true
      }
    }
    if (clashed) clashes++
  }
  var out = Object.create(null)
  if (clashes < MIN_CLASH_RUNS) return out

  // The commonest metric takes the first side, and each one after it the
  // first side none of the metrics it was reported against has taken.
  var order = Object.keys(against).sort(function(x, y) { return counts[y] - counts[x] || (x < y ? -1 : 1) })
  var side = Object.create(null)
  var sides = []
  order.forEach(function(name) {
    var at = 0
    while (order.some(function(other) { return against[name][other] === true && side[other] === at })) at++
    side[name] = at
    if (!sides[at]) sides[at] = { count: 0, scores: [] }
    sides[at].count += counts[name]
  })

  var apart = []
  for (var j = 0; j < rows.length; j++) {
    var at = side[rows[j].metric.toLowerCase()]
    if (at === undefined) apart.push(rows[j].score)
    else sides[at].scores.push(rows[j].score)
  }
  var keep = 0
  for (var k = 1; k < sides.length; k++) {
    var closer = apart.length > 0 && Math.abs(median(sides[k].scores) - median(apart)) < Math.abs(median(sides[keep].scores) - median(apart))
    if (sides[k].count > sides[keep].count || (sides[k].count === sides[keep].count && closer)) keep = k
  }
  order.forEach(function(name) { if (side[name] !== keep) out[name] = true })
  return out
}

// Every score reported for one benchmark, best first. A model run in
// several harnesses or settings keeps a row for each, since those are
// different results and choosing one would be a ranking of our own. `used`
// (from parseUsed) marks the models this machine has used. Results that
// can't be sorted in with the rest are left out, because ranking them would
// be wrong: the odd score on another scale (a win rate among Elo ratings), a
// second metric the same runs were also reported under, and a metric that
// runs the other way from the benchmark's own. Each row's `lower` says
// whether less is better on this benchmark.
function rows(models, key, used) {
  var out = []
  for (var i = 0; i < models.length; i++) {
    // A model is yours when the agents panel has recorded it under the same
    // name; an alias such as "grok-latest" names no model and matches none.
    var mine = !!used && used[modelKey(models[i].id)] === true
    for (var j = 0; j < models[i].entries.length; j++) {
      var entry = models[i].entries[j]
      if (entry.key !== key) continue
      out.push({
        id: models[i].id,
        name: models[i].name,
        mine: mine,
        score: entry.score,
        metric: entry.metric,
        harness: entry.harness,
        variant: entry.variant,
        date: entry.date,
        // Where the result sits in time: when the model came out, or failing
        // that, when the score was reported.
        when: models[i].released || entry.date,
        source: entry.source
      })
    }
  }

  var large = median(out.map(function(row) { return row.score })) > 100
  out = out.filter(function(row) { return (row.score > 100) === large })

  var aside = sideMetrics(out)
  out = out.filter(function(row) { return aside[row.metric.toLowerCase()] !== true })

  var lower = out.filter(function(row) { return lowerIsBetter(row.metric) }).length * 2 > out.length
  out = out.filter(function(row) { return lowerIsBetter(row.metric) === lower })

  out.sort(function(a, b) { return (lower ? a.score - b.score : b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) })
  out = out.slice(0, MAX_ROWS)
  for (var k = 0; k < out.length; k++) {
    out[k].rank = k + 1
    out[k].decimals = large ? 0 : 1
    out[k].lower = lower
  }
  return out
}

// How old the data is, as the unit and count the panel's plural strings take.
function age(seconds) {
  var value = Math.max(0, Math.floor(Number(seconds) || 0))
  if (value < 3600) return { unit: "minutes", count: Math.floor(value / 60) }
  if (value < 172800) return { unit: "hours", count: Math.floor(value / 3600) }
  return { unit: "days", count: Math.floor(value / 86400) }
}

// ---- The graph ------------------------------------------------------------
//
// A benchmark's graph follows how the benchmark is built, read off its data
// rather than its name:
//
// - Where the harness is part of the result (an agent benchmark: the same
//   model scores differently in Claude Code and in Codex), every result is a
//   dot in its harness's own strip, since scores compare fairly only within
//   one harness.
// - Where a model has one score and the results reach back far enough, the
//   graph is score against release date, with a line along the best so far.
// - Otherwise it is the top results as plain columns, unless the scores are
//   ratings rather than shares of a whole (Elo, in the thousands): a column
//   measured from zero would make those all look alike, so each is a dot
//   over its name, on an axis that keeps to where the scores are.

var MAX_COLUMNS = 12
// A harness gets a strip of its own when at least this many results ran in
// it, and at most this many do; the rest share one strip, which is given up
// to this many times a named strip's width, since it is usually the fullest.
var MAX_STRIPS = 3
var MIN_STRIP_RESULTS = 3
var REST_MAX_WIDTH = 2
// Dots in one strip that would land on each other step sideways instead:
// how close counts as landing (of the value axis) and how far a step is (of
// the graph's width).
var DOT_CLEARANCE = 0.04
var DOT_STEP = 0.024
// The share of results that must name a harness for it to count as part of
// the benchmark, and the dated share and reach a history needs.
var HARNESS_SHARE = 0.4
var TIME_SHARE = 0.8
var TIME_MIN_DAYS = 180
var TIME_MIN_POINTS = 8
var MAX_TIME_TICKS = 5
var MAX_LABELS = 6
// The value axis is titled with the commonest metric, and with the next one
// too when the first is named by under this share of the results that name
// any.
var METRIC_SHARE = 2 / 3
var MAX_METRICS = 2
var NO_LETTER = /^[^a-z\u00c0-\uffff]*$/i

// "Terminus-2" and "Terminus 2" are one harness, and so are "Claude Code"
// and "Claude Code 2.1.207".
function harnessKey(harness) {
  return String(harness || "").replace(/\s+v?\d+(\.\d+)+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

// The harnesses enough results ran in to compare, most used first, or none
// when harness isn't part of this benchmark.
function harnessGroups(rows) {
  var byKey = {}
  var named = 0
  for (var i = 0; i < rows.length; i++) {
    var key = harnessKey(rows[i].harness)
    if (key === "") continue
    named++
    if (!byKey[key]) byKey[key] = { key: key, label: rows[i].harness.replace(/\s+v?\d+(\.\d+)+$/i, ""), count: 0 }
    byKey[key].count++
  }
  if (rows.length === 0 || named / rows.length < HARNESS_SHARE) return []
  var groups = []
  for (var k in byKey) if (byKey[k].count >= MIN_STRIP_RESULTS) groups.push(byKey[k])
  groups.sort(function(a, b) { return b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0) })
  return groups.slice(0, MAX_STRIPS)
}

function dayNumber(iso) {
  return Math.floor(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000)
}

function monthStart(year, month) {
  return Math.floor(Date.UTC(year, month, 1) / 86400000)
}

function niceStep(range, intervals) {
  var raw = range / intervals
  if (!(raw > 0) || !isFinite(raw)) return 1
  var magnitude = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10))
  var fraction = raw / magnitude
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10) * magnitude
}

// A value axis on round numbers. Columns are measured from zero; dots don't
// need a zero to be honest, so their axis keeps to where the scores are.
function valueAxis(low, high, fromZero) {
  var step = niceStep(Math.max(high - (fromZero ? 0 : low), 1e-9), 4)
  var min = fromZero ? 0 : Math.floor(low / step) * step
  var max = Math.ceil(high / step) * step
  if (max <= min) max = min + step
  var ticks = []
  for (var value = min; value <= max + step / 1000 && ticks.length < 12; value += step) ticks.push(Math.round(value * 1e6) / 1e6)
  return { min: min, max: max, ticks: ticks, decimals: step % 1 === 0 ? 0 : 1 }
}

// The top results side by side, each over its name: columns measured from
// zero, or with fromZero false, dots on an axis that keeps to the scores.
function columnsChart(rows, fromZero) {
  var shown = rows.slice(0, MAX_COLUMNS)
  var ends = [shown[0].score, shown[shown.length - 1].score]
  var axis = valueAxis(Math.min.apply(null, ends), Math.max.apply(null, ends), fromZero)
  var items = []
  var order = []
  for (var i = 0; i < shown.length; i++) {
    items.push({ row: i, x: (i + 0.5) / shown.length, y: (shown[i].score - axis.min) / (axis.max - axis.min), strip: -1, record: false })
    order.push(i)
  }
  return { form: "columns", dots: !fromZero, axis: axis, items: items, order: order, total: rows.length, strips: [], steps: [], xTicks: [] }
}

// A strip for each of the harnesses most results ran in, and one for the
// rest (named "" here; the panel words it). The best result of each strip is
// its record. A strip has a centre `x` and a width `w`, as shares of the
// graph's width.
function stripsChart(rows, groups) {
  var keys = groups.map(function(group) { return group.key })
  var scores = rows.map(function(row) { return row.score })
  var axis = valueAxis(Math.min.apply(null, scores), Math.max.apply(null, scores), false)

  var assigned = rows.map(function(row) { return keys.indexOf(harnessKey(row.harness)) })
  var restCount = assigned.filter(function(strip) { return strip < 0 }).length

  // Named strips are all one width; the rest's grows with how full it is.
  var weights = groups.map(function() { return 1 })
  if (restCount > 0) {
    var average = (rows.length - restCount) / groups.length
    weights.push(Math.max(1, Math.min(REST_MAX_WIDTH, restCount / average)))
  }
  var total = weights.reduce(function(sum, weight) { return sum + weight }, 0)
  var strips = []
  var left = 0
  for (var k = 0; k < weights.length; k++) {
    var w = weights[k] / total
    strips.push({ label: k < groups.length ? groups[k].label : "", x: left + w / 2, w: w })
    left += w
  }

  var placed = strips.map(function() { return [] })
  var items = []
  var order = []
  for (var i = 0; i < rows.length; i++) {
    var strip = assigned[i] < 0 ? strips.length - 1 : assigned[i]
    var y = (rows[i].score - axis.min) / (axis.max - axis.min)
    var taken = {}
    for (var j = 0; j < placed[strip].length; j++)
      if (Math.abs(placed[strip][j].y - y) < DOT_CLEARANCE) taken[placed[strip][j].slot] = true
    // Step out from the centre, one side then the other, as far as the strip
    // is wide; past that the dot overlaps at the centre.
    var reach = Math.max(0, Math.floor(strips[strip].w * 0.42 / DOT_STEP))
    var slot = 0
    for (var step = 0; step <= 2 * reach; step++) {
      var candidate = step === 0 ? 0 : (step % 2 === 1 ? (step + 1) / 2 : -step / 2)
      if (!taken[candidate]) { slot = candidate; break }
    }
    placed[strip].push({ y: y, slot: slot })
    items.push({ row: i, x: strips[strip].x + slot * DOT_STEP, y: y, strip: strip, record: placed[strip].length === 1 })
    order.push(i)
  }
  return { form: "strips", axis: axis, items: items, order: order, total: rows.length, strips: strips, steps: [], xTicks: [] }
}

function timeChart(rows, dated) {
  var days = dated.map(function(index) { return dayNumber(rows[index].when) })
  var first = Math.min.apply(null, days)
  var last = Math.max.apply(null, days)
  var firstDate = new Date(first * 86400000)
  var lastDate = new Date(last * 86400000)
  var start = monthStart(firstDate.getUTCFullYear(), firstDate.getUTCMonth())
  var end = monthStart(lastDate.getUTCFullYear(), lastDate.getUTCMonth() + 1)

  var scores = dated.map(function(index) { return rows[index].score })
  var axis = valueAxis(Math.min.apply(null, scores), Math.max.apply(null, scores), false)

  // The best score so far, walking forward in time: the highest, or the
  // lowest on a benchmark where less is better.
  var lower = rows[0].lower === true
  var byTime = dated.map(function(index, position) { return { row: index, day: days[position], score: rows[index].score } })
  byTime.sort(function(a, b) { return a.day - b.day || (lower ? a.score - b.score : b.score - a.score) })
  var best = lower ? Infinity : -Infinity
  var records = {}
  var steps = []
  for (var i = 0; i < byTime.length; i++) {
    if (lower ? byTime[i].score >= best : byTime[i].score <= best) continue
    best = byTime[i].score
    records[byTime[i].row] = true
    steps.push({ row: byTime[i].row, x: (byTime[i].day - start) / (end - start), y: (best - axis.min) / (axis.max - axis.min) })
  }

  var items = []
  for (var j = 0; j < dated.length; j++) {
    items.push({
      row: dated[j],
      x: (days[j] - start) / (end - start),
      y: (rows[dated[j]].score - axis.min) / (axis.max - axis.min),
      strip: -1,
      record: records[dated[j]] === true
    })
  }

  // Month ticks, thinned until they fit.
  var startMonth = firstDate.getUTCFullYear() * 12 + firstDate.getUTCMonth()
  var months = lastDate.getUTCFullYear() * 12 + lastDate.getUTCMonth() + 1 - startMonth
  var every = [1, 2, 3, 4, 6, 12, 24, 60].filter(function(n) { return months / n <= MAX_TIME_TICKS })[0] || 120
  var xTicks = []
  for (var month = Math.ceil(startMonth / every) * every; month < startMonth + months; month += every) {
    var tickDay = monthStart(Math.floor(month / 12), month % 12)
    xTicks.push({ x: (tickDay - start) / (end - start), year: Math.floor(month / 12), month: month % 12 })
  }

  return {
    form: "time", axis: axis, items: items, order: dated, total: rows.length,
    strips: [], steps: steps, xTicks: xTicks
  }
}

// What the scores are, in the words their sources use: the metric most of the
// results name, and a second one when the first covers too few of them. A
// benchmark's results rarely agree on the wording ("resolved", "resolve
// rate", "pass@1") and no list of metrics is kept here to merge them. "score"
// says nothing the axis doesn't already, so it counts as naming none.
function metricNames(rows) {
  var byKey = Object.create(null)
  var named = 0
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i].metric || "").toLowerCase()
    // A metric given only as a sign ("%") names nothing either.
    if (key === "" || key === "score" || NO_LETTER.test(key)) continue
    named++
    if (!byKey[key]) byKey[key] = { name: rows[i].metric, count: 0 }
    byKey[key].count++
  }
  var metrics = []
  for (var k in byKey) metrics.push(byKey[k])
  metrics.sort(function(a, b) { return b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) })
  var names = []
  var covered = 0
  for (var j = 0; j < metrics.length && names.length < MAX_METRICS; j++) {
    names.push(metrics[j].name)
    covered += metrics[j].count
    if (covered / named >= METRIC_SHARE) break
  }
  return names
}

function shapedChart(rows) {
  var groups = harnessGroups(rows)
  if (groups.length > 0) return stripsChart(rows, groups)

  var dated = []
  for (var i = 0; i < rows.length; i++) if (rows[i].when !== "") dated.push(i)
  if (dated.length >= TIME_MIN_POINTS && dated.length / rows.length >= TIME_SHARE) {
    var days = dated.map(function(index) { return dayNumber(rows[index].when) })
    if (Math.max.apply(null, days) - Math.min.apply(null, days) >= TIME_MIN_DAYS) return timeChart(rows, dated)
  }
  return columnsChart(rows, Math.max(rows[0].score, rows[rows.length - 1].score) <= 100)
}

// The graph for one benchmark's rows, with `metrics` naming what the results
// drawn on it measure and `lower` saying whether less is better.
function chart(rows) {
  if (!rows || rows.length === 0) return { form: "", axis: null, items: [], order: [], total: 0, strips: [], steps: [], xTicks: [], metrics: [], lower: false }

  var spec = shapedChart(rows)
  spec.metrics = metricNames(spec.order.map(function(index) { return rows[index] }))
  spec.lower = rows[0].lower === true
  return spec
}

// Names on the time graph: the models you use first, best first, then the
// record setters, newest first. Each goes up and to the left of its dot. A
// name that would run off the graph, onto another name, or under the line is
// left off; the line under the graph names any dot. A model with several
// results is named once, at its best. Sizes are in pixels; charWidth is the
// monospace advance of the label font.
function pointLabels(spec, rows, width, height, charWidth, lineHeight) {
  var placed = []
  if (!spec || spec.form !== "time" || !(width > 0) || !(height > 0)) return placed

  var candidates = []
  var named = {}
  function offer(row, x, y) {
    if (!rows[row] || named[rows[row].id]) return
    named[rows[row].id] = true
    candidates.push({ row: row, x: x * width, y: (1 - y) * height })
  }
  var mine = spec.items.filter(function(item) { return rows[item.row] && rows[item.row].mine })
  mine.sort(function(a, b) { return a.row - b.row })
  for (var m = 0; m < mine.length; m++) offer(mine[m].row, mine[m].x, mine[m].y)
  for (var r = spec.steps.length - 1; r >= 0; r--) offer(spec.steps[r].row, spec.steps[r].x, spec.steps[r].y)

  // The line, as the rectangles it is drawn from: a run to the right of each
  // record, and a riser up to the next.
  var line = []
  for (var s = 0; s < spec.steps.length; s++) {
    var fromX = spec.steps[s].x * width
    var runY = (1 - spec.steps[s].y) * height
    var next = spec.steps[s + 1]
    var toX = next ? next.x * width : width
    line.push({ x: fromX, y: runY - 1, w: toX - fromX, h: 2 })
    if (next) line.push({ x: toX - 1, y: (1 - next.y) * height, w: 2, h: runY - (1 - next.y) * height })
  }

  function overlaps(a, b, margin) {
    return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin
  }

  for (var i = 0; i < candidates.length && placed.length < MAX_LABELS; i++) {
    var text = rows[candidates[i].row].name
    if (text.length > 18) text = text.slice(0, 17) + "…"
    var box = { x: candidates[i].x - 6 - text.length * charWidth, y: candidates[i].y - lineHeight - 3, w: text.length * charWidth, h: lineHeight }
    if (box.x < 0 || box.y < -lineHeight) continue
    var clear = true
    for (var j = 0; j < placed.length && clear; j++) if (overlaps(box, placed[j], 3)) clear = false
    for (var l = 0; l < line.length && clear; l++) if (overlaps(box, line[l], 1)) clear = false
    if (clear) placed.push({ row: candidates[i].row, text: text, x: box.x, y: box.y, w: box.w, h: box.h, mine: rows[candidates[i].row].mine === true })
  }
  return placed
}

if (typeof module !== "undefined") {
  module.exports = {
    SOURCE_URL: SOURCE_URL,
    MAX_AGE_SECONDS: MAX_AGE_SECONDS,
    MAX_LISTS: MAX_LISTS,
    MAX_ROWS: MAX_ROWS,
    MIN_MODELS: MIN_MODELS,
    FETCH_SCRIPT: FETCH_SCRIPT,
    fetchCommand: fetchCommand,
    cleanText: cleanText,
    safeUrl: safeUrl,
    urlHost: urlHost,
    normalizeVersion: normalizeVersion,
    parse: parse,
    lists: lists,
    rows: rows,
    MAX_COLUMNS: MAX_COLUMNS,
    harnessKey: harnessKey,
    harnessGroups: harnessGroups,
    valueAxis: valueAxis,
    chart: chart,
    pointLabels: pointLabels,
    modelKey: modelKey,
    parseUsed: parseUsed,
    USED_SCRIPT: USED_SCRIPT,
    usedCommand: usedCommand,
    age: age
  }
}
