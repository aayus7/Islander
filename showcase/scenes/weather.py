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
SCENE = Timeline(15500, start=(1700, 440), setup=setup)
SCENE.at(700).move(1282, 7, ms=1000).move(1288, 12, ms=300).wait(500)
SCENE.move(".dock-item[data-tab=weather]", ms=650).wait(250).click()
SCENE.wait(2600).move(1296, 262, ms=600)
SCENE.wheel(100, steps=4, every=140).wait(2400)
SCENE.wheel(100, steps=4, every=140).wait(2000)
SCENE.wheel(-100, steps=8, every=90).wait(900)
SCENE.move(1700, 440, ms=1100)
