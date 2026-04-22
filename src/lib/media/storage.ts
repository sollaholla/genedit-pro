import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'genedit-pro';
const DB_VERSION = 1;
const BLOB_STORE = 'mediaBlobs';

type BlobRecord = {
  key: string;
  blob: Blob;
  name: string;
  mimeType: string;
  createdAt: number;
};

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE, { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

export async function putBlob(key: string, blob: Blob, name: string): Promise<void> {
  const db = await getDb();
  const record: BlobRecord = {
    key,
    blob,
    name,
    mimeType: blob.type || 'application/octet-stream',
    createdAt: Date.now(),
  };
  await db.put(BLOB_STORE, record);
}

export async function getBlob(key: string): Promise<Blob | null> {
  const db = await getDb();
  const record = (await db.get(BLOB_STORE, key)) as BlobRecord | undefined;
  return record?.blob ?? null;
}

export async function deleteBlob(key: string): Promise<void> {
  const db = await getDb();
  await db.delete(BLOB_STORE, key);
}

export async function listBlobKeys(): Promise<string[]> {
  const db = await getDb();
  const keys = await db.getAllKeys(BLOB_STORE);
  return keys.map((k) => String(k));
}
