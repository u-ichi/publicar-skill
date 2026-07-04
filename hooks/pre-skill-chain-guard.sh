#!/usr/bin/env bash
set -uo pipefail

HOOK_INPUT=$(cat)
LOG_DIR="${TMPDIR:-/tmp}/claude-publicar-chain-guard"
DRIFT_LOG="$LOG_DIR/drift.log"
MAX_LOG_BYTES=1048576

drift() {
  local reason="$1"
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  if [[ -f "$DRIFT_LOG" ]]; then
    local size
    size=$(wc -c <"$DRIFT_LOG" 2>/dev/null || printf '0')
    if [[ "$size" =~ ^[0-9]+$ ]] && (( size > MAX_LOG_BYTES )); then
      tail -c "$MAX_LOG_BYTES" "$DRIFT_LOG" >"$DRIFT_LOG.tmp" 2>/dev/null && mv "$DRIFT_LOG.tmp" "$DRIFT_LOG"
    fi
  fi
  printf '%s\t%s\t%s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "${SESSION_ID:-}" "$reason" >>"$DRIFT_LOG" 2>/dev/null || true
}

jq_field() {
  local filter="$1"
  printf '%s' "$HOOK_INPUT" | jq -r "$filter" 2>/dev/null
}

is_publicar_skill() {
  [[ "$1" == "publicar:publicar-deploy" || "$1" == "publicar-deploy" || "$1" == "publicar:publicar-comment-loop" || "$1" == "publicar-comment-loop" ]]
}

extract_human_text() {
  local record
  record="$1"
  printf '%s' "$record" | jq -r '
    .message.content as $content
    | if ($content | type) == "string" then
        $content
      elif ($content | type) == "array" then
        [$content[]? | .text // empty] | join("\n")
      else
        ""
      end
  ' 2>/dev/null
}

TOOL_NAME=$(jq_field '.tool_name // empty')
SKILL_NAME=$(jq_field '.tool_input.skill // empty')
SESSION_ID=$(jq_field '.session_id // empty')
TRANSCRIPT_PATH=$(jq_field '.transcript_path // empty')
PROMPT_ID=$(jq_field '.prompt_id // empty')

if [[ "$TOOL_NAME" != "Skill" ]]; then
  exit 0
fi

if ! is_publicar_skill "$SKILL_NAME"; then
  exit 0
fi

if [[ -z "$PROMPT_ID" || -z "$TRANSCRIPT_PATH" ]]; then
  drift "missing prompt_id or transcript_path"
  exit 0
fi

if [[ ! -r "$TRANSCRIPT_PATH" ]]; then
  drift "transcript unreadable: $TRANSCRIPT_PATH"
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  drift "jq unavailable"
  exit 0
fi

if ! records=$(tail -n 2000 "$TRANSCRIPT_PATH" 2>/dev/null | jq -rc --arg prompt_id "$PROMPT_ID" '
  select(.promptId == $prompt_id or (.type == "assistant" and .isSidechain != true))
' 2>/dev/null); then
  drift "transcript parse failed"
  exit 0
fi

if [[ -z "$records" ]]; then
  drift "no transcript records for prompt_id"
  exit 0
fi

source_assistant_uuids=$(printf '%s\n' "$records" | jq -r --arg prompt_id "$PROMPT_ID" '
  select(.promptId == $prompt_id)
  | .sourceToolAssistantUUID // empty
' 2>/dev/null)

human_text=""
skill_names=()

while IFS= read -r record; do
  [[ -z "$record" ]] && continue
  record_prompt_id=$(printf '%s' "$record" | jq -r '.promptId // empty' 2>/dev/null)
  record_uuid=$(printf '%s' "$record" | jq -r '.uuid // empty' 2>/dev/null)
  record_role=$(printf '%s' "$record" | jq -r '.message.role // empty' 2>/dev/null)
  is_related_assistant=false
  if [[ "$record_role" == "assistant" && -n "$record_uuid" ]] && printf '%s\n' "$source_assistant_uuids" | grep -Fxq "$record_uuid"; then
    is_related_assistant=true
  fi

  if [[ "$record_prompt_id" != "$PROMPT_ID" && "$is_related_assistant" != "true" ]]; then
    continue
  fi

  is_human=$(printf '%s' "$record" | jq -r '
    (.message.role == "user")
    and (.isMeta != true)
    and ((.origin.kind == "human") or (.promptSource == "typed") or (.promptSource == "sdk"))
  ' 2>/dev/null)
  if [[ "$record_prompt_id" == "$PROMPT_ID" && "$is_human" == "true" ]]; then
    text=$(extract_human_text "$record")
    if [[ -n "$text" ]]; then
      human_text="${human_text}"$'\n'"${text}"
    fi
  fi

  if [[ "$is_related_assistant" != "true" ]]; then
    continue
  fi

  while IFS= read -r skill; do
    [[ -n "$skill" ]] && skill_names+=("$skill")
  done < <(printf '%s' "$record" | jq -r '
    select(.message.role == "assistant")
    | .message.content[]?
    | select(.type == "tool_use" and .name == "Skill")
    | .input.skill // empty
  ' 2>/dev/null)
done <<<"$records"

intent_pattern='publicar|publicar に出|publicar deploy|デプロイして|デプロイする|アップロードして|アップロードする|共有して|公開して|配信して|publish して|publish する|share して|share する|deploy して|deploy する'

if printf '%s' "$human_text" | grep -qiE "$intent_pattern"; then
  exit 0
fi

previous_skill=""
for ((idx=${#skill_names[@]} - 1; idx >= 0; idx--)); do
  candidate="${skill_names[$idx]}"
  if [[ "$candidate" == "$SKILL_NAME" ]]; then
    continue
  fi
  previous_skill="$candidate"
  break
done

if [[ -z "$previous_skill" ]]; then
  exit 0
fi

if is_publicar_skill "$previous_skill"; then
  exit 0
fi

jq -cn \
  --arg previous "$previous_skill" \
  --arg current "$SKILL_NAME" \
  '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ("ユーザー発話に publicar 系の指示が無いまま " + $previous + " 完了直後に " + $current + " を発火しようとしました。明示指示があるまで待機してください。")
    }
  }'
exit 0
