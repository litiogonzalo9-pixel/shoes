import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from "@shared/schema";

const defaultDatabasePath = './database.sqlite';
const databaseUrl = process.env.DATABASE_URL?.trim();
const sqlitePath = databaseUrl
  ? databaseUrl.replace(/^sqlite:|^file:/, '')
  : defaultDatabasePath;

const sqlite = new Database(sqlitePath, { fileMustExist: false });
sqlite.pragma('journal_mode = WAL');

export const db = drizzle(sqlite, { schema });
export { sqlite };