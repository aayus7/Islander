from record import Timeline
SCENE = Timeline(11500, start=(1700, 440), setup="__stage.mock.stage([])")
def hud(t, kind, value, on=False):
    SCENE.events.append((t, "js", "__stage.emit('hud://show', {kind:'%s', value:%f, on:%s})" % (kind, value, "true" if on else "false")))
t = 700
for i in range(8):  # volume up, key repeat
    hud(t, "volume", 0.36 + i * 0.06); t += 110
t += 1700
hud(t, "mute", 0.78, True); t += 2000
hud(t, "mute", 0.78, False); t += 1900
for i in range(7):  # brightness down
    hud(t, "brightness", 0.82 - i * 0.07); t += 120
t += 1900
hud(t, "caps", 1, True)
