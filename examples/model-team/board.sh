#!/bin/sh
# The model team on a group's job board: each step is a job for a role, and
# whichever agent holds that role (and runs `pai daemon --worker`) claims
# it. Run it in the folder of any member whose daemon is running:
#
#   ./board.sh "why peer-to-peer apps need NAT hole punching"
#
# No agent ids anywhere: add a second writer and the two share the drafts.
set -e
topic=${1:-$(cat)}

draft=$(pai job post --to role:writer --wait "Write a short explanation of: $topic")
review=$(printf 'Review this explanation of "%s":\n\n%s\n' "$topic" "$draft" | pai job post --to role:critic --wait)
final=$(printf 'Topic: %s\n\nDraft:\n%s\n\nReview:\n%s\n' "$topic" "$draft" "$review" | pai job post --to role:editor --wait)

printf '## Draft (writer)\n%s\n\n## Review (critic)\n%s\n\n## Final (editor)\n%s\n' "$draft" "$review" "$final"
