from record import Timeline
import json
def dl(**o):
    return "__stage.runDownload(%s)" % json.dumps(o)
SCENE = Timeline(16500, start=(1730, 470), setup="__stage.mock.stage([])")
SCENE.at(700).js(dl(id="m1", name="blender-4.3.2-windows-x64.msi", total=372_000_000, ms=10500, browser="MDM"))
SCENE.at(2600).js(dl(id="i1", name="ubuntu-24.04.1-desktop-amd64.iso", total=6_114_000_000, ms=15000, browser="IDM", **{"from": 0.18, "to": 0.29}, done=False))
SCENE.at(4300).move(1282, 7, ms=900).move(1288, 12, ms=300).wait(3600)
SCENE.move(1735, 455, ms=1100)
