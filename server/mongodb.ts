import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';

export const MONGODB_DB_NAME = 'campuswasteDB';

export class DbConfigError extends Error {
  statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = 'DbConfigError';
    this.statusCode = 503;
  }
}

interface MongoCache {
  client: MongoClient | null;
  db: Db | null;
  promise: Promise<{ client: MongoClient; db: Db }> | null;
  indexesPromise: Promise<void> | null;
  indexesEnsured: boolean;
  uri: string | null;
}

const globalForMongo = globalThis as unknown as {
  __campusWasteMongoCache?: MongoCache;
};

const cache: MongoCache =
  globalForMongo.__campusWasteMongoCache ??
  (globalForMongo.__campusWasteMongoCache = {
    client: null,
    db: null,
    promise: null,
    indexesPromise: null,
    indexesEnsured: false,
    uri: null,
  });

async function ensureIndexes(db: Db): Promise<void> {
  if (cache.indexesEnsured) return;
  if (!cache.indexesPromise) {
    cache.indexesPromise = (async () => {
      await Promise.all([
        db.collection('locations').createIndex({ locationCode: 1 }, { unique: true }),
        db.collection('locations').createIndex({ isActive: 1, locationCode: 1 }),
        db.collection('wasteReports').createIndex({ reportNo: 1 }, { unique: true }),
        db.collection('wasteReports').createIndex({ reportedAt: -1 }),
        db.collection('wasteReports').createIndex({ status: 1, reportedAt: -1 }),
        db.collection('wasteReports').createIndex({ status: 1, wasteType: 1, reportedAt: -1 }),
        db.collection('wasteReports').createIndex({ locationId: 1, status: 1, reportedAt: -1 }),
        db.collection('collectionTasks').createIndex({ taskNo: 1 }, { unique: true }),
        db.collection('collectionTasks').createIndex({ reportId: 1 }),
        db.collection('collectionTasks').createIndex({ status: 1, scheduledDate: -1 }),
        db.collection('collectionTasks').createIndex({ createdAt: -1 }),
        db.collection('recyclingRecords').createIndex({ recordNo: 1 }, { unique: true }),
        db.collection('recyclingRecords').createIndex({ taskId: 1 }),
        db.collection('recyclingRecords').createIndex({ materialType: 1, processedDate: -1 }),
      ]);
      cache.indexesEnsured = true;
    })().catch((err) => {
      cache.indexesPromise = null;
      throw err;
    });
  }
  await cache.indexesPromise;
}

export function isMongoUriConfigured(): boolean {
  const uri = process.env.MONGODB_URI?.trim() || '';
  return Boolean(
    uri &&
      !uri.includes('<username>') &&
      !uri.includes('<password>') &&
      !uri.includes('<cluster>')
  );
}

/**
 * Connects to MongoDB Atlas using process.env.MONGODB_URI and targets `campuswasteDB`.
 * Caches the MongoClient and Db instance on globalThis across requests to avoid opening
 * duplicate connections.
 */
export async function getMongoDatabase(): Promise<Db> {
  const uri = process.env.MONGODB_URI?.trim() || '';
  if (!isMongoUriConfigured()) {
    throw new DbConfigError(
      'MONGODB_URI is not configured. Set MONGODB_URI in your environment secrets to connect to MongoDB Atlas (campuswasteDB).'
    );
  }

  if (cache.uri && cache.uri !== uri) {
    const prevClient = cache.client;
    cache.client = null;
    cache.db = null;
    cache.promise = null;
    cache.indexesEnsured = false;
    cache.indexesPromise = null;
    cache.uri = null;
    if (prevClient) {
      await prevClient.close().catch(() => {});
    }
  }

  if (cache.db && cache.client) {
    await ensureIndexes(cache.db);
    return cache.db;
  }

  if (!cache.promise) {
    cache.uri = uri;
    const client = new MongoClient(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 8000,
    });

    cache.promise = client
      .connect()
      .then((connectedClient) => {
        const db = connectedClient.db(MONGODB_DB_NAME);
        cache.client = connectedClient;
        cache.db = db;
        return { client: connectedClient, db };
      })
      .catch((err) => {
        cache.promise = null;
        cache.client = null;
        cache.db = null;
        cache.uri = null;
        throw err;
      });
  }

  const { db } = await cache.promise;
  await ensureIndexes(db);
  return db;
}
