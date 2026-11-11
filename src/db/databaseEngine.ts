import Database from 'better-sqlite3';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export type DbConnection = Database.Database;

export interface QueryPlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

export interface QueryPlanAnalysis {
  rawPlan: QueryPlanRow[];
  hasFullTableScan: boolean;
  fullTableScanTables: string[];
  hasIndexScan: boolean;
  indexesUsed: string[];
  warnings: string[];
  recommendations: string[];
  estimatedCostLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface TableSchemaInfo {
  tableName: string;
  columns: ColumnInfo[];
  primaryKeys: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  totalIndexCount: number;
  unindexedColumns: string[];
}

export interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dfltValue: string | null;
  pk: boolean;
}

export interface ForeignKeyInfo {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  onUpdate: string;
  onDelete: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
}

let _db: DbConnection | null = null;
let _initialized = false;

export async function getDatabase(): Promise<DbConnection> {
  if (!_db) {
    const configuredPath = process.env.SQLITE_DB_PATH?.trim();

    if (configuredPath) {
      const resolvedPath = path.resolve(configuredPath);
      _db = new Database(resolvedPath);
      logger.info(`SQLite database opened from disk: ${resolvedPath}`);
    } else {
      _db = new Database(':memory:');
      logger.info('In-memory SQLite (better-sqlite3) database initialized');
    }

    // Enable foreign keys via PRAGMA
    _db.pragma('foreign_keys = ON');
    _initialized = true;
  }
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
    logger.info('Database connection closed');
  }
}

export function isUsingDiskDatabase(): boolean {
  return Boolean(process.env.SQLITE_DB_PATH?.trim()) && _initialized;
}

export function queryAll(db: DbConnection, sql: string, params: unknown[] = []): Record<string, unknown>[] {
  const statement = db.prepare(sql);
  const rows = params.length > 0
    ? statement.all(...(params as never[]))
    : statement.all();
  return rows as Record<string, unknown>[];
}

export function queryFirst(db: DbConnection, sql: string, params: unknown[] = []): Record<string, unknown> | undefined {
  const statement = db.prepare(sql);
  const row = params.length > 0
    ? statement.get(...(params as never[]))
    : statement.get();
  return row as Record<string, unknown> | undefined;
}

export function runStatement(db: DbConnection, sql: string, params: unknown[] = []): void {
  if (params.length === 0) {
    db.exec(sql);
    return;
  }
  db.prepare(sql).run(...(params as never[]));
}

export function analyzeQueryPlan(db: DbConnection, sqlQuery: string): QueryPlanAnalysis {
  logger.info('Analyzing query plan', { query: sqlQuery.substring(0, 100) });

  let rawPlan: QueryPlanRow[] = [];
  try {
    const rows = queryAll(db, `EXPLAIN QUERY PLAN ${sqlQuery}`);
    rawPlan = rows.map(r => ({
      id: r['id'] as number,
      parent: r['parent'] as number,
      notused: r['notused'] as number,
      detail: r['detail'] as string,
    }));
  } catch (err) {
    logger.error('Failed to explain query plan', err);
    throw new Error(`Failed to analyze query plan: ${(err as Error).message}`);
  }

  const warnings: string[] = [];
  const recommendations: string[] = [];
  const fullTableScanTables: string[] = [];
  const indexesUsed: string[] = [];

  for (const row of rawPlan) {
    const detail = row.detail.toUpperCase();

    // Detect FULL TABLE SCAN
    if (detail.includes('SCAN') && !detail.includes('INDEX') && !detail.includes('COVERING')) {
      const tableMatch = row.detail.match(/SCAN\s+(\w+)/i);
      if (tableMatch) {
        fullTableScanTables.push(tableMatch[1]);
        warnings.push(`�s��,? FULL TABLE SCAN detected on table "${tableMatch[1]}" �?" no suitable index found`);
        recommendations.push(`Consider adding an index on the WHERE/JOIN column(s) of table "${tableMatch[1]}"`);
      }
    }

    // Detect index usage
    if (detail.includes('INDEX')) {
      const indexMatch = row.detail.match(/INDEX\s+(\w+)/i);
      if (indexMatch) {
        indexesUsed.push(indexMatch[1]);
      }
    }

    // Detect correlated subqueries or nested loops
    if (detail.includes('CORRELATED') || detail.includes('SUBQUERY')) {
      warnings.push('�s��,? Correlated subquery detected �?" may cause N+1 performance issue');
      recommendations.push('Consider rewriting correlated subquery as a JOIN or CTE');
    }

    // Detect temp B-tree (sort without index)
    if (detail.includes('B-TREE') && detail.includes('ORDER BY')) {
      warnings.push('�s��,? Temporary B-Tree sort detected �?" ORDER BY without supporting index');
      recommendations.push('Add an index that covers the ORDER BY column(s) to avoid filesort');
    }
  }

  const hasFullTableScan = fullTableScanTables.length > 0;
  const hasIndexScan = indexesUsed.length > 0;

  let estimatedCostLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
  if (hasFullTableScan && rawPlan.length > 3) {
    estimatedCostLevel = 'CRITICAL';
  } else if (hasFullTableScan) {
    estimatedCostLevel = 'HIGH';
  } else if (warnings.length > 0) {
    estimatedCostLevel = 'MEDIUM';
  }

  return {
    rawPlan,
    hasFullTableScan,
    fullTableScanTables,
    hasIndexScan,
    indexesUsed,
    warnings,
    recommendations,
    estimatedCostLevel,
  };
}

export function getTableSchema(db: DbConnection, tableName: string): TableSchemaInfo {
  logger.info('Inspecting table schema', { tableName });

  // Validate table exists
  const tableExists = queryFirst(db,
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [tableName]
  );
  if (!tableExists) {
    throw new Error(`Table "${tableName}" does not exist`);
  }

  // Get column info
  const columnsRaw = queryAll(db, `PRAGMA table_info("${tableName}")`);
  const columns: ColumnInfo[] = columnsRaw.map(c => ({
    cid: c['cid'] as number,
    name: c['name'] as string,
    type: c['type'] as string,
    notnull: (c['notnull'] as number) === 1,
    dfltValue: c['dflt_value'] as string | null,
    pk: (c['pk'] as number) > 0,
  }));

  const primaryKeys = columns.filter(c => c.pk).map(c => c.name);

  // Get foreign keys
  const fkRaw = queryAll(db, `PRAGMA foreign_key_list("${tableName}")`);
  const foreignKeys: ForeignKeyInfo[] = fkRaw.map(fk => ({
    id: fk['id'] as number,
    seq: fk['seq'] as number,
    table: fk['table'] as string,
    from: fk['from'] as string,
    to: fk['to'] as string,
    onUpdate: fk['on_update'] as string,
    onDelete: fk['on_delete'] as string,
  }));

  // Get indexes
  const indexListRaw = queryAll(db, `PRAGMA index_list("${tableName}")`);
  const indexes: IndexInfo[] = [];
  for (const idx of indexListRaw) {
    const indexInfoRaw = queryAll(db, `PRAGMA index_info("${idx['name'] as string}")`);
    indexes.push({
      name: idx['name'] as string,
      unique: (idx['unique'] as number) === 1,
      columns: indexInfoRaw.map(i => i['name'] as string),
    });
  }

  // Determine unindexed columns
  const indexedColumns = new Set(indexes.flatMap(i => i.columns));
  const unindexedColumns = columns
    .filter(c => !c.pk && !indexedColumns.has(c.name))
    .map(c => c.name);

  return {
    tableName,
    columns,
    primaryKeys,
    foreignKeys,
    indexes,
    totalIndexCount: indexes.length,
    unindexedColumns,
  };
}
