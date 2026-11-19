from record import Timeline
SCENE = Timeline(7600, start=(1700, 440), setup="__stage.mock.stage([])")
SCENE.at(800).js("__stage.connect(\"AirPods Pro\", 'earbuds', 82)")
