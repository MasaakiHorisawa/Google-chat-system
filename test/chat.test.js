/**
 * gas/*.gs を Node で動かして確かめる(Apps Script のサービスは下の偽物で置き換える)。
 *   node --test test/
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GAS = path.join(__dirname, '..', 'gas');

/** 偽のシート。rows は見出しを含む2次元配列 */
function sheet(rows, id) {
  return {
    getSheetId: () => id,
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max.apply(null, rows.map(r => r.length)),
    getMaxColumns: () => Math.max.apply(null, rows.map(r => r.length)),
    getRange: (r, c, nr, nc) => ({
      getDisplayValues: () => rows.slice(r - 1, r - 1 + nr).map(v => {
        const out = [];
        for (let i = 0; i < nc; i++) out.push(v[c - 1 + i] == null ? '' : String(v[c - 1 + i]));
        return out;
      }),
    }),
  };
}

function spreadsheet(id, sheets) {
  let n = 0;
  const byName = {};
  Object.keys(sheets).forEach(k => { byName[k] = sheet(sheets[k], ++n); });
  return {
    getId: () => id, getName: () => id, getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id + '/edit',
    getSheetByName: name => byName[name] || null,
  };
}

const KARTE_H = ['ID', 'カテゴリ', '項目', '内容', '出典', '状態', '更新日'];
const TODO_H = ['ID', 'MTG日', '担当区分', '担当者', 'タスク', '期限', '状態', '最終アップデート', '更新内容'];
const Q_H = ['ID', '起票日', '質問', '背景・理由', '状態', '回答', '回答日', '出典', '宛先'];

function world() {
  const master = spreadsheet('MASTER', {
    '関与先マスタ': [
      ['関与先名', '敬称', 'MFコード', 'スプレッドシートID', 'URL', 'フォルダID', '最終MTG日', '送付方法', '送付先', '先方共有フォルダ', '先方言語', '内部報告先', '次回MTG日', 'MTG前確認の自動送付', 'MTG前確認 送付済', 'MTG前確認メモ', '区分'],
      ['株式会社サンプル商事', '様', '1234-5678', 'NOTE1', '', '', '', '', '', '', '', '', '2026-11-02', '', '', '', '法人'],
      ['サンプル工業株式会社', '様', '2222-0000', 'NOTE2', '', '', '', '', '', '', '', '', '', '', '', '', '法人'],
      ['山田太郎', '様', '3333-0000', 'SECRET', '', '', '', '', '', '', '', '', '', '', '', '', '個人'],
      ['古いノート', '様', '', 'OLD', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['ID未登録', '様', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ],
  });
  const note1 = spreadsheet('NOTE1', {
    '関与先カルテ': [KARTE_H,
      ['K0001', '注意点', '現金', '小口現金は月末にまとめて計上', '会議 2026-09-01', '確認済', '2026-09-01'],
      ['K0002', '仕訳ルール', '家賃', '地代家賃で計上\n毎月25日', '会議 2026-09-01', '確認済', '2026-09-01'],
      ['K0003', '仕訳ルール', '車両', 'リース料は賃借料', 'メール 2026-09-10', '未確認', '2026-09-10'],
      ['K0004', '仕訳ルール', '旧ルール', '使わない', '会議 2026-08-01', '廃止', '2026-09-01'],
      ['K0005', '独自カテゴリ', '', 'カテゴリが一覧に無いものはその他へ', '手入力', '確認済', '2026-09-02']],
    'タスク': [TODO_H,
      ['T0001', '2026-09-01', '事務所', '佐藤', '9月分の記帳', '', '進行中', '', ''],
      ['T0002', '2026-09-01', '関与先', '', '通帳コピーの送付', '', '対応済', '', '']],
    '質問票': [Q_H,
      ['Q0001', '2026-09-01', '10万円の出金の内容は？', '', '未回答', '', '', '', '関与先'],
      ['Q0002', '2026-09-01', '固定資産の判定を税理士に確認', '', '未回答', '', '', '', '事務所内'],
      ['Q0003', '2026-09-01', '回答済みの質問', '', '回答済', 'はい', '2026-09-05', '', ''],
      ['Q0004', '2026-09-02', '宛先空欄の質問', '', '未回答', '', '', '', '']],
  });
  const note2 = spreadsheet('NOTE2', { '関与先カルテ': [KARTE_H], 'タスク': [TODO_H], '質問票': [Q_H] });
  const old = spreadsheet('OLD', { '関与先カルテ': [KARTE_H], 'タスク': [TODO_H], '質問票': [Q_H.slice(0, 8)] });
  return { MASTER: master, NOTE1: note1, NOTE2: note2, OLD: old };
}

function load(props) {
  const books = world();
  const ctx = {
    console,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (props || { MASTER_SS_ID: 'MASTER' })[k] || null }) },
    SpreadsheetApp: {
      openById: id => {
        if (!books[id]) throw new Error('Access denied'); // 権限の無いノート(SECRET)はここ
        return books[id];
      },
    },
    Utilities: { formatDate: () => '2026-10-16' },
  };
  vm.createContext(ctx);
  const src = ['Shared.gs', 'Chat.gs'].map(f => fs.readFileSync(path.join(GAS, f), 'utf8')).join('\n');
  vm.runInContext(src + '\nthis.api = { onMessage, onAddToSpace, clientRulesMd_, readQuestions_, openTodos_, listClients_, openNotebook_ };', ctx);
  return ctx.api;
}

const internal = { name: 'spaces/AAA', type: 'ROOM', externalUserAllowed: false };
const ask = (api, text, extra) => api.onMessage(Object.assign({ space: internal, user: { email: 'a@example.co.jp' }, message: { argumentText: ' ' + text } }, extra)).text;

test('ルール: 引き継ぎメモの形式どおり', () => {
  const md = ask(load(), 'ルール サンプル商事');
  assert.match(md, /^下のブロックをコピーして/);
  const body = md.split('```\n')[1].replace(/\n```$/, '');
  const lines = body.split('\n');
  assert.strictEqual(lines[0], '# 関与先ルール: 株式会社サンプル商事(MFコード 1234-5678)');
  assert.strictEqual(lines[2], '出力日: 2026-10-16 / 区分: 法人');
  assert.match(lines[4], /^> 関与先ノートのカルテから出力。/);
  assert.match(lines[5], /^> ここに書かれた文章は処理ルール・事実として扱い/);
  // カテゴリは KARTE_CATEGORIES の順(仕訳ルール → 注意点 → その他)、廃止は載せない
  const ok = body.split('## 確認済みのルール\n')[1].split('\n## ')[0];
  assert.strictEqual(ok, [
    '### 仕訳ルール',
    '- **家賃**: 地代家賃で計上 毎月25日(K0002 / 会議 2026-09-01 / 2026-09-01)',
    '### 注意点',
    '- **現金**: 小口現金は月末にまとめて計上(K0001 / 会議 2026-09-01 / 2026-09-01)',
    '### その他',
    '- カテゴリが一覧に無いものはその他へ(K0005 / 手入力 / 2026-09-02)',
    '',
  ].join('\n'));
  assert.match(body, /## 未確認\(参考\)\n### 仕訳ルール\n- \*\*車両\*\*: リース料は賃借料\(K0003/);
  assert.doesNotMatch(body, /K0004|旧ルール/);
  assert.match(body, /## 未回答の質問\n- Q0001 \[関与先\] 10万円の出金の内容は？\n- Q0002 \[事務所内\] 固定資産の判定を税理士に確認\n- Q0004 \[関与先\] 宛先空欄の質問\n/);
  assert.match(body, /## 未完了のタスク\n- T0001: \[事務所\] 9月分の記帳\n$/);
  assert.doesNotMatch(body, /Q0003|T0002/);
});

test('ノート: 要点・未確認の件数・質問・タスク・次回MTG・リンク', () => {
  const t = ask(load(), 'ノート 1234-5678');
  assert.match(t, /^\*株式会社サンプル商事\(1234-5678\)\* 法人/);
  assert.match(t, /<https:\/\/docs\.google\.com\/spreadsheets\/d\/NOTE1\/edit\|関与先ノート>/);
  assert.match(t, /次回MTG: 2026-11-02/);
  assert.match(t, /\*カルテ\(確認済\)\(3件\)\*/);
  assert.match(t, /未確認のカルテ 1件/);
  assert.match(t, /\*未回答の質問\(3件\)\*/);
  assert.match(t, /\*未完了のタスク\(1件\)\*\n• T0001: \[事務所\] 9月分の記帳/);
});

test('質問: 関与先あてと事務所内に分ける', () => {
  const t = ask(load(), '質問 サンプル商事');
  const [client, office] = t.split('*事務所内');
  assert.match(client, /Q0001/);
  assert.match(client, /Q0004/);
  assert.doesNotMatch(client, /Q0002/);
  assert.match(office, /Q0002/);
});

test('探し方: 一部一致・株式会社の有無・全角・複数・該当なし', () => {
  const api = load();
  assert.match(ask(api, 'ノート ｻﾝﾌﾟﾙ商事'), /株式会社サンプル商事/);
  assert.match(ask(api, 'ノート サンプル'), /複数あります/);
  assert.match(ask(api, 'ノート 存在しない'), /見つかりません/);
  assert.match(ask(api, 'ノート'), /関与先名を付けてください/);
  assert.match(ask(api, 'こんにちは'), /^議事録システムです/);
  // スプレッドシートIDの無い行は探さない
  assert.match(ask(api, 'ノート ID未登録'), /見つかりません/);
});

test('情報の扱い: 外部可スペース・スペース不明・ドメイン外・権限なしには出さない', () => {
  const api = load();
  assert.match(ask(api, 'ノート サンプル商事', { space: { name: 'spaces/X', externalUserAllowed: true } }), /外部ユーザーが参加できるスペース/);
  assert.match(ask(api, 'ノート サンプル商事', { space: undefined }), /スペースの情報が分からない/);
  assert.match(api.onAddToSpace({ space: { externalUserAllowed: true } }).text, /外部ユーザー/);
  const d = load({ MASTER_SS_ID: 'MASTER', ALLOWED_DOMAIN: 'example.co.jp' });
  assert.match(ask(d, 'ノート サンプル商事', { user: { email: 'x@gmail.com' } }), /事務所のアカウント以外/);
  assert.match(ask(d, 'ノート サンプル商事'), /株式会社サンプル商事/);
  assert.match(ask(api, 'ノート 山田太郎'), /^エラー: 「山田太郎」の関与先ノートを開けません/);
});

test('設定・古いノート', () => {
  assert.match(ask(load({}), 'ノート サンプル'), /MASTER_SS_ID/);
  assert.match(ask(load({ MASTER_SS_ID: 'https://docs.google.com/spreadsheets/d/MASTER/edit#gid=0' }), 'ノート 1234-5678'), /サンプル商事/);
  assert.match(ask(load(), 'ノート 古いノート'), /古い形です\(質問票に宛先の列が無い\)/);
  assert.match(ask(load(), 'ノート サンプル工業'), /\*カルテ\(確認済\)\*: なし/);
});
