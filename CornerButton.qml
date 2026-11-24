import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui

// A square button for the panel's header and its previous/next arrows: grey
// until hovered, then outlined in the accent. It looks like the shell's
// HeroButton, which Omarchy 4.5 doesn't have yet; the plugin carries its own
// so that it loads there too.
Rectangle {
  id: cornerButton
  signal clicked()
  property string glyph: ""
  property string tooltip: ""
  property string fontFamily: Style.font.family
  readonly property color grey: Qt.darker(Commons.Color.foreground, 1.55)

  implicitWidth: Style.space(34)
  implicitHeight: implicitWidth
  radius: Style.cornerRadius
  color: Util.alpha(grey, 0.12)
  border.width: pointer.containsMouse ? Math.max(1, Style.hoverBorderWidth) : 0
  border.color: Commons.Color.accent

  Text {
    anchors.centerIn: parent
    textFormat: Text.PlainText
    text: cornerButton.glyph
    color: pointer.containsMouse ? Commons.Color.accent : cornerButton.grey
    font.family: cornerButton.fontFamily
    font.pixelSize: Style.font.heading
  }

  MouseArea {
    id: pointer
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: cornerButton.clicked()
  }

  PanelToolTip {
    visible: pointer.containsMouse
    text: cornerButton.tooltip
  }
}
