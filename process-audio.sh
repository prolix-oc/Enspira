#!/bin/bash
# process-audio.sh

# Get arguments
INPUT_FILE="$1"
OUTPUT_FILE="$2"
FILTER_FILE="$3"

# Load filters from file
FILTERS=$(cat "$FILTER_FILE")

# Run ffmpeg directly
ffmpeg -i "$INPUT_FILE" -af "$FILTERS" -ac 1 -ar 48100 -c:a pcm_s16le -f wav -y -threads 4 "$OUTPUT_FILE"

# Return the exit code
exit $?
