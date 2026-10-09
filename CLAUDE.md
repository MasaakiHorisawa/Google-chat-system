# Google-chat-system

## Claude Code の運用ルール
- 認証情報（`.env`、鍵ファイル、Google の認証 JSON）はリポジトリに置かない。クラウド実行では環境の「秘密情報（環境変数）」に入れる。
- 権限設定は `.claude/settings.json`（チーム共有・コミット対象）。個人用の上書きは `.claude/settings.local.json`（コミットしない）。
- 監査ログは `.claude/hooks/audit-log.sh` が `.claude/logs/audit.log` に記録する。
