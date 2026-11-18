import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbConfigError, MONGODB_DB_NAME, getMongoDatabase, isMongoUriConfigured } from './server/mongodb.ts';
import {
  BusinessRuleError,
  cancelCollectionTask,
  completeCollectionTask,
  createCollectionTask,
  createLocation,
  createRecyclingRecord,
  createWasteReport,
  deleteCollectionTask,
  deleteLocation,
  deleteRecyclingRecord,
  deleteWasteReport,
  getBootstrapData,
  listCollectionTasks,
  listLocations,
  listRecyclingRecords,
  queryWasteReports,
  rejectOrCancelReport,
  seedSampleData,
  startCollectionTask,
  updateCollectionTask,
  updateLocation,
  updateRecyclingRecord,
  updateWasteReport,
} from './server/waste-service.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Health & DB connectivity check
  app.get(
    '/api/health',
    asyncHandler(async (_req, res) => {
      if (!isMongoUriConfigured()) {
        res.status(503).json({
          ok: false,
          configured: false,
          database: MONGODB_DB_NAME,
          error:
            'MONGODB_URI is not configured. Set MONGODB_URI in your environment secrets to connect to MongoDB Atlas (campuswasteDB).',
        });
        return;
      }

      try {
        const db = await getMongoDatabase();
        await db.command({ ping: 1 });
        res.json({
          ok: true,
          configured: true,
          database: MONGODB_DB_NAME,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(503).json({
          ok: false,
          configured: true,
          database: MONGODB_DB_NAME,
          error: `MongoDB Atlas connection failed: ${msg}`,
        });
      }
    })
  );

  // Full bootstrap payload for all 4 collections
  app.get(
    '/api/bootstrap',
    asyncHandler(async (_req, res) => {
      const db = await getMongoDatabase();
      const data = await getBootstrapData(db);
      res.json(data);
    })
  );

  // Locations CRUD
  app.get(
    '/api/locations',
    asyncHandler(async (_req, res) => {
      const db = await getMongoDatabase();
      res.json({ items: await listLocations(db) });
    })
  );

  app.post(
    '/api/locations',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const created = await createLocation(db, req.body);
      res.status(201).json(created);
    })
  );

  app.put(
    '/api/locations/:id',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const updated = await updateLocation(db, String(req.params.id), req.body);
      res.json(updated);
    })
  );

  app.delete(
    '/api/locations/:id',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const result = await deleteLocation(db, String(req.params.id));
      res.json(result);
    })
  );

  // Waste Reports CRUD & Compound Queries
  app.get(
    '/api/reports',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const wasteType = typeof req.query.wasteType === 'string' ? req.query.wasteType : undefined;
      const locationId = typeof req.query.locationId === 'string' ? req.query.locationId : undefined;
      const items = await queryWasteReports(db, { status, wasteType, locationId });
      res.json({ items, source: 'mongodb-server' });
    })
  );

  app.post(
    '/api/reports',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const created = await createWasteReport(db, req.body);
      res.status(201).json(created);
    })
  );

  app.put(
    '/api/reports/:id',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const updated = await updateWasteReport(db, String(req.params.id), req.body);
      res.json(updated);
    })
  );

  app.patch(
    '/api/reports/:id/status',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const updated = await rejectOrCancelReport(
        db,
        String(req.params.id),
        req.body?.status,
        req.body?.statusReason
      );
      res.json(updated);
    })
  );

  app.delete(
    '/api/reports/:id',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const result = await deleteWasteReport(db, String(req.params.id));
      res.json(result);
    })
  );

  // Collection Tasks CRUD & Workflow Transitions
  app.get(
    '/api/tasks',
    asyncHandler(async (_req, res) => {
      const db = await getMongoDatabase();
      res.json({ items: await listCollectionTasks(db) });
    })
  );

  app.post(
    '/api/tasks',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const created = await createCollectionTask(db, req.body);
      res.status(201).json(created);
    })
  );

  app.put(
    '/api/tasks/:id',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const updated = await updateCollectionTask(db, String(req.params.id), req.body);
      res.json(updated);
    })
  );

  app.patch(
    '/api/tasks/:id/start',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const updated = await startCollectionTask(db, String(req.params.id));
      res.json(updated);
    })
  );

  app.patch(
    '/api/tasks/:id/complete',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const updated = await completeCollectionTask(
        db,
        String(req.params.id),
        req.body?.actualKg,
        req.body?.remarks ?? null
      );
      res.json(updated);
    })
  );

  app.patch(
    '/api/tasks/:id/cancel',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const updated = await cancelCollectionTask(
        db,
        String(req.params.id),
        req.body?.remarks ?? null
      );
      res.json(updated);
    })
  );

  app.delete(
    '/api/tasks/:id',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const result = await deleteCollectionTask(db, String(req.params.id));
      res.json(result);
    })
  );

  // Recycling Records CRUD
  app.get(
    '/api/recycling',
    asyncHandler(async (_req, res) => {
      const db = await getMongoDatabase();
      res.json({ items: await listRecyclingRecords(db) });
    })
  );

  app.post(
    '/api/recycling',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const created = await createRecyclingRecord(db, req.body);
      res.status(201).json(created);
    })
  );

  app.put(
    '/api/recycling/:id',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const updated = await updateRecyclingRecord(db, String(req.params.id), req.body);
      res.json(updated);
    })
  );

  app.delete(
    '/api/recycling/:id',
    asyncHandler(async (req, res) => {
      const db = await getMongoDatabase();
      const result = await deleteRecyclingRecord(db, String(req.params.id));
      res.json(result);
    })
  );

  // Sample Data Seeder
  app.post(
    '/api/seed',
    asyncHandler(async (_req, res) => {
      const db = await getMongoDatabase();
      const summary = await seedSampleData(db);
      res.status(201).json(summary);
    })
  );

  // Unknown API routes return clean JSON 404
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  // Centralized API error handler
  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BusinessRuleError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        isBusinessRule: true,
      });
      return;
    }
    if (err instanceof DbConfigError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: 'DB_CONFIG_ERROR',
      });
      return;
    }
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('API Error:', err);
    res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
  });

  // Mount Vite middleware in development, static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`Campus Waste Management System server listening on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
