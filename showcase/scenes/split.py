from record import Timeline
# A second live activity buds off the music pill and melts back in (close-up, run with DPR=2).
SCENE = Timeline(8200, start=(1900, 420), clip=(1040, 0, 480, 110), setup="0")
START = "import('/src/lib/timer.ts').then(m=>{m.clockActions.setTimer(15*60000);m.clockActions.start()})"
STOP = "import('/src/lib/timer.ts').then(m=>m.clockActions.reset())"
SCENE.at(1100).js(START)
SCENE.at(4600).js(STOP)
SCENE.at(7200).js("0")
