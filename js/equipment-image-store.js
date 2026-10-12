// 備品の画像を端末に保存して使い回す（転送量の対策）
//   ・鍵は画像の場所（items/<uuid>.<拡張子>）。期限付きURLは毎回変わるので鍵にしない。
//     画像を差し替えると新しい uuid のファイルになるため、同じ鍵の中身が変わることは無い
//   ・保存先は Cache Storage（equipment-images-v1）。使えなければ IndexedDB（aichi-equipment-images）。
//     どちらも使えない（プライベートブラウズなど）ときは openImageStore が null を返し、画面は今までどおり期限付きURLで表示する
//   ・表示には blob: のURLを使う（ページを開いている間だけ持つ）
//   ・ログアウトのとき（js/auth.js の googleLogout）に clearEquipmentImageStore で全部消す
// どの関数も例外を外に出さない（保存先の失敗で画面の表示・ログアウトを止めないため）

const CACHE_NAME = 'equipment-images-v1';
const DB_NAME = 'aichi-equipment-images';
const DB_STORE = 'images';
// Cache Storage の鍵にする、同じサイト内の架空のURL（実際にはアクセスしない）
const CACHE_KEY_PREFIX = '/__equipment-image-cache/';
const CLEAR_TIMEOUT_MS = 3000;

let storePromise = null; // { kind: 'cache', cache } | { kind: 'idb', db } | null
let storeCleared = false; // ログアウトで消したあとは、もう保存しない
const objectUrls = new Map(); // 画像の場所 → blob: のURL

function cacheKeyOf(path) {
  return new URL(CACHE_KEY_PREFIX + path, location.origin).href;
}

function pathOfCacheKey(url) {
  const { pathname } = new URL(url);
  return pathname.startsWith(CACHE_KEY_PREFIX) ? pathname.slice(CACHE_KEY_PREFIX.length) : null;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => {
      const db = req.result;
      // ほかのタブがログアウトで消そうとしたら、閉じて消すのを妨げない
      db.onversionchange = () => {
        db.close();
        storePromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

async function openStoreInner() {
  try {
    if (typeof caches !== 'undefined') {
      return { kind: 'cache', cache: await caches.open(CACHE_NAME) };
    }
  } catch (err) {
    console.warn('Cache Storage is not available:', err);
  }
  try {
    if (typeof indexedDB !== 'undefined') {
      return { kind: 'idb', db: await openDb() };
    }
  } catch (err) {
    console.warn('IndexedDB is not available:', err);
  }
  return null;
}

// 保存先を開く（1回だけ。2回目からは同じものを返す）。使えなければ null
export function openImageStore() {
  if (storeCleared) return Promise.resolve(null);
  if (!storePromise) storePromise = openStoreInner();
  return storePromise;
}

// IndexedDB の1つのトランザクションで fn(objectStore) を行い、その要求の結果を返す
function idbRun(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, mode);
    const req = fn(tx.objectStore(DB_STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// 保存してある画像（Blob）を返す。無い・読めなければ null
export async function readStoredImage(store, path) {
  try {
    if (store.kind === 'cache') {
      const res = await store.cache.match(cacheKeyOf(path));
      return res ? await res.blob() : null;
    }
    const blob = await idbRun(store.db, 'readonly', (os) => os.get(path));
    return blob instanceof Blob ? blob : null;
  } catch (err) {
    console.warn('readStoredImage failed:', err);
    return null;
  }
}

// 画像を保存する。保存できたら true（容量不足などで失敗したら false）
export async function writeStoredImage(store, path, blob) {
  if (storeCleared) return false;
  try {
    if (store.kind === 'cache') {
      await store.cache.put(
        cacheKeyOf(path),
        new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } })
      );
    } else {
      await idbRun(store.db, 'readwrite', (os) => os.put(blob, path));
    }
    return true;
  } catch (err) {
    console.warn('writeStoredImage failed:', err);
    return false;
  }
}

export async function deleteStoredImage(store, path) {
  try {
    if (store.kind === 'cache') {
      await store.cache.delete(cacheKeyOf(path));
    } else {
      await idbRun(store.db, 'readwrite', (os) => os.delete(path));
    }
  } catch (err) {
    console.warn('deleteStoredImage failed:', err);
  }
}

// 保存してある画像の場所の一覧
export async function listStoredImagePaths(store) {
  try {
    if (store.kind === 'cache') {
      const keys = await store.cache.keys();
      return keys.map((req) => pathOfCacheKey(req.url)).filter(Boolean);
    }
    const keys = await idbRun(store.db, 'readonly', (os) => os.getAllKeys());
    return (keys || []).filter((key) => typeof key === 'string');
  } catch (err) {
    console.warn('listStoredImagePaths failed:', err);
    return [];
  }
}

// ===================== 表示用の blob: のURL =====================

export function imageObjectUrlOf(path) {
  return objectUrls.get(path) || null;
}

// Blob から blob: のURLを作って覚える（すでにあれば、それを返す）
export function setImageObjectUrl(path, blob) {
  const existing = objectUrls.get(path);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  objectUrls.set(path, url);
  return url;
}

export function revokeImageObjectUrl(path) {
  const url = objectUrls.get(path);
  if (!url) return;
  URL.revokeObjectURL(url);
  objectUrls.delete(path);
}

export function imageObjectUrlPaths() {
  return [...objectUrls.keys()];
}

// ===================== ログアウトのときの削除 =====================

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
}

async function deleteCacheStorage() {
  try {
    if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME);
  } catch (err) {
    console.warn('caches.delete failed:', err);
  }
}

function deleteDatabase() {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve();
        return;
      }
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      // ほかのタブが開いたままのときは、そのタブが閉じたあとに消える（待たない）
      req.onblocked = () => resolve();
    } catch (err) {
      console.warn('indexedDB.deleteDatabase failed:', err);
      resolve();
    }
  });
}

// 端末の画像の保存分（Cache Storage・IndexedDB の両方）と blob: のURLを全部消す。
// 例外は出さず、長くても数秒で戻る（失敗してもログアウトを止めないため）
export async function clearEquipmentImageStore() {
  storeCleared = true;
  for (const path of [...objectUrls.keys()]) revokeImageObjectUrl(path);
  const opened = storePromise;
  storePromise = null;
  try {
    const store = await withTimeout(opened || Promise.resolve(null), CLEAR_TIMEOUT_MS);
    if (store && store.kind === 'idb') store.db.close(); // 自分の接続を閉じないと削除が待たされる
  } catch (err) {
    console.warn(err);
  }
  await withTimeout(Promise.all([deleteCacheStorage(), deleteDatabase()]), CLEAR_TIMEOUT_MS);
}
