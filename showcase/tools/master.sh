#!/bin/sh
# master.sh <scene>  -> media/<scene>_master.mp4 from the recorder's PNG frames (1280x560, 60 fps)
ffmpeg -v error -y -framerate 60 -i /tmp/showcase/$1/f_%05d.png -c:v libx264 -preset slow -crf 10 -pix_fmt yuv444p /home/claude/media/$1_master.mp4 && ls -la /home/claude/media/$1_master.mp4
