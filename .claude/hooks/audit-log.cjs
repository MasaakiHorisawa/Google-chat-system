#!/usr/bin/env node
// 監査ログ: PreToolUse(実行前)/ PostToolUse(実行後)で、ツールの実行を1行ずつ記録する。
// 保存先: <プロジェクト>/.claude/audit-logs/audit-YYYY-MM-DD.jsonl
// 記録に失敗しても作業は止めない(常に exit 0)。
'use strict';

const fs = require('fs');
const path = require('path');

const MAX = 500; // 1項目あたりの最大文字数(長いコマンドや本文は切り詰める)

function cut(v) {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX ? s.slice(0, MAX) + '…(以下省略)' : s;
}

// 何をしたかが分かる項目だけを残す(ファイルの中身などは記録しない)
function summarize(input) {
  if (!input || typeof input !== 'object') return undefined;
  const keys = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'];
  const out = {};
  keys.forEach(k => { if (input[k] !== undefined) out[k] = cut(input[k]); });
  return Object.keys(out).length ? out : { keys: Object.keys(input) };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw || '{}');
    const root = process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd();
    const dir = path.join(root, '.claude', 'audit-logs');
    fs.mkdirSync(dir, { recursive: true });

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

    const line = {
      time: now.toISOString(),
      event: ev.hook_event_name,
      tool: ev.tool_name,
      input: summarize(ev.tool_input),
      mode: ev.permission_mode,
      cwd: ev.cwd,
      session: ev.session_id,
      tool_use_id: ev.tool_use_id
    };
    fs.appendFileSync(path.join(dir, `audit-${day}.jsonl`), JSON.stringify(line) + '\n', 'utf8');
  } catch (e) {
    process.stderr.write('監査ログの記録に失敗しました: ' + e.message + '\n');
  }
  process.exit(0);
});
