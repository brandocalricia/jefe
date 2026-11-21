#!/bin/sh
n=$(wc -w < announcement.md)
echo "words: $n"
if [ "$n" -lt 120 ] || [ "$n" -gt 180 ]; then
  echo "word count outside 120-180" >&2
  exit 1
fi
