#!/bin/sh
# The coordinator agent: for each topic, a draft from the writer, a review
# from the critic, and the final text from the editor. Each hop is a
# `pai send` through this agent's own daemon, so it runs over pai.
#
#   WRITER=<id> CRITIC=<id> EDITOR=<id> pai daemon --exec ./coordinate.sh
set -e
: "${WRITER:?set WRITER to the writer agent's id}" "${CRITIC:?set CRITIC}" "${EDITOR:?set EDITOR}"
topic=$(cat)

draft=$(pai send "$WRITER" "Write a short explanation of: $topic")
review=$(printf 'Review this explanation of "%s":\n\n%s\n' "$topic" "$draft" | pai send "$CRITIC")
final=$(printf 'Topic: %s\n\nDraft:\n%s\n\nReview:\n%s\n' "$topic" "$draft" "$review" | pai send "$EDITOR")

printf '## Draft (writer)\n%s\n\n## Review (critic)\n%s\n\n## Final (editor)\n%s\n' "$draft" "$review" "$final"
