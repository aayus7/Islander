from record import Timeline
SCENE = Timeline(16000, start=(1700, 440), setup="__stage.mock.stage([])")
SCENE.at(600).move(1282, 7, ms=1000).move(1288, 12, ms=300).wait(450)
SCENE.move(".dock-item[data-tab=clock]", ms=650).wait(250).click()
SCENE.wait(800).move(".chip|1 min", ms=700).wait(200).click()
SCENE.wait(500).move(".round-btn|Start", ms=650).wait(250).click()
SCENE.wait(1200).move(1700, 440, ms=1000)
SCENE.wait(4200).move(1282, 12, ms=1000).wait(1700).move(1700, 440, ms=1000)
