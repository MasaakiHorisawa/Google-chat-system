/**
 * Google Chat 仕訳アシスタント：設定
 *
 * シート名・列名・選択肢をここにまとめています。
 * 運用中に変えたい値（モデル、取得件数、事務所の方針など）はコードではなく「設定」シートで変更してください。
 *
 * 認証情報はコードにもシートにも書かず、スクリプトプロパティに入れます（README の「初期設定」参照）。
 *   ANTHROPIC_API_KEY    : Claude API キー
 *   SERVICE_ACCOUNT_JSON : Chat アプリ用サービスアカウントの鍵（JSON 全体）
 *   SHEET_ID             : 管理用スプレッドシートのID（setup() が自動で入れる）
 *   MF_API_KEY_01 など   : マネーフォワード クラウド会計の APIキー（名前は「事業者」シートで指定）
 */

const APP = {
  SHEETS: {
    SETTINGS: '設定',
    OFFICES: '事業者',
    SPACES: 'スペース',
    RULES: '仕訳ルール',
    PROPOSALS: '仕訳案',
    QUESTIONS: '質問',
    JOBS: 'ジョブ',
  },
  PROP_SHEET_ID: 'SHEET_ID',
  PROP_ANTHROPIC_KEY: 'ANTHROPIC_API_KEY',
  PROP_SERVICE_ACCOUNT: 'SERVICE_ACCOUNT_JSON',

  ANTHROPIC_URL: 'https://api.anthropic.com/v1/messages',
  ANTHROPIC_VERSION: '2023-06-01',
  // 安全性の判定で回答が拒否されたとき、別モデルで自動的に再実行させるための指定
  FALLBACK_BETA: 'server-side-fallback-2026-07-01',
  FALLBACK_MODELS: ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'],

  // マネーフォワード クラウド会計の MCP サーバー（Claude Code の .mcp.json と同じ接続先）
  MF_MCP_URL: 'https://beta.mcp.developers.biz.moneyforward.com/mcp/ca/v3',

  CHAT_API: 'https://chat.googleapis.com/v1',
  CHAT_SCOPE: 'https://www.googleapis.com/auth/chat.bot',

  JOB_TRIGGER_HANDLER: 'runJobs',
  MAX_JOBS_PER_RUN: 10, // 1回の実行で処理するジョブ数（GASの6分制限対策）
  MAX_IMAGE_BYTES: 5 * 1024 * 1024, // Claude に渡せる画像の上限（5MB）
  MASTER_CACHE_SEC: 6 * 60 * 60, // 勘定科目・税区分の一覧を覚えておく時間
};

// 列は「列名」で探すので、シート上で列の順番を入れ替えても動きます
const OFFICE_COLS = ['事業者名', '事業者番号', 'APIキー名', 'メモ'];
const SPACE_COLS = ['スペース', 'スペース名', '事業者名', '設定者', '設定日時'];
const RULE_COLS = ['事業者名', 'ルール', '登録者', '登録日時'];
const PROPOSAL_COLS = [
  '案ID', '状態', '種類', '事業者名', 'スペース', 'スレッド', 'メッセージ', '内容', '依頼者', '承認者', 'MF結果', '作成日時', '更新日時',
];
const QUESTION_COLS = ['質問ID', '事業者名', '宛先', '質問', '理由', '状態', '案ID', '登録者', '作成日時'];
const JOB_COLS = ['ジョブID', '状態', '種類', 'スペース', 'スレッド', '依頼者', '入力', '結果', '作成日時', '更新日時'];

const PROPOSAL_STATUSES = ['案', '登録済', '却下', '差し替え', 'エラー'];
const QUESTION_STATUSES = ['未まとめ', 'まとめ済'];
const JOB_STATUSES = ['待ち', '処理中', '完了', 'エラー'];

// 「設定」シートの初期値：[項目, 値, 説明]
const DEFAULT_SETTINGS = [
  ['モデル', 'claude-opus-5-5', 'Claude のモデルID。速さを優先するなら claude-sonnet-5-5'],
  ['effort', 'low', 'low / medium / high。low で時間切れになりにくい'],
  ['未仕訳の取得件数', '20', '「/未仕訳」で1回に仕訳案を作る明細の数（多いと時間切れになりやすい）'],
  ['事務所の方針', [
    '- 税込経理。金額は税込で入れる',
    '- 迷う取引は無理に決めず、confidence を low にして確認事項に理由を書く',
    '- 摘要は「取引先名 内容」の形にする',
  ].join('\n'), 'すべての事業者に共通する仕訳の方針。AI に渡す。1行1項目'],
];
