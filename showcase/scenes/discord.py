from record import Timeline
import json
G = "/showcase/assets/gen/"
def n(i, title, body, avatar, attachment=None):
    return "__stage.notify(%s)" % json.dumps({"id": f"d{i}", "app": "Discord", "title": title, "body": body, "avatar": G + avatar, "avatarRound": True, "attachment": attachment})
SCENE = Timeline(19200, start=(1760, 480), setup="__stage.mock.stage([])")
SCENE.at(900).js(n(1, "maya", "are we still on for tonight?", "av_sunset.png"))
SCENE.at(6800).js(n(2, "kai (#design, Islander)", "new wallpaper just dropped", "av_cat.png", G + "photo2_thumb.jpg"))
SCENE.at(12400).js(n(3, "maya", "ok 9pm it is, bring snacks", "av_sunset.png"))
SCENE.at(2000).move(1700, 430, ms=2600, kind="io", arc=0.05)
SCENE.at(8200).move(1390, 70, ms=1100)  # hover the banner to read it
SCENE.wait(1900).move(1720, 460, ms=1100)
