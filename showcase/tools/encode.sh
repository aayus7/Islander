#!/bin/sh
# encode.sh <master.mp4> <name> <start> <end>  -> media/<name>.webp (README) and media/<name>.mp4 (web/video)
set -e
IN=$1; NAME=$2; SS=$3; TO=$4; OUT=${OUT:-/home/claude/media}
CROP="crop=880:${H:-440}:200:0"
ffmpeg -v error -y -ss $SS -to $TO -i "$IN" -vf "$CROP,fps=30" -c:v libwebp_anim -lossless 0 -quality 82 -compression_level 6 -loop 0 -preset picture "$OUT/$NAME.webp"
ffmpeg -v error -y -ss $SS -to $TO -i "$IN" -vf "$CROP" -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -movflags +faststart -an "$OUT/$NAME.mp4"
ls -la "$OUT/$NAME.webp" "$OUT/$NAME.mp4"
