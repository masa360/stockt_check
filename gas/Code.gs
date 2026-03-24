/**
 * AnimePick-L — Google Apps Script バックエンド
 *
 * 【初回セットアップ手順】
 * 1. setupSheets()  を実行 → シートと雛形を自動作成
 * 2. 「商品生データ」シートにExcelをコピペ（1行目はヘッダー行のまま）
 * 3. importMasterFromRaw() を実行 → 「商品マスタ」に自動変換
 * 4. 「指示書」シートに当日の出荷指示を入力
 * 5. デプロイ → liff/index.html の CONFIG.GAS_URL に貼る
 */

// ================================================================
// 設定（変更不要）
// ================================================================
const SPREADSHEET_ID = '1Hhlag8FWv86jETmLcyrxdtvOOx5LvhG67vLoN6cuZ4U';

const SHEET_MASTER  = '商品マスタ';
const SHEET_ORDERS  = '指示書';
const SHEET_LOGS    = '作業ログ';
const SHEET_RAW     = '商品生データ';  // Excelをそのままペーストするシート

// ================================================================
// 初回セットアップ（1回だけ実行）
// ================================================================
function setupSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // ── 商品マスタ（拡張版） ────────────────────────────────────
  const master = getOrCreateSheet(ss, SHEET_MASTER);
  setHeaderRow(master, [
    'JANコード',   // A: 検索キー（一意）
    '商品名',      // B: LIFF表示用
    '画像URL',     // C: LIFF商品画像
    '棚番',        // D: ナビ用
    '単重(g)',     // E: 返品カウント用
    'カテゴリ',    // F: 分類
    'メーカー',    // G: ブランド
    '定価(税込)',  // H: 参考価格
    '在庫数',      // I: 参考在庫（基幹とは別管理）
    '更新日時',    // J
    '更新者',      // K
  ]);

  // ── 指示書 ─────────────────────────────────────────────────
  const orders = getOrCreateSheet(ss, SHEET_ORDERS);
  setHeaderRow(orders, [
    '注文ID', 'JANコード', '商品名', '必要数', '完了数',
    'ステータス', '最終更新日時', '最終更新者',
  ]);

  // ── 作業ログ ────────────────────────────────────────────────
  const logs = getOrCreateSheet(ss, SHEET_LOGS);
  setHeaderRow(logs, [
    '日時', 'LINE名', 'LINEユーザーID', 'アクション',
    'JANコード', '注文ID', '結果', '備考',
  ]);

  // ── 商品生データ（Excelをそのままペーストするシート） ──────
  const raw = getOrCreateSheet(ss, SHEET_RAW);
  setHeaderRow(raw, [
    'カテゴリ', 'メーカー', 'JAN', '商品名',
    '仕入価格(税抜)', '仕入価格(税込)', '掛率', '在庫',
  ]);

  // ── サンプル指示書（空なら投入） ────────────────────────────
  if (orders.getLastRow() === 1) {
    orders.getRange(2, 1, 2, 8).setValues([
      ['ORD001', '4560351952138', '', 3, 0, '未', '', ''],
      ['ORD001', '4560351953524', '', 2, 0, '未', '', ''],
    ]);
  }

  SpreadsheetApp.flush();
  return '✅ セットアップ完了：商品マスタ / 指示書 / 作業ログ / 商品生データ を作成しました';
}

// ================================================================
// 商品生データ → 商品マスタ 変換（Excelペースト後に1回実行）
// ================================================================
function importMasterFromRaw() {
  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  const rawSh  = ss.getSheetByName(SHEET_RAW);
  const master = ss.getSheetByName(SHEET_MASTER);

  if (!rawSh || rawSh.getLastRow() < 2) {
    throw new Error('「商品生データ」シートにデータがありません。先にExcelをペーストしてください。');
  }

  const rawData = rawSh.getDataRange().getValues();
  const rh      = buildHeaderIndex(rawData); // 生データのヘッダーマップ

  // 既存マスタのJANをセット化（既存データとの重複判定用）
  const masterData  = master.getDataRange().getValues();
  const existingJan = new Set(masterData.slice(1).map(r => String(r[0]).trim()));

  const toAdd    = [];
  const toUpdate = []; // 既存JANは更新
  const now      = new Date();

  rawData.slice(1).forEach(row => {
    const jan = normalizeJan(row[rh['JAN']] || row[rh['JANコード']] || '');
    if (!jan) return; // JAN空行はスキップ

    const record = [
      jan,
      String(row[rh['商品名']] || '').trim(),
      '',           // 画像URL（未設定 → 空欄）
      '未設定',     // 棚番（未設定）
      0,            // 単重(g)（未設定 → 0）
      String(row[rh['カテゴリ']] || '').trim(),
      String(row[rh['メーカー']] || '').trim(),
      String(row[rh['仕入価格(税込)']] || row[rh['定価(税込)']] || '').trim(),
      Number(row[rh['在庫']] || 0),
      now,
      'importMasterFromRaw',
    ];

    if (existingJan.has(jan)) {
      toUpdate.push(record);
    } else {
      toAdd.push(record);
    }
  });

  // 新規追加
  if (toAdd.length > 0) {
    master.getRange(master.getLastRow() + 1, 1, toAdd.length, 11).setValues(toAdd);
  }

  // 既存JAN更新（行番号を探してセル更新）
  if (toUpdate.length > 0) {
    const updMap = {};
    toUpdate.forEach(r => { updMap[r[0]] = r; });
    const mData = master.getDataRange().getValues();
    mData.slice(1).forEach((row, idx) => {
      const jan = String(row[0]).trim();
      if (updMap[jan]) {
        master.getRange(idx + 2, 1, 1, 11).setValues([updMap[jan]]);
      }
    });
  }

  SpreadsheetApp.flush();
  return '✅ 取り込み完了: 追加 ' + toAdd.length + '件 / 更新 ' + toUpdate.length + '件';
}

// ================================================================
// エントリポイント（LIFF → GAS API）
// ================================================================
function doGet(e) {
  return handleRequest(e.parameter || {});
}

function doPost(e) {
  let params = e.parameter || {};
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    params = Object.assign({}, params, body);
  } catch (_) {}
  return handleRequest(params);
}

function handleRequest(p) {
  try {
    return jsonResponse(route(p));
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function route(p) {
  switch (p.action) {
    case 'getPickingList': return getPickingList();
    case 'pickItem':       return pickItem(p);
    case 'addLog':         return addLog(p);
    case 'getProduct':     return getProduct(p.jan);
    default:               throw new Error('不明なアクション: ' + p.action);
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================================================================
// 指示書取得（商品マスタをJOINして返す）
// ================================================================
function getPickingList() {
  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  const orders = sheetToObjects(ss.getSheetByName(SHEET_ORDERS));
  const master = sheetToObjects(ss.getSheetByName(SHEET_MASTER));

  // 商品マスタをJANで索引化
  const masterMap = {};
  master.forEach(p => { masterMap[String(p['JANコード']).trim()] = p; });

  const result = orders.map(order => {
    const jan  = String(order['JANコード'] || '').trim();
    const prod = masterMap[jan] || {};
    return {
      注文ID:      order['注文ID']        || '',
      JANコード:   jan,
      商品名:      prod['商品名']         || order['商品名']  || '（未登録）',
      画像URL:     prod['画像URL']        || '',
      棚番:        prod['棚番']           || '未設定',
      単重g:       Number(prod['単重(g)']) || 0,
      カテゴリ:    prod['カテゴリ']       || '',
      メーカー:    prod['メーカー']       || '',
      定価:        prod['定価(税込)']     || '',
      必要数:      Number(order['必要数'])  || 0,
      完了数:      Number(order['完了数'])  || 0,
      ステータス:  order['ステータス']    || '未',
    };
  });

  return { success: true, data: result };
}

// ================================================================
// ピッキング処理（排他制御つき）
// ================================================================
function pickItem(p) {
  const jan      = String(p.jan      || '').trim();
  const orderId  = String(p.orderId  || '').trim();
  const userName = String(p.userName || '').trim();

  if (!jan) throw new Error('JANコードが指定されていません');

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_ORDERS);
    const data  = sheet.getDataRange().getValues();
    const h     = buildHeaderIndex(data);

    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      const rowJan    = String(data[i][h['JANコード']]  || '').trim();
      const rowOrder  = String(data[i][h['注文ID']]     || '').trim();
      const rowStatus = String(data[i][h['ステータス']] || '');

      if (rowJan !== jan) continue;
      if (orderId && rowOrder !== orderId) continue;

      if (rowStatus === '済') {
        return { success: false, error: 'already_completed', message: '既にピッキング済みです（別端末で完了済）' };
      }
      rowIdx = i;
      break;
    }

    if (rowIdx === -1) {
      return { success: false, error: 'not_found', message: '指示書に対象商品が見つかりません（JAN: ' + jan + '）' };
    }

    const required  = Number(data[rowIdx][h['必要数']])  || 0;
    const completed = Number(data[rowIdx][h['完了数']]) + 1;
    const newStatus = completed >= required ? '済' : '作業中';
    const now       = new Date();
    const r         = rowIdx + 1;

    sheet.getRange(r, h['完了数']       + 1).setValue(completed);
    sheet.getRange(r, h['ステータス']   + 1).setValue(newStatus);
    sheet.getRange(r, h['最終更新日時'] + 1).setValue(now);
    sheet.getRange(r, h['最終更新者']   + 1).setValue(userName);

    return { success: true, data: { completed, required, status: newStatus } };

  } finally {
    lock.releaseLock();
  }
}

// ================================================================
// 作業ログ記録
// ================================================================
function addLog(p) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_LOGS);

  sheet.appendRow([
    new Date(),
    p.userName    || '',
    p.userId      || '',
    p.action_type || p.action || '',
    p.jan         || '',
    p.orderId     || '',
    p.result      || '',
    p.note        || '',
  ]);

  return { success: true };
}

// ================================================================
// 商品マスタ検索（JAN → 商品詳細）
// ================================================================
function getProduct(jan) {
  if (!jan) throw new Error('JANコードが必要です');

  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  const master = sheetToObjects(ss.getSheetByName(SHEET_MASTER));
  const found  = master.find(p => String(p['JANコード']).trim() === String(jan).trim());

  return found
    ? { success: true,  data: found }
    : { success: false, error: 'not_found' };
}

// ================================================================
// ユーティリティ
// ================================================================

/** シートの全データをオブジェクト配列に変換する */
function sheetToObjects(sheet) {
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const colNames = data[0];
  return data.slice(1).map(row => {
    const obj = {};
    colNames.forEach((name, i) => { obj[name] = row[i]; });
    return obj;
  });
}

/** ヘッダー行から「列名 → 0-indexed列番号」のマップを生成する */
function buildHeaderIndex(data) {
  const map = {};
  (data[0] || []).forEach((name, i) => { map[name] = i; });
  return map;
}

/** シートが無ければ作成して返す */
function getOrCreateSheet(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/** 1行目にヘッダーをセット（内容が変わった場合のみ更新） */
function setHeaderRow(sheet, headers) {
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const same    = headers.every((h, i) => String(current[i] || '') === h);
  if (!same) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#1e3a5f')
      .setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
}

/**
 * JANコードを正規化する
 * - 前後の空白・引用符・'を除去
 * - 数字のみ13桁を期待（8桁EANも許容）
 */
function normalizeJan(raw) {
  const cleaned = String(raw).replace(/['\s"]/g, '').trim();
  return /^\d{8,14}$/.test(cleaned) ? cleaned : '';
}
