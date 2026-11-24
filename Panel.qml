import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Model benchmark scores, one benchmark at a time. The data is models.dev's;
// this panel only fetches, checks and shows it (see Model.js). Nothing runs
// while the panel is closed: the fetch starts when it opens, and only when
// the cached copy is more than a day old.
Panel {
  id: root
  moduleName: "yamz8.benchmarks"
  ipcTarget: "yamz8.benchmarks"

  property var models: []
  // The models this machine has used, by Model.modelKey; read from the agents
  // panel's records each time the panel opens.
  property var used: ({})
  // Which benchmarks come first depends on `used`, so nothing is listed
  // until it has been read once; otherwise the first open would show one
  // benchmark and then jump to another.
  property bool usedReady: false
  property double fetchedAt: 0
  property bool fetchError: false
  property bool loadFailed: false
  property bool loading: false
  property double nowMs: Date.now()

  // The benchmark on show, kept by key so a refresh that reorders the lists
  // leaves the same one up.
  property string selectedKey: ""
  property int selectedIndex: 0
  property bool cursorActive: false

  // The panel opens on the graph, whose form Model.chart picks for each
  // benchmark. V (or the hero's button) switches to the list for the
  // session; the widget's View setting makes that the default.
  property string viewOverride: ""
  readonly property bool graphView: (viewOverride !== "" ? viewOverride : String(setting("view", "Graph"))).toLowerCase() !== "list"

  // A host that stands in for the bar (omarchy agent look plugin) has no colors of its own.
  readonly property color foreground: bar && bar.foreground !== undefined ? bar.foreground : Commons.Color.foreground
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar && bar.fontFamily ? bar.fontFamily : Style.font.family

  readonly property var lists: usedReady ? Model.lists(models, used) : []
  readonly property int listIndex: {
    for (var i = 0; i < lists.length; i++) if (lists[i].key === selectedKey) return i
    return 0
  }
  readonly property var currentList: lists.length > 0 ? lists[listIndex] : null
  readonly property var rows: currentList ? Model.rows(models, currentList.key, used) : []
  // How many of the models you use have a score on this benchmark.
  readonly property int mineCount: {
    var seen = {}
    var count = 0
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].mine || seen[rows[i].id]) continue
      seen[rows[i].id] = true
      count++
    }
    return count
  }

  readonly property var chart: Model.chart(rows)
  readonly property bool chartShown: graphView && chart.form !== ""

  // Under the graph: how to read it, or, with a result under the cursor,
  // which one it is and what its score was reported with.
  readonly property string footerText: {
    if (chart.form === "") return ""
    if (cursorActive && selectedIndex < rows.length) {
      var row = rows[selectedIndex]
      var parts = [row.name, Commons.I18n.formatNumber(row.score, row.decimals)]
      var summary = rowSummary(row)
      if (summary !== "") parts.push(summary)
      return parts.join(" · ")
    }
    if (chart.form === "time") return strings.t("chart.time")
    if (chart.form === "strips") return strings.t("chart.strips")
    if (chart.items.length >= chart.total) return strings.tn("chart.all", chart.total).arg(Commons.I18n.formatNumber(chart.total))
    return strings.t("chart.columns").arg(Commons.I18n.formatNumber(chart.items.length)).arg(Commons.I18n.formatNumber(chart.total))
  }

  readonly property string ageText: {
    var age = Model.age(nowMs / 1000 - fetchedAt)
    if (age.unit === "minutes" && age.count < 1) return strings.t("age.now")
    return strings.tn("age." + age.unit, age.count).arg(Commons.I18n.formatNumber(age.count))
  }
  readonly property string statusText: {
    if (loading || !usedReady) return strings.t("status.loading").arg(Model.SOURCE_NAME)
    if (models.length === 0) return loadFailed || fetchError ? strings.t("status.failed") : ""
    return strings.t(fetchError ? "status.saved" : "status.updated").arg(Model.SOURCE_NAME).arg(ageText)
  }

  Commons.Translations { id: strings; directory: Qt.resolvedUrl("i18n") }

  function load(force) {
    if (fetchProc.running) return
    loading = true
    loadFailed = false
    fetchProc.command = Model.fetchCommand(force)
    fetchProc.running = true
  }

  function loadIfStale() {
    if (models.length === 0 || Date.now() / 1000 - fetchedAt >= Model.MAX_AGE_SECONDS) load(false)
  }

  function applyResponse(text) {
    var result = Model.parse(text)
    loading = false
    if (!result.ok) {
      loadFailed = true
      return
    }
    fetchError = result.fetchError
    // A refresh that came back empty keeps what was already on show.
    if (result.models.length > 0 || models.length === 0) {
      models = result.models
      fetchedAt = result.fetchedAt
    }
    nowMs = Date.now()
  }

  function resetView() {
    selectedIndex = 0
    cursorActive = false
    pointerGate.reset()
    if (listFlick) listFlick.contentY = 0
  }

  function toggleView() {
    viewOverride = graphView ? "list" : "graph"
    // A graph shows only some of the results; a cursor on one it leaves out
    // would point at nothing.
    if (chartShown && chart.order.indexOf(selectedIndex) < 0) cursorActive = false
    if (cursorActive) scrollSelectionIntoView()
    else if (listFlick) listFlick.contentY = 0
  }

  function cycleList(delta) {
    if (lists.length < 2) return
    selectedKey = lists[(listIndex + delta + lists.length) % lists.length].key
    resetView()
  }

  function select(index) {
    cursorActive = true
    selectedIndex = Math.max(0, Math.min(rows.length - 1, index))
    scrollSelectionIntoView()
  }

  function moveSelection(delta) {
    if (rows.length === 0) return
    if (chartShown) {
      // On a graph the cursor steps through the results it shows, best first.
      var order = chart.order
      if (order.length === 0) return
      var at = cursorActive ? order.indexOf(selectedIndex) : -1
      selectedIndex = order[at < 0 ? 0 : Math.max(0, Math.min(order.length - 1, at + delta))]
      cursorActive = true
    } else if (cursorActive) {
      select(selectedIndex + delta)
    } else {
      select(0)
    }
  }

  // M steps the cursor through the models you use, best first, and around.
  function selectNextMine() {
    var order = chartShown ? chart.order : rows.map(function(row, index) { return index })
    var mine = order.filter(function(index) { return rows[index].mine })
    if (mine.length === 0) return
    var at = cursorActive ? mine.indexOf(selectedIndex) : -1
    var next = mine[(at + 1) % mine.length]
    if (chartShown) selectFromChart(next)
    else select(next)
  }

  function selectFromChart(row) {
    cursorActive = true
    selectedIndex = row
  }

  // The source is opened as an argument to the browser launcher, never
  // through a shell, and Model.safeUrl has already held it to plain https.
  function openSource(row) {
    if (!row || row.source === "") return
    Quickshell.execDetached(["omarchy-launch-browser", row.source])
    close()
  }

  function activateSelection() {
    if (cursorActive && rows.length > 0) openSource(rows[selectedIndex])
  }

  function scrollSelectionIntoView() {
    if (!rowColumn || selectedIndex < 0 || selectedIndex >= rowColumn.children.length) return
    var wrapper = rowColumn.children[selectedIndex]
    Qt.callLater(function() {
      if (!wrapper || !listFlick) return
      var point = wrapper.mapToItem(listFlick.contentItem, 0, 0)
      var margin = Style.space(8)
      var top = point.y
      var bottom = top + wrapper.height
      var maxY = Math.max(0, listFlick.contentHeight - listFlick.height)
      if (top < listFlick.contentY + margin) listFlick.contentY = Math.max(0, top - margin)
      else if (bottom > listFlick.contentY + listFlick.height - margin) listFlick.contentY = Math.min(maxY, bottom + margin - listFlick.height)
    })
  }

  function rowDetail(row) {
    var parts = []
    if (row.harness !== "") parts.push(row.harness)
    if (row.variant !== "") parts.push(row.variant)
    if (row.date !== "") {
      var bits = row.date.split("-")
      parts.push(new Date(Number(bits[0]), Number(bits[1]) - 1, Number(bits[2])).toLocaleDateString(Qt.locale(Commons.I18n.formatLocale), Locale.ShortFormat))
    }
    return parts.length > 0 ? parts.join(" · ") : row.metric
  }

  // The details and where the score came from, which is where Enter or a
  // click goes.
  function rowSummary(row) {
    var detail = rowDetail(row)
    var host = Model.urlHost(row.source)
    return detail !== "" && host !== "" ? detail + " · " + host : detail + host
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    if (!opened) return
    nowMs = Date.now()
    resetView()
    loadIfStale()
    if (!usedProc.running) {
      usedProc.command = Model.usedCommand()
      usedProc.running = true
    }
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  onRowsChanged: selectedIndex = Math.max(0, Math.min(rows.length - 1, selectedIndex))

  PointerMoveGate {
    id: pointerGate
    referenceItem: listFlick
  }

  Process {
    id: fetchProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyResponse(text)
    }
    onExited: function(exitCode) {
      if (exitCode === 0) return
      root.loading = false
      root.loadFailed = true
    }
  }

  Process {
    id: usedProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.used = Model.parseUsed(text)
        root.usedReady = true
      }
    }
    // Without the records the panel still works; it just marks nothing.
    onExited: function(exitCode) { if (exitCode !== 0) root.usedReady = true }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰴥"
    tooltipText: strings.t("tooltip")
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.MiddleButton) root.load(true)
      else if (buttonCode === Qt.LeftButton) root.toggle()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(fixedContent.implicitHeight + (root.chartShown ? chartView.implicitHeight : listContent.implicitHeight) + Style.space(12) + (footer.visible ? footer.implicitHeight + Style.space(12) : 0), Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.cycleList(dx)
        else if (dy !== 0) root.moveSelection(dy)
      }
      onActivateRequested: root.activateSelection()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r" || text === "R") root.load(true)
        else if (text === "v" || text === "V") root.toggleView()
        else if (text === "m" || text === "M") root.selectNextMine()
      }

      ColumnLayout {
        anchors.fill: parent
        spacing: Style.space(12)

        Column {
          id: fixedContent
          Layout.fillWidth: true
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: strings.t("title")
            meta: root.statusText
            foreground: root.foreground
            fontFamily: root.fontFamily

            iconComponent: Component {
              Text {
                textFormat: Text.PlainText
                text: "󰴥"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }

            trailingControl: Component {
              Row {
                spacing: Style.space(6)

                HeroButton {
                  glyph: root.graphView ? "󰉻" : "󰄨"
                  tooltip: root.graphView ? strings.t("view.list") : strings.t("view.graph")
                  fontFamily: root.fontFamily
                  onClicked: root.toggleView()
                }

                HeroButton {
                  glyph: "󰑐"
                  tooltip: strings.t("refresh")
                  fontFamily: root.fontFamily
                  opacity: root.loading ? 0.4 : 1
                  onClicked: root.load(true)
                }
              }
            }
          }

          PanelSeparator {
            foreground: root.foreground
          }

          // Which benchmark is on show. Left and Right step through them.
          Item {
            visible: root.currentList !== null
            width: parent.width
            implicitHeight: Math.max(previousButton.implicitHeight, listLabels.implicitHeight)

            HeroButton {
              id: previousButton
              visible: root.lists.length > 1
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              glyph: Commons.I18n.rightToLeft ? "󰅂" : "󰅁"
              tooltip: strings.t("previous")
              fontFamily: root.fontFamily
              onClicked: root.cycleList(-1)
            }

            Column {
              id: listLabels
              anchors.left: previousButton.right
              anchors.right: nextButton.left
              anchors.leftMargin: Style.space(10)
              anchors.rightMargin: Style.space(10)
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.space(2)

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: root.currentList ? root.currentList.label : ""
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.subtitle
                font.bold: true
                horizontalAlignment: Text.AlignHCenter
                elide: Text.ElideRight
              }

              Text {
                textFormat: Text.PlainText
                width: parent.width
                text: root.currentList
                  ? strings.tn("list.models", root.currentList.models).arg(Commons.I18n.formatNumber(root.currentList.models))
                    + " · " + strings.t("list.position").arg(Commons.I18n.formatNumber(root.listIndex + 1)).arg(Commons.I18n.formatNumber(root.lists.length))
                    + (root.mineCount > 0 ? " · " + strings.tn("list.mine", root.mineCount).arg(Commons.I18n.formatNumber(root.mineCount)) : "")
                  : ""
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                horizontalAlignment: Text.AlignHCenter
                elide: Text.ElideRight
              }
            }

            HeroButton {
              id: nextButton
              visible: root.lists.length > 1
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              glyph: Commons.I18n.rightToLeft ? "󰅁" : "󰅂"
              tooltip: strings.t("next")
              fontFamily: root.fontFamily
              onClicked: root.cycleList(1)
            }
          }
        }

        Chart {
          id: chartView
          visible: root.chartShown
          Layout.fillWidth: true
          Layout.preferredHeight: implicitHeight
          spec: root.chart
          rows: root.rows
          selectedRow: root.cursorActive ? root.selectedIndex : -1
          foreground: root.foreground
          dim: root.dim
          fontFamily: root.fontFamily
          otherLabel: strings.t("group.other")
          onPicked: function(row) { root.selectFromChart(row) }
          onActivated: function(row) { root.openSource(root.rows[row]) }
        }

        Flickable {
          id: listFlick
          visible: !root.chartShown
          Layout.fillWidth: true
          Layout.fillHeight: true
          contentWidth: width
          contentHeight: listContent.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          flickableDirection: Flickable.VerticalFlick
          interactive: contentHeight > height
          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          Column {
            id: listContent
            width: listFlick.width

            Text {
              textFormat: Text.PlainText
              visible: root.rows.length === 0
              width: parent.width
              text: root.loading || !root.usedReady ? strings.t("empty.loading") : strings.t("empty.failed")
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              horizontalAlignment: Text.AlignHCenter
              wrapMode: Text.Wrap
              topPadding: Style.space(16)
              bottomPadding: Style.space(18)
            }

            Column {
              id: rowColumn
              visible: root.rows.length > 0
              width: parent.width
              spacing: Style.space(2)

              Repeater {
                // Built only while the list is on show.
                model: root.chartShown ? [] : root.rows

                CursorSurface {
                  id: scoreRow
                  required property var modelData
                  required property int index
                  readonly property string detail: root.rowSummary(modelData)
                  width: rowColumn.width
                  foreground: root.foreground
                  hasCursor: root.cursorActive && root.selectedIndex === index
                  implicitHeight: rowContent.implicitHeight + Style.space(12)

                  MouseArea {
                    id: rowMouse
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: scoreRow.modelData.source !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onPositionChanged: function(mouse) {
                      if (pointerGate.moved(scoreRow, mouse)) root.select(scoreRow.index)
                    }
                    onClicked: root.openSource(scoreRow.modelData)
                  }

                  RowLayout {
                    id: rowContent
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.leftMargin: Style.space(10)
                    anchors.rightMargin: Style.space(10)
                    spacing: Style.space(10)

                    Text {
                      textFormat: Text.PlainText
                      Layout.preferredWidth: Style.space(26)
                      text: Commons.I18n.formatNumber(scoreRow.modelData.rank)
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      horizontalAlignment: Text.AlignRight
                    }

                    ColumnLayout {
                      Layout.fillWidth: true
                      spacing: Style.space(1)

                      Text {
                        textFormat: Text.PlainText
                        Layout.fillWidth: true
                        // The same diamond the graph draws for a model you use.
                        text: (scoreRow.modelData.mine ? "\u25c6 " : "") + scoreRow.modelData.name
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                        elide: Text.ElideRight
                      }

                      Text {
                        textFormat: Text.PlainText
                        visible: scoreRow.detail !== ""
                        Layout.fillWidth: true
                        text: scoreRow.detail
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                      }
                    }

                    Text {
                      textFormat: Text.PlainText
                      text: Commons.I18n.formatNumber(scoreRow.modelData.score, scoreRow.modelData.decimals)
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      font.bold: true
                    }
                  }
                }
              }
            }
          }
        }

        Text {
          id: footer
          textFormat: Text.PlainText
          visible: root.chartShown
          Layout.fillWidth: true
          text: root.footerText
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
          elide: Text.ElideRight
        }
      }
    }
  }
}
