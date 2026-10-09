#!/bin/sh
# 監査ログ: Claude Code がツールを使う直前に、その内容を1行ずつ記録する。
# 記録先: <プロジェクト>/.claude/logs/audit.log（.gitignore 済み）
# 失敗しても Claude の作業は止めない（常に exit 0）。

log_dir="${CLAUDE_PROJECT_DIR:-.}/.claude/logs"
mkdir -p "$log_dir" 2>/dev/null || exit 0

payload=$(tr -d '\r\n')
printf '%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$payload" >> "$log_dir/audit.log" 2>/dev/null

exit 0
