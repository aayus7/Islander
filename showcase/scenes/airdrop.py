from record import Timeline
import json
G = "/showcase/assets/gen/"
files = [
    {"name": "IMG_4821.JPG", "size": 3_412_000, "fileType": "image/jpeg", "preview": G + "photo1_thumb.jpg"},
    {"name": "IMG_4822.JPG", "size": 2_988_000, "fileType": "image/jpeg", "preview": G + "photo2_thumb.jpg"},
    {"name": "IMG_4825.JPG", "size": 3_760_000, "fileType": "image/jpeg", "preview": G + "photo3_thumb.jpg"},
]
shelf = [
    {"id": f"s{i}", "path": "C:\\Users\\you\\Downloads\\" + f["name"], "name": f["name"], "kind": "image", "size": f["size"], "thumb": f["preview"], "ext": "jpg"}
    for i, f in enumerate(files)
]
SCENE = Timeline(21500, start=(1720, 470), setup="__stage.mock.stage([])")
# 1. A phone asks to share three photos; accept.
SCENE.at(700).js(f"__stage.airdrop({json.dumps(files)})")
SCENE.at(1500).move(".nb-btn.accept", ms=950).wait(300).click()
SCENE.wait(60).move(1590, 330, ms=600, kind="out")
# 2. They arrive (progress pill), then land on the Shelf.
SCENE.at(5000).js(f"__stage.setShelf({json.dumps(shelf)})")
# 3. Swipe the "Received" banner away, open the Shelf and send them on to another device.
SCENE.at(7300).move(".banner|Received", ms=800, dx=40).wait(250).press().move(1080, 40, ms=260, kind="io", arc=0).release()
SCENE.wait(700).move(1282, 7, ms=600).move(1287, 9, ms=250).wait(700)
SCENE.move(".dock-item[data-tab=shelf]", ms=650).wait(250).click()
SCENE.wait(900).move(".nb-dev|Pixel 9", ms=800).wait(300).click()
SCENE.wait(800).move(".send-go", ms=700).wait(250).click()
SCENE.wait(3300).move(1700, 470, ms=1000, kind="io")
