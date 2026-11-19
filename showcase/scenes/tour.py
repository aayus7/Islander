from record import Timeline
import json
hours = []
for i in range(25):
    h = 9 + i
    day = 19 + h // 24
    hh = h % 24
    temp = [-1, 0, 0, 1, 1, 1, 0, -1, -2, -2, -3, -3, -3, -4, -4, -4, -5, -5, -5, -5, -4, -3, -2, -1, 0][i]
    code = 71 if i < 6 else (3 if i < 12 else 2)
    hours.append({"t": f"2026-11-{day}T{hh:02d}:00", "temp": temp, "code": code, "isDay": 7 < hh < 17, "pop": 70 if i < 6 else 15})
days = [[2, -5, 71, 70], [3, -3, 3, 20], [6, 0, 61, 60], [4, -2, 2, 10], [1, -6, 73, 80], [-1, -7, 0, 0], [3, -4, 3, 10]]
data = {
    "city": "Toronto", "temp": -1, "high": 2, "low": -5, "code": 71, "isDay": True, "unit": "C", "hourly": [],
    "feels": -6, "humidity": 84, "dewPoint": -3, "wind": 21, "windDir": 290, "gust": 44, "windUnit": "km/h", "uv": 1,
    "pressure": 1009, "visibility": 6000, "precip": 0.4, "utcOffset": -5 * 3600,
    "sunrise": "2026-11-19T07:14", "sunset": "2026-11-19T16:49", "tomorrowSunrise": "2026-11-20T07:15", "hours": hours,
    "days": [{"date": f"2026-11-{19 + i}", "max": a, "min": b, "code": c, "pop": p, "uv": 1, "precipSum": 2.1 if c > 60 else 0} for i, (a, b, c, p) in enumerate(days)],
}
setup = "__stage.mock.stage([]); __stage.weatherStore.set({key:'|C', error:'', data: Object.assign(%s, {at: Date.now() - 3*60000})})" % json.dumps(data)

setup = setup.replace("__stage.mock.stage([]);", "__stage.mock.stage([]); __stage.settings({modules:['ai','controls','today','weather','clock','notes','shelf','clipboard','stats']}); __stage.setShelf([{\"id\": \"s1\", \"path\": \"C:\\\\x\\\\IMG_4821.JPG\", \"name\": \"IMG_4821.JPG\", \"kind\": \"image\", \"size\": 3412000, \"thumb\": \"/showcase/assets/gen/photo1_thumb.jpg\", \"ext\": \"jpg\"}, {\"id\": \"s2\", \"path\": \"C:\\\\x\\\\Q4 Report.pdf\", \"name\": \"Q4 Report.pdf\", \"kind\": \"file\", \"size\": 1840000, \"thumb\": null, \"ext\": \"pdf\"}, {\"id\": \"s3\", \"path\": \"C:\\\\x\\\\IMG_4825.JPG\", \"name\": \"IMG_4825.JPG\", \"kind\": \"image\", \"size\": 3760000, \"thumb\": \"/showcase/assets/gen/photo3_thumb.jpg\", \"ext\": \"jpg\"}]); __stage.todos([{\"id\": \"t1\", \"text\": \"Ship Islander 1.0\", \"done\": false, \"at\": 1}, {\"id\": \"t2\", \"text\": \"Record the launch video\", \"done\": true, \"at\": 2}, {\"id\": \"t3\", \"text\": \"Reply to kai about the wallpaper\", \"done\": false, \"at\": 3}, {\"id\": \"t4\", \"text\": \"Groceries: oat milk, coffee\", \"done\": false, \"at\": 4}]);")
SCENE = Timeline(20000, start=(1700, 440), setup=setup)
SCENE.at(600).move(1282, 7, ms=1000).move(1290, 30, ms=400).wait(1300)
for i in range(8):
    SCENE.wheel(100, steps=1).wait(1700)
SCENE.move(1700, 440, ms=1000)
