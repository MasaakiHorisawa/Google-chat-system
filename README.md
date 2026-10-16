# Google-chat-system

Google Chat アプリ。議事録システムの「関与先ノート」を読んで返す(段階1: 読むだけ)。

| コマンド | 返すもの |
|---|---|
| `ノート 関与先名` | カルテ(確認済)の要点、未確認カルテの件数、未回答の質問、未完了のタスク、次回MTG日、ノートへのリンク |
| `質問 関与先名` | 未回答の質問(関与先あて/事務所内に分けて) |
| `ルール 関与先名` | Claude に渡す「関与先ルール」Markdown(MF 作業用の Claude に貼る) |

関与先名は一部だけでもよい(株式会社の有無・全角半角・空白は無視)。MF コードでも探せる。スペースでは @メンション を付ける。

## 構成

```
gas/
  appsscript.json  … スコープは spreadsheets.readonly のみ。"chat": {} で Chat アプリにする
  Chat.gs          … Chat の入口(onMessage など)、マスタ・ノートを「読むだけ」で開く部分
  Shared.gs        … 自動生成。議事録システム Code.gs から写した関数(関与先ルール Markdown など)。手で直さない
tools/sync.js      … Shared.gs と議事録システムの Code.gs が一致するか確認/写し直す
test/              … Node で動かす確認(Apps Script のサービスは偽物)
docs/              … セットアップ手順、議事録システム側への連絡
```

### 議事録システムとの関係
- 「関与先ルール」Markdown は、議事録システムのパネルの「Claudeにルールを渡す」と同じ関数(`clientRulesMd_`)で作る。
  別の Apps Script プロジェクトなので関数を呼び合えないため、**同じソースを写して** `tools/sync.js check` で一致を確かめる。
- 議事録システムの Code.gs を更新したら:
  ```
  node tools/sync.js check <議事録システムの Code.gs>   # 不一致なら
  node tools/sync.js pull  <議事録システムの Code.gs>
  npm test
  ```
- 議事録システムの `openNotebook_` / `getMasterSheet_` はシートを補う(書き込む)ので写さない。Chat 側は `Chat.gs` の読むだけの版を使う。

### 情報の扱い
- 話しかけた人の権限で動く。ノートやマスタを見られない人には何も出ない。
- 外部ユーザーが参加できるスペース、スペースが分からないときは返さない。スクリプト プロパティ `ALLOWED_DOMAIN` を入れると、そのドメイン以外の人にも返さない。
- 書き込み(質問の追加など)はまだ無い。作るときは内容と宛先を見せて確認してから登録する。

## 確認

```
npm test
```

セットアップは [docs/セットアップ.md](docs/セットアップ.md)。
