import { join } from 'node:path';
import { Database } from './database.js';
import { RunCoordinator, Scheduler } from './scheduler.js';
import { createHttpServer } from './server.js';
import { SyncEngine } from './sync-engine.js';
import { TidalClient } from './tidal.js';
import { XmPlaylistClient } from './xmplaylist.js';

export function createApplication(options = {}) {
  const database = options.database ?? new Database(options.databasePath ?? join('data', 'xmsync.sqlite'));
  const xm = options.xm ?? new XmPlaylistClient(options.xmOptions);
  const tidal = options.tidal ?? new TidalClient(database, options.tidalOptions);
  const engine = options.engine ?? new SyncEngine(database, xm, tidal, options.engineOptions);
  const coordinator = options.coordinator ?? new RunCoordinator(engine, options.coordinatorOptions);
  const scheduler = options.scheduler ?? new Scheduler(database, coordinator, options.schedulerOptions);
  const server = createHttpServer({ database, xm, tidal, coordinator, scheduler });
  return { database, xm, tidal, engine, coordinator, scheduler, server };
}
