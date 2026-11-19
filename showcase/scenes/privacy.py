from record import Timeline
SCENE = Timeline(12500, start=(1700, 430), setup="__stage.mock.stage([])")
SCENE.at(900).js("__stage.privacy(false, true, ['Discord'])")
SCENE.at(2900).js("__stage.privacy(true, true, ['Discord'])")
SCENE.at(4300).move(1282, 7, ms=900).move(1288, 12, ms=300).wait(2400)
SCENE.move(1700, 430, ms=1000)
SCENE.at(9800).js("__stage.privacy(false, false, [])")
