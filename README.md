# AnimePick-L

倉庫作業補助LINEアプリ（MVP版）のソースコード一式です。

## フォルダ構成

```
AnimePick-L/
├── liff/
│   └── index.html          ← LIFFフロントエンド（これをサーバーに置く）
├── gas/
│   └── Code.gs             ← GASバックエンド（これをApps Scriptに貼る）
├── setup/
│   └── スプレッドシート設定.md ← セットアップ手順書
└── docs/
    └── 要件定義書_完全版.md
```

## はじめに

**`setup/スプレッドシート設定.md` を最初に読んでください。**  
STEP 1〜11 の順番に進めれば、初めての方でも動作確認まで完了できます。

## 今回の運用方針

- シート作成は手動ではなく、GAS の `setupSheets()` 実行で自動作成
- LIFFフロントは GitHub + Vercel で公開
- GASはウェブアプリとしてデプロイして API 化

## MVPで実装済みの機能

- LINEログイン（ユーザーID・表示名の自動取得）
- 当日出荷リストの表示（進捗バー付き）
- JANバーコードスキャン（カメラ）
- スキャン照合 → 完了数・ステータス自動更新
- 同一JAN連続スキャン警告（10秒窓）＋承認/キャンセル
- 再試行ボタン（上限3回、超過時は手入力誘導）
- 全操作の監査ログ自動記録（duplicate_jan_approved/canceled 含む）
- 開発用モック（LIFF IDとGAS URLが未設定でもダミーデータで動作確認可）

## 設定が必要な2箇所

`liff/index.html` の先頭付近：

```javascript
const CONFIG = {
  LIFF_ID: 'YOUR_LIFF_ID',        // LINE DevelopersのLIFF IDに変更
  GAS_URL: 'YOUR_GAS_WEBAPP_URL', // GASデプロイ後のURLに変更
  ...
};
```

`gas/Code.gs` の先頭付近：

```javascript
const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID'; // スプレッドシートのIDに変更
```

