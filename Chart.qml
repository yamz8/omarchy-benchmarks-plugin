import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// One benchmark as a graph. Model.chart decides the form from how the
// benchmark is built and hands over positions between 0 and 1; this only
// draws them: score against release date with a line along the best so far,
// a strip of dots for each harness on an agent benchmark, or columns for the
// top results. The panel owns the selection, so the keyboard, the pointer
// and the line under the graph agree on which result is meant.
Item {
  id: root

  property var spec: null
  property var rows: []
  property int selectedRow: -1
  property color foreground: Commons.Color.foreground
  property color dim: Qt.darker(foreground, 1.55)
  property string fontFamily: Style.font.family
  property string otherLabel: ""

  signal picked(int row)
  signal activated(int row)

  readonly property bool columns: spec !== null && spec.form === "columns"
  readonly property bool time: spec !== null && spec.form === "time"
  readonly property bool strips: spec !== null && spec.form === "strips"
  readonly property bool dotted: time || strips
  readonly property var axis: spec ? spec.axis : null

  readonly property color surface: Commons.Color.popups.background

  // The spec and the rows arrive as two bindings, so for a moment a spec can
  // point past the rows it came with.
  readonly property var noRow: ({ name: "", score: 0, decimals: 0, source: "", mine: false })
  function rowAt(index) {
    return rows && rows[index] ? rows[index] : noRow
  }

  // A graph reads left to right in every language.
  LayoutMirroring.enabled: false
  LayoutMirroring.childrenInherit: true

  implicitHeight: Style.space(300)

  TextMetrics {
    id: glyph
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    text: "0"
  }

  readonly property real lineHeight: glyph.height
  readonly property real gutter: {
    var widest = 1
    if (axis) for (var i = 0; i < axis.ticks.length; i++) widest = Math.max(widest, Commons.I18n.formatNumber(axis.ticks[i], axis.decimals).length)
    return Math.ceil(widest * glyph.advanceWidth) + Style.space(8)
  }
  // With a few wide columns a name sits flat under its column, on up to two
  // lines. With many it is slanted steeply, which keeps it long enough to
  // show the version at its end without the first one running off the left
  // edge.
  readonly property bool slanted: columns && plotWidth / Math.max(1, spec.items.length) < Style.space(70)
  readonly property real nameLength: Style.space(108)
  readonly property real plotX: gutter
  readonly property real plotY: (strips ? 2 : 1) * lineHeight + Style.space(4)
  readonly property real plotWidth: Math.max(1, width - gutter - Style.space(6))
  readonly property real plotHeight: Math.max(1, height - plotY - (columns && slanted ? nameLength * 0.87 + lineHeight / 2 : (columns || strips ? 2 : 1) * lineHeight + Style.space(8)))

  // A model you use is drawn larger than the rest as well as in another
  // shape and color: in a theme whose accent is close to its text color,
  // size and shape are what tell it apart.
  readonly property real dotSize: Style.space(8)
  readonly property real mineSize: Style.space(10)

  function valueY(fraction) {
    return plotY + plotHeight * (1 - fraction)
  }

  // ---- Value axis: quiet gridlines on round numbers.
  Repeater {
    model: root.axis ? root.axis.ticks : []

    Item {
      required property real modelData
      readonly property real lineY: Math.round(root.valueY((modelData - root.axis.min) / (root.axis.max - root.axis.min)))

      Rectangle {
        x: root.plotX
        y: parent.lineY
        width: root.plotWidth
        height: 1
        color: Util.alpha(root.foreground, 0.12)
      }

      Text {
        textFormat: Text.PlainText
        x: 0
        y: parent.lineY - height / 2
        width: root.gutter - Style.space(6)
        text: Commons.I18n.formatNumber(modelData, root.axis.decimals)
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignRight
      }
    }
  }

  // ---- Time axis.
  Repeater {
    model: root.time ? root.spec.xTicks : []

    Text {
      required property var modelData
      textFormat: Text.PlainText
      x: root.plotX + modelData.x * root.plotWidth - width / 2
      y: root.plotY + root.plotHeight + Style.space(5)
      text: new Date(modelData.year, modelData.month, 1).toLocaleDateString(Qt.locale(Commons.I18n.formatLocale), "MMM yy")
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  // ---- Strips: one per harness, named along the bottom, with a faint rule
  // between neighbours.
  Repeater {
    model: root.strips ? root.spec.strips : []

    Item {
      required property var modelData
      required property int index
      readonly property real slot: root.plotWidth / root.spec.strips.length

      Rectangle {
        visible: index > 0
        x: Math.round(root.plotX + index * parent.slot)
        y: root.plotY
        width: 1
        height: root.plotHeight
        color: Util.alpha(root.foreground, 0.08)
      }

      Text {
        textFormat: Text.PlainText
        x: root.plotX + index * parent.slot + Style.space(2)
        y: root.plotY + root.plotHeight + Style.space(5)
        width: parent.slot - Style.space(4)
        text: modelData.label !== "" ? modelData.label : root.otherLabel
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        horizontalAlignment: Text.AlignHCenter
        // A strip is narrow, so a long name takes a second line before it is cut.
        wrapMode: Text.Wrap
        maximumLineCount: 2
        elide: Text.ElideRight
      }
    }
  }

  // ---- Columns: the top results, tallest first.
  Repeater {
    model: root.columns ? root.spec.items : []

    Item {
      id: column
      required property var modelData
      readonly property var row: root.rowAt(modelData.row)
      readonly property bool selected: root.selectedRow === modelData.row
      readonly property real slot: root.plotWidth / root.spec.items.length
      // Ratings are a dot at the score rather than a column from zero.
      readonly property bool asDot: root.spec.dots === true
      readonly property real barHeight: asDot ? modelData.y * root.plotHeight : Math.max(Style.space(2), modelData.y * root.plotHeight)

      x: root.plotX + modelData.x * root.plotWidth - slot / 2
      y: 0
      width: slot
      height: root.height

      // The cursor: a band behind the whole column, as rows have in the list.
      Rectangle {
        visible: column.selected
        x: 1
        y: root.plotY - root.lineHeight - Style.space(2)
        width: parent.width - 2
        height: root.plotHeight + root.lineHeight + Style.space(2)
        radius: Style.cornerRadius
        color: Style.hoverFillFor(root.foreground, Commons.Color.accent)
      }

      Rectangle {
        visible: column.asDot
        x: parent.width / 2 - width / 2
        y: root.plotY + root.plotHeight - column.barHeight - height / 2
        width: column.row.mine ? root.mineSize : root.dotSize
        height: width
        radius: column.row.mine ? 1 : width / 2
        rotation: column.row.mine ? 45 : 0
        color: column.row.mine ? root.foreground : Commons.Color.accent
      }

      Rectangle {
        visible: !column.asDot
        // A gap between neighbours, and a top rounded where the column stops.
        x: Math.round(parent.width * 0.2)
        y: root.plotY + root.plotHeight - column.barHeight
        width: Math.max(Style.space(4), parent.width - 2 * x)
        height: column.barHeight
        color: Commons.Color.accent
        topLeftRadius: Style.space(3)
        topRightRadius: Style.space(3)
      }

      Text {
        textFormat: Text.PlainText
        width: parent.width
        y: root.plotY + root.plotHeight - column.barHeight - height - (column.asDot ? Style.space(8) : 1)
        text: Commons.I18n.formatNumber(column.row.score, column.row.decimals)
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: column.selected
        horizontalAlignment: Text.AlignHCenter
      }

      // The model's name, ending under its column when slanted.
      Text {
        textFormat: Text.PlainText
        width: root.slanted ? root.nameLength : parent.width - Style.space(4)
        x: root.slanted ? parent.width / 2 - width : Style.space(2)
        y: root.plotY + root.plotHeight + Style.space(root.slanted ? 4 : 5)
        transformOrigin: Item.TopRight
        rotation: root.slanted ? -60 : 0
        wrapMode: root.slanted ? Text.NoWrap : Text.Wrap
        maximumLineCount: root.slanted ? 1 : 2
        text: column.row.name
        // A model you use is written like the selection, so it stands out
        // from the row of names.
        color: column.selected || column.row.mine ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: column.row.mine
        horizontalAlignment: root.slanted ? Text.AlignRight : Text.AlignHCenter
        elide: Text.ElideRight
      }

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: column.row.source !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor
        onPositionChanged: root.picked(column.modelData.row)
        onClicked: root.activated(column.modelData.row)
      }
    }
  }

  // ---- Score over time: the line along the best score so far.
  Repeater {
    model: root.time ? root.spec.steps : []

    Item {
      required property var modelData
      required property int index
      readonly property var next: index + 1 < root.spec.steps.length ? root.spec.steps[index + 1] : null
      readonly property real fromX: root.plotX + modelData.x * root.plotWidth
      readonly property real toX: root.plotX + (next ? next.x : 1) * root.plotWidth
      readonly property real lineY: root.valueY(modelData.y)

      Rectangle {
        x: parent.fromX
        y: parent.lineY - 1
        width: Math.max(0, parent.toX - parent.fromX)
        height: 2
        color: Commons.Color.accent
      }

      Rectangle {
        visible: parent.next !== null
        x: parent.toX - 1
        y: parent.next ? root.valueY(parent.next.y) - 1 : 0
        width: 2
        height: parent.next ? parent.lineY - root.valueY(parent.next.y) + 2 : 0
        color: Commons.Color.accent
      }
    }
  }

  // ---- A dot for every result, over time or in its strip. The ones that
  // set a record (the best so far, or the best in their harness) are solid;
  // the rest sit back so those read first.
  Repeater {
    model: root.dotted ? root.spec.items : []

    Item {
      id: dot
      required property var modelData
      readonly property var row: root.rowAt(modelData.row)
      readonly property bool selected: root.selectedRow === modelData.row
      readonly property real size: selected ? Style.space(13) : (row.mine ? root.mineSize : root.dotSize)

      // A target larger than the mark, so a dot is easy to land on.
      width: Style.space(16)
      height: width
      x: root.plotX + modelData.x * root.plotWidth - width / 2
      y: root.valueY(modelData.y) - height / 2
      z: selected ? 4 : (row.mine ? 3 : (modelData.record ? 2 : 1))

      // A model you use is a diamond in the text color, so it is told apart
      // by shape as well as by color.
      Rectangle {
        anchors.centerIn: parent
        width: dot.size
        height: width
        radius: dot.row.mine ? 1 : width / 2
        rotation: dot.row.mine ? 45 : 0
        color: dot.selected || dot.row.mine ? root.foreground : (dot.modelData.record ? Commons.Color.accent : Util.alpha(Commons.Color.accent, 0.6))
        // A ring in the surface color keeps overlapping dots apart.
        border.width: dot.selected ? 2 : 1
        border.color: dot.selected ? Commons.Color.accent : root.surface
      }

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: dot.row.source !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor
        onPositionChanged: root.picked(dot.modelData.row)
        onClicked: root.activated(dot.modelData.row)
      }
    }
  }

  // Names for the models you use and the record setters, where there is room.
  // Each sits on a patch of the surface color, so a dot behind a name doesn't
  // run through its letters.
  Repeater {
    model: root.time ? Model.pointLabels(root.spec, root.rows, root.plotWidth, root.plotHeight, glyph.advanceWidth, root.lineHeight) : []

    Rectangle {
      required property var modelData
      x: root.plotX + modelData.x - Style.space(2)
      y: root.plotY + modelData.y
      z: 5
      width: label.implicitWidth + Style.space(4)
      height: label.implicitHeight
      radius: Style.space(2)
      color: Util.alpha(root.surface, 0.85)

      Text {
        id: label
        textFormat: Text.PlainText
        x: Style.space(2)
        text: parent.modelData.text
        color: root.selectedRow === parent.modelData.row || parent.modelData.mine ? root.foreground : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }
  }

  // The model that leads each strip, named above its dot.
  Repeater {
    model: root.strips ? root.spec.items.filter(function(item) { return item.record }) : []

    Text {
      required property var modelData
      readonly property real slot: root.plotWidth / root.spec.strips.length
      textFormat: Text.PlainText
      x: root.plotX + modelData.strip * slot + Style.space(2)
      y: Math.max(0, root.valueY(modelData.y) - height - Style.space(6))
      z: 4
      width: slot - Style.space(4)
      text: root.rowAt(modelData.row).name
      color: root.selectedRow === modelData.row ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      horizontalAlignment: Text.AlignHCenter
      wrapMode: Text.Wrap
      maximumLineCount: 2
      elide: Text.ElideRight
    }
  }
}
