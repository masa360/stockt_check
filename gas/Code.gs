/**
 * AnimePick-L — Google Apps Script バックエンド
 *
 * 【設定手順】
 * 1. 下の SPREADSHEET_ID を自分のスプレッドシートのIDに書き換える
 * 2. 「デプロイ」→「新しいデプロイ」→「ウェブアプリ」
 *    - 実行ユーザー: 自分
 *    - アクセス: 全員（匿名ユーザーを含む）
 * 3. 発行されたURLを liff/index.html の CONFIG.GAS_URL に貼る
 */

// ----------------------------------------------------------------
// 設定値（ここだけ変更してください）
// ----------------------------------------------------------------
const SPREADSHEET_ID = '1Hhlag8FWv86jETmLcyrxdtvOOx5LvhG67vLoN6cuZ4U'; // 本番スプレッドシートID（固定）

const SHEET_MASTER = '商品マスタ';
const SHEET_ORDERS = '指示書';
const SHEET_LOGS   = '作業ログ';

/**
 * 初回セットアップ（手動実行）
 *
 * Apps Script エディタで `setupSheets()` を1回実行すると、
 * 必要シート・ヘッダー・サンプルデータを自動作成します。
 */
function setupSheets() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // 必要シートを準備
  const master = getOrCreateSheet(ss, SHEET_MASTER);
  const orders = getOrCreateSheet(ss, SHEET_ORDERS);
  const logs   = getOrCreateSheet(ss, SHEET_LOGS);

  // ヘッダー定義
  const masterHeaders = ['JANコード', '商品名', '画像URL', '棚番', '単重(g)', '更新日時', '更新者'];
  const orderHeaders  = ['注文ID', 'JANコード', '商品名', '必要数', '完了数', 'ステータス', '最終更新日時', '最終更新者'];
  const logHeaders    = ['日時', 'LINE名', 'LINEユーザーID', 'アクション', 'JANコード', '注文ID', '結果', '備考'];

  setHeaderRow(master, masterHeaders);
  setHeaderRow(orders, orderHeaders);
  setHeaderRow(logs, logHeaders);

  // 空シートならサンプル投入（既存データは上書きしない）
  if (master.getLastRow() === 1) {
    master.getRange(2, 1, 2, 7).setValues([
      ['4901234567890', 'リゼロ レムフィギュア', '', 'A-03', 200, new Date(), 'setup'],
      ['4901234567891', '鬼滅の刃 炭治郎アクスタ', '', 'B-07', 80,  new Date(), 'setup'],
    ]);
  }

  if (orders.getLastRow() === 1) {
    orders.getRange(2, 1, 2, 8).setValues([
      ['ORD001', '4901234567890', '', 3, 0, '未', '', ''],
      ['ORD001', '4901234567891', '', 2, 0, '未', '', ''],
    ]);
  }

  SpreadsheetApp.flush();
  return 'セットアップ完了: 商品マスタ / 指示書 / 作業ログ を作成しました';
}

// ----------------------------------------------------------------
// エントリポイント（GET / POST 共通）
// ----------------------------------------------------------------
function doGet(e) {
  return handleRequest(e.parameter || {});
}

function doPost(e) {
  // POST body (JSON) と URL パラメータの両方を受け付ける
  let params = e.parameter || {};
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    params = Object.assign({}, params, body);
  } catch (_) {}
  return handleRequest(params);
}

function handleRequest(p) {
  try {
    const result = route(p);
    return jsonResponse(result);
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

// ----------------------------------------------------------------
// 指示書取得（商品マスタをJOINして返す）
// ----------------------------------------------------------------
function getPickingList() {
  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  const orders = sheetToObjects(ss.getSheetByName(SHEET_ORDERS));
  const master = sheetToObjects(ss.getSheetByName(SHEET_MASTER));

  // 商品マスタをJANで索引化（高速検索用）
  const masterMap = {};
  master.forEach(p => { masterMap[String(p['JANコード'])] = p; });

  // 指示書に商品マスタ情報をマージして返す
  const result = orders.map(order => {
    const jan  = String(order['JANコード'] || '');
    const prod = masterMap[jan] || {};
    return {
      注文ID:       order['注文ID']       || '',
      JANコード:    jan,
      商品名:       prod['商品名']        || order['商品名']  || '（未登録）',
      画像URL:      prod['画像URL']       || '',
      棚番:         prod['棚番']          || '',
      必要数:       Number(order['必要数'])  || 0,
      完了数:       Number(order['完了数'])  || 0,
      ステータス:   order['ステータス']    || '未',
    };
  });

  return { success: true, data: result };
}

// ----------------------------------------------------------------
// ピッキング処理（排他制御つき楽観ロック）
// ----------------------------------------------------------------
function pickItem(p) {
  const jan      = String(p.jan      || '').trim();
  const orderId  = String(p.orderId  || '').trim();
  const userName = String(p.userName || '').trim();

  if (!jan) throw new Error('JANコードが指定されていません');

  const lock = LockService.getScriptLock();
  lock.waitLock(10_000); // 最大10秒待機（他プロセスの完了を待つ）

  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheetByName(SHEET_ORDERS);
    const data  = sheet.getDataRange().getValues();
    const h     = buildHeaderIndex(data);

    // ステータスが「済」でなく、JANと注文IDが一致する最初の行を探す
    let rowIdx = -1;
    for (let i = 1; i < data.length; i++) {
      const rowJan    = String(data[i][h['JANコード']]  || '');
      const rowOrder  = String(data[i][h['注文ID']]     || '');
      const rowStatus = String(data[i][h['ステータス']] || '');

      if (rowJan !== jan) continue;
      if (orderId && rowOrder !== orderId) continue;

      // ロック取得後に再確認（他プロセスが先に完了した場合）
      if (rowStatus === '済') {
        return {
          success: false,
          error:   'already_completed',
          message: '既にピッキング済みです（別端末で完了済）',
        };
      }
      rowIdx = i;
      break;
    }

    if (rowIdx === -1) {
      return {
        success: false,
        error:   'not_found',
        message: '指示書に対象商品が見つかりません（JAN: ' + jan + '）',
      };
    }

    const required  = Number(data[rowIdx][h['必要数']])  || 0;
    const completed = Number(data[rowIdx][h['完了数']]) + 1;
    const newStatus = completed >= required ? '済' : '作業中';
    const now       = new Date();
    const r         = rowIdx + 1; // シートは1-indexed

    sheet.getRange(r, h['完了数']       + 1).setValue(completed);
    sheet.getRange(r, h['ステータス']   + 1).setValue(newStatus);
    sheet.getRange(r, h['最終更新日時'] + 1).setValue(now);
    sheet.getRange(r, h['最終更新者']   + 1).setValue(userName);

    return {
      success: true,
      data: { completed, required, status: newStatus },
    };

  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------------
// 作業ログ記録
// ----------------------------------------------------------------
function addLog(p) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(SHEET_LOGS);

  sheet.appendRow([
    new Date(),                         // 日時
    p.userName    || '',                // LINE名
    p.userId      || '',                // LINEユーザーID
    p.action_type || p.action || '',    // アクション（duplicate_jan_approved など）
    p.jan         || '',                // JANコード
    p.orderId     || '',                // 注文ID
    p.result      || '',                // 成功 / 失敗
    p.note        || '',                // 備考
  ]);

  return { success: true };
}

// ----------------------------------------------------------------
// 商品マスタ検索（JAN → 商品情報）
// ----------------------------------------------------------------
function getProduct(jan) {
  if (!jan) throw new Error('JANコードが必要です');

  const ss     = SpreadsheetApp.openById(SPREADSHEET_ID);
  const master = sheetToObjects(ss.getSheetByName(SHEET_MASTER));
  const found  = master.find(p => String(p['JANコード']) === String(jan));

  return found
    ? { success: true,  data: found }
    : { success: false, error: 'not_found' };
}

// ----------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------

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

/** 1行目にヘッダーをセット（既存ヘッダーと違う場合のみ更新） */
function setHeaderRow(sheet, headers) {
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const same = headers.every((h, i) => String(current[i] || '') === h);
  if (!same) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
}
