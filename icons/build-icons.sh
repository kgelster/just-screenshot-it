#!/usr/bin/env bash
# Rasterise the icon SVGs to the PNG sizes the manifest declares.
#
# TWO SETS, NOT ONE
#
#   glyph*.png  action.default_icon — the toolbar button. Line art on a
#               transparent ground so it reads on any toolbar colour. See the
#               comment at the top of glyph.svg for why this is one drawing
#               rather than a light one and a dark one.
#
#   tile*.png   the manifest "icons" key — chrome://extensions, the puzzle
#               menu, permission dialogs. These sit on the browser's own white
#               or dark card, where a self-grounding mark is right, so they
#               keep the filled #171B2B square.
#
# TWO SOURCES PER SET, NOT ONE DOWNSCALED FOUR TIMES
#
# A 128px design shrunk to 16 turns its text lines into grey smear and its
# arrow into a smudge, so the small sizes get their own drawing with the
# detail taken out.
#
# Requires librsvg (`brew install librsvg`) and ImageMagick (`brew install
# imagemagick`). rsvg-convert renders at the target size rather than
# resampling, which is why it is used instead of `sips -z`.
set -euo pipefail

cd "$(dirname "$0")"

render() { # render <source.svg> <basename> <size...>
  local src="$1" base="$2"
  shift 2
  for size in "$@"; do
    rsvg-convert -w "$size" -h "$size" "$src" -o "${base}${size}.png"
  done
}

render glyph.svg       glyph 128 48
render glyph-small.svg glyph 32 16
render tile.svg        tile  128 48
render tile-small.svg  tile  32 16

# Verify alpha, not only dimensions.
#
# `sips -g pixelWidth` cannot tell an accidentally opaque ground from a
# transparent one, which is the single failure that would undo the whole point
# of the glyph set: a white or dark box behind the line art shows up on
# whichever toolbar it does not match. `%[opaque]` is no good either, because
# the tiles' rounded corners already make them non-opaque. Mean alpha is the
# measure that separates the two: line art is mostly nothing, a filled tile is
# nearly everything.
#
# Measured on the current drawings: glyphs land near 0.2, tiles near 0.96.
GLYPH_ALPHA_MAX=0.60
TILE_ALPHA_MIN=0.85

status=0
printf 'wrote:\n'
for base in glyph tile; do
  for size in 16 32 48 128; do
    file="${base}${size}.png"
    # The trailing newline matters: without it `read` exits non-zero and
    # `set -e` takes the script down mid-loop with no output.
    read -r w h alpha < <(magick identify -format '%w %h %[fx:mean.a]\n' "$file")

    note='ok'
    if [ "$w" != "$size" ] || [ "$h" != "$size" ]; then
      note='WRONG SIZE'
      status=1
    elif [ "$base" = glyph ] && awk "BEGIN{exit !($alpha > $GLYPH_ALPHA_MAX)}"; then
      note="NOT TRANSPARENT (mean alpha must stay under $GLYPH_ALPHA_MAX)"
      status=1
    elif [ "$base" = tile ] && awk "BEGIN{exit !($alpha < $TILE_ALPHA_MIN)}"; then
      note="GROUND MISSING (mean alpha must stay over $TILE_ALPHA_MIN)"
      status=1
    fi

    printf '  %-14s %3sx%-3s  alpha %.3f  %s\n' "$file" "$w" "$h" "$alpha" "$note"
  done
done

exit "$status"
