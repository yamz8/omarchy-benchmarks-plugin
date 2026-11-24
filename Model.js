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

// Every score reported for one benchmark, highest first. A model run in
// several harnesses or settings keeps a row for each, since those are
// different results and choosing one would be a ranking of our own. `used`
// (from parseUsed) marks the models this machine has used. The odd
// score on another scale (a win rate among Elo ratings) is left out, because
// sorting it in would be wrong.
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
  out.sort(function(a, b) { return b.score - a.score || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) })
  out = out.slice(0, MAX_ROWS)
  for (var k = 0; k < out.length; k++) {
    out[k].rank = k + 1
    out[k].decimals = large ? 0 : 1
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
//   measured from zero would make those all look alike, so they are dots on
//   an axis that keeps to where the scores are.

var MAX_COLUMNS = 12
var MAX_STRIPS = 4
// Dots in one strip that would land on each other step sideways instead:
// how close counts as landing (of the value axis) and how far a step is (of
// the strip's width).
var DOT_CLEARANCE = 0.04
var DOT_STEP = 0.11
// The share of results that must name a harness for it to count as part of
// the benchmark, and the dated share and reach a history needs.
var HARNESS_SHARE = 0.4
var TIME_SHARE = 0.8
var TIME_MIN_DAYS = 180
var TIME_MIN_POINTS = 8
var MAX_TIME_TICKS = 5
var MAX_LABELS = 6

// "Terminus-2" and "Terminus 2" are one harness, and so are "Claude Code"
// and "Claude Code 2.1.207".
function harnessKey(harness) {
  return String(harness || "").replace(/\s+v?\d+(\.\d+)+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "")
}

// The harnesses most results ran in, or none when harness isn't part of
// this benchmark.
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
  for (var k in byKey) groups.push(byKey[k])
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

function columnsChart(rows) {
  var shown = rows.slice(0, MAX_COLUMNS)
  var axis = valueAxis(0, shown.length > 0 ? shown[0].score : 0, true)
  var items = []
  var order = []
  for (var i = 0; i < shown.length; i++) {
    items.push({ row: i, x: (i + 0.5) / shown.length, y: shown[i].score / axis.max, strip: -1, record: false })
    order.push(i)
  }
  return { form: "columns", axis: axis, items: items, order: order, total: rows.length, strips: [], steps: [], xTicks: [] }
}

// A strip for each of the harnesses most results ran in, and one for the
// rest (named "" here; the panel words it). The best result of each strip is
// its record.
function stripsChart(rows, groups) {
  var keys = groups.map(function(group) { return group.key })
  var scores = rows.map(function(row) { return row.score })
  var axis = valueAxis(Math.min.apply(null, scores), Math.max.apply(null, scores), false)

  var assigned = rows.map(function(row) { return keys.indexOf(harnessKey(row.harness)) })
  var rest = assigned.some(function(strip) { return strip < 0 })
  var count = groups.length + (rest ? 1 : 0)
  var strips = groups.map(function(group, index) { return { label: group.label, x: (index + 0.5) / count } })
  if (rest) strips.push({ label: "", x: (count - 0.5) / count })

  var placed = strips.map(function() { return [] })
  var slots = [0, 1, -1, 2, -2, 3, -3]
  var items = []
  var order = []
  for (var i = 0; i < rows.length; i++) {
    var strip = assigned[i] < 0 ? count - 1 : assigned[i]
    var y = (rows[i].score - axis.min) / (axis.max - axis.min)
    var taken = {}
    for (var j = 0; j < placed[strip].length; j++)
      if (Math.abs(placed[strip][j].y - y) < DOT_CLEARANCE) taken[placed[strip][j].slot] = true
    var free = slots.filter(function(slot) { return !taken[slot] })
    var slot = free.length > 0 ? free[0] : 0
    placed[strip].push({ y: y, slot: slot })
    items.push({ row: i, x: strips[strip].x + slot * DOT_STEP / count, y: y, strip: strip, record: placed[strip].length === 1 })
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

  // The best score so far, walking forward in time.
  var byTime = dated.map(function(index, position) { return { row: index, day: days[position], score: rows[index].score } })
  byTime.sort(function(a, b) { return a.day - b.day || b.score - a.score })
  var best = -Infinity
  var records = {}
  var steps = []
  for (var i = 0; i < byTime.length; i++) {
    if (byTime[i].score <= best) continue
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

function chart(rows) {
  if (!rows || rows.length === 0) return { form: "", axis: null, items: [], order: [], total: 0, strips: [], steps: [], xTicks: [] }

  var groups = harnessGroups(rows)
  if (groups.length > 0) return stripsChart(rows, groups)

  var dated = []
  for (var i = 0; i < rows.length; i++) if (rows[i].when !== "") dated.push(i)
  if (dated.length >= TIME_MIN_POINTS && dated.length / rows.length >= TIME_SHARE) {
    var days = dated.map(function(index) { return dayNumber(rows[index].when) })
    if (Math.max.apply(null, days) - Math.min.apply(null, days) >= TIME_MIN_DAYS) return timeChart(rows, dated)
  }
  if (rows[0].score > 100) return stripsChart(rows, [])
  return columnsChart(rows)
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
