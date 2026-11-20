from record import Timeline
import json
# Two at once: the music pill with a second activity budding off and melting back in, over
# and over: a download, then a screen recording, then a download again (close-up, DPR=2).
# Loops from 1.5 s to 9.6 s (the download bubble is out at both ends).
ART = "/showcase/assets/gen/album_dropout.jpg"
music = [{"id": "Spotify.exe", "app": "Spotify", "tracks": [{"title": "We Don't Care", "artist": "", "album": "", "duration": 239, "artwork": ART}], "position": 40}]
def dl(i):
    return "__stage.runDownload(%s)" % json.dumps({"id": f"d{i}", "name": "blender-4.3.2-windows-x64.msi", "total": 372_000_000, "ms": 30000, "browser": "MDM", "from": 0.32, "to": 0.95, "done": False})
REC = "import('/src/lib/screenrec.ts').then(m=>m.showcaseRec(%s))"
SCENE = Timeline(10200, start=(1900, 420), clip=(1040, 0, 480, 110), setup="__stage.mock.stage(%s);%s" % (json.dumps(music), dl(1)))
SCENE.at(3300).js("__stage.clearDownload('d1')")
SCENE.at(4300).js(REC % "true")
SCENE.at(6900).js(REC % "false")
SCENE.at(8100).js(dl(2))
SCENE.at(10000).js("0")
