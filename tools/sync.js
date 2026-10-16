#!/usr/bin/env node
/**
 * 議事録システムの Code.gs から、Chat で使う関数と設定を gas/Shared.gs に写す/写しが合っているか確かめる。
 *
 *   node tools/sync.js check <議事録システムの Code.gs>   … gas/Shared.gs が Code.gs と一致するか(違えば終了コード1)
 *   node tools/sync.js pull  <議事録システムの Code.gs>   … gas/Shared.gs を Code.gs から作り直す
 *
 * 「関与先ルール」Markdown は、議事録システムのパネルの「Claudeにルールを渡す」と Chat の「ルール」で
 * 同じ関数(clientRulesMd_)から作る約束。Shared.gs は手で直さず、議事録システム側を直してから pull する。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHARED = path.join(__dirname, '..', 'gas', 'Shared.gs');

// 写す関数・定数(議事録システムの Code.gs にある名前のまま)
const NAMES = [
  'CHAT_HELP', 'chatExternal_', 'chatAnswer_', 'searchClients_',
  'chatLink_', 'chatList_', 'chatSection_', 'chatClip_',
  'chatNote_', 'chatQuestions_', 'chatRules_',
  'clientRulesMd_', 'readKarteRows_', 'openTodos_', 'readQuestions_', 'questionTo_', 'isClientQ_',
];
// 写す設定(CFG のうち、上の関数と Chat.gs が使うもの)
const CFG_KEYS = ['VERSION', 'MASTER_SHEET', 'SHEET_KARTE', 'SHEET_TODO', 'SHEET_Q', 'KARTE_CATEGORIES', 'TODO_STATUSES', 'QUESTION_TO', 'HEADERS'];

/** トップレベルの function / const を1つ、括弧の対応を数えて取り出す */
function extract(src, name) {
  const lines = src.split('\n');
  const start = lines.findIndex(l => l.startsWith('function ' + name + '(') || l.startsWith('const ' + name + ' ='));
  if (start < 0) throw new Error('Code.gs に ' + name + ' がありません');
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if ('({['.includes(ch)) depth++;
      else if (')}]'.includes(ch)) depth--;
    }
    const t = lines[i].trim();
    if (depth === 0 && (t.endsWith('}') || t.endsWith(';'))) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(name + ' の終わりが見つかりません');
}

function readCfg(src) {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(extract(src, 'CFG') + '\nthis.CFG = CFG;', ctx);
  const out = {};
  CFG_KEYS.forEach(k => {
    if (!(k in ctx.CFG)) throw new Error('Code.gs の CFG に ' + k + ' がありません');
    out[k] = ctx.CFG[k];
  });
  return out;
}

function build(codeGs) {
  const src = fs.readFileSync(codeGs, 'utf8').replace(/\r\n/g, '\n');
  const cfg = readCfg(src);
  return [
    '/**',
    ' * 自動生成: 議事録システム Code.gs(版 ' + cfg.VERSION + ')から tools/sync.js で写したもの。手で直さない。',
    ' * 直すときは議事録システム側を直し、`node tools/sync.js pull <Code.gs>` で写し直す。',
    ' */',
    '',
    'const CFG = ' + JSON.stringify(cfg, null, 2) + ';',
    '',
  ].concat(NAMES.map(n => extract(src, n) + '\n')).join('\n');
}

function main() {
  const [mode, codeGs] = process.argv.slice(2);
  if (!/^(check|pull)$/.test(mode || '') || !codeGs) {
    console.error('使い方: node tools/sync.js check|pull <議事録システムの Code.gs>');
    process.exit(2);
  }
  const want = build(codeGs);
  if (mode === 'pull') {
    fs.writeFileSync(SHARED, want);
    console.log('gas/Shared.gs を書き直しました');
    return;
  }
  const have = fs.existsSync(SHARED) ? fs.readFileSync(SHARED, 'utf8').replace(/\r\n/g, '\n') : '';
  if (have === want) {
    console.log('一致: gas/Shared.gs は ' + codeGs + ' と同じです');
    return;
  }
  const a = have.split('\n'), b = want.split('\n');
  const i = a.findIndex((l, k) => l !== b[k]);
  console.error('不一致: gas/Shared.gs の ' + (i + 1) + '行目から違います');
  console.error('  Shared.gs: ' + (a[i] === undefined ? '(なし)' : a[i]));
  console.error('  Code.gs  : ' + (b[i] === undefined ? '(なし)' : b[i]));
  process.exit(1);
}

if (require.main === module) main();
module.exports = { build, extract, NAMES, CFG_KEYS };
