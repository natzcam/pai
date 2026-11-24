#!/bin/sh
# Stand-in for an LLM: replies with the first three sentences of the
# request, as bullets, one at a time so the streaming is visible.
# Swap the body for a real model, for example:
#   ollama run llama3 "Summarize in 3 bullets:
#   $(cat)"
tr '\n' ' ' | sed 's/\([.!?]\)  */\1\n/g' | grep -v '^ *$' | head -n 3 | while IFS= read -r line; do
  printf '• %s\n' "$line"
  sleep 0.3
done
