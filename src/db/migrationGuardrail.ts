import { logger } from '../utils/logger.js';
import { type DbConnection, queryAll, runStatement } from './databaseEngine.js';

export interface MigrationRisk {
  level: 'SAFE' | 'WARNING' | 'DANGEROUS' | 'CRITICAL';
  issues: string[];
  recommendations: string[];
}

export interface DryRunResult {
  success: boolean;
  rolledBack: boolean;
  executionTimeMs: number;
  riskAssessment: MigrationRisk;
  affectedSchema?: string;
  error?: string;
}

// DDL patterns that signal dangerous table-locking operations
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; issue: string; recommendation: string; level: 'WARNING' | 'DANGEROUS' | 'CRITICAL' }> = [
  {
    pattern: /ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN/i,
    issue: '🔴 DROP COLUMN is irreversible and may cause data loss',
    recommendation: 'Deprecate the column first by renaming it (e.g., _deprecated_<col>) and removing application references before dropping',
    level: 'CRITICAL',
  },
  {
    pattern: /ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+\w+\s+\w+\s+NOT\s+NULL(?!\s+DEFAULT)/i,
    issue: '🔴 Adding NOT NULL column without DEFAULT will fail on non-empty tables',
    recommendation: 'Add the column as nullable first, backfill data, then apply NOT NULL constraint',
    level: 'CRITICAL',
  },
  {
    pattern: /DROP\s+TABLE(?!\s+IF\s+EXISTS)/i,
    issue: '🟠 DROP TABLE without IF EXISTS may throw errors if table is absent',
    recommendation: 'Use DROP TABLE IF EXISTS for safer execution',
    level: 'DANGEROUS',
  },
  {
    pattern: /DROP\s+TABLE/i,
    issue: '🔴 DROP TABLE is irreversible and destroys all data',
    recommendation: 'Archive the table data before dropping; consider RENAME TABLE as a safer intermediate step',
    level: 'CRITICAL',
  },
  {
    pattern: /TRUNCATE\s+TABLE/i,
    issue: '🔴 TRUNCATE TABLE destroys all rows without individual row logging',
    recommendation: 'Use DELETE FROM with a WHERE clause and explicit transaction for auditable data removal',
    level: 'CRITICAL',
  },
  {
    pattern: /ALTER\s+TABLE\s+\w+\s+RENAME\s+TO/i,
    issue: '🟡 Renaming a table may break dependent views, triggers, and application queries',
    recommendation: 'Create a view with the old name pointing to the new table to ensure backward compatibility',
    level: 'WARNING',
  },
  {
    pattern: /CREATE\s+INDEX(?!\s+IF\s+NOT\s+EXISTS)/i,
    issue: '🟡 CREATE INDEX without IF NOT EXISTS may fail if index already exists',
    recommendation: 'Use CREATE INDEX IF NOT EXISTS for idempotent migrations',
    level: 'WARNING',
  },
  {
    pattern: /DROP\s+INDEX/i,
    issue: '🟠 Dropping an index may degrade query performance significantly',
    recommendation: 'Profile all queries using this index before dropping; monitor query plans post-migration',
    level: 'DANGEROUS',
  },
];

export function assessMigrationRisk(migrationSql: string): MigrationRisk {
  const issues: string[] = [];
  const recommendations: string[] = [];
  let highestLevel: 'SAFE' | 'WARNING' | 'DANGEROUS' | 'CRITICAL' = 'SAFE';

  const levelOrder = { SAFE: 0, WARNING: 1, DANGEROUS: 2, CRITICAL: 3 };

  for (const { pattern, issue, recommendation, level } of DANGEROUS_PATTERNS) {
    if (pattern.test(migrationSql)) {
      issues.push(issue);
      recommendations.push(recommendation);
      if (levelOrder[level] > levelOrder[highestLevel]) {
        highestLevel = level;
      }
    }
  }

  // Check for multi-statement migrations
  const statements = migrationSql.split(';').filter(s => s.trim().length > 0);
  if (statements.length > 1) {
    issues.push(`🟡 Migration contains ${statements.length} statements — partial failure may leave schema in inconsistent state`);
    recommendations.push('Wrap multi-statement migrations in a single transaction block to ensure atomicity');
    if (levelOrder['WARNING'] > levelOrder[highestLevel]) {
      highestLevel = 'WARNING';
    }
  }

  return { level: highestLevel, issues, recommendations };
}

export function runDryMigration(db: DbConnection, migrationSql: string): DryRunResult {
  logger.info('Starting dry-run migration', { sql: migrationSql.substring(0, 100) });

  const riskAssessment = assessMigrationRisk(migrationSql);
  const startTime = Date.now();

  // Always use a savepoint so we can rollback completely
  try {
    runStatement(db, 'SAVEPOINT dry_run_migration');

    try {
      runStatement(db, migrationSql);
      const executionTimeMs = Date.now() - startTime;

      // Capture what changed before rollback
      let affectedSchema: string | undefined;
      try {
        const schemaRows = queryAll(db,
          `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name`
        );
        affectedSchema = schemaRows.map(r => `-- ${r['type']}: ${r['name']}\n${r['sql']}`).join('\n\n');
      } catch {
        // non-fatal
      }

      // Always rollback — this is a DRY RUN
      runStatement(db, 'ROLLBACK TO SAVEPOINT dry_run_migration');
      runStatement(db, 'RELEASE SAVEPOINT dry_run_migration');

      logger.info('Dry-run migration completed and rolled back', { executionTimeMs });

      return {
        success: true,
        rolledBack: true,
        executionTimeMs,
        riskAssessment,
        affectedSchema,
      };
    } catch (execErr) {
      const executionTimeMs = Date.now() - startTime;
      try {
        runStatement(db, 'ROLLBACK TO SAVEPOINT dry_run_migration');
        runStatement(db, 'RELEASE SAVEPOINT dry_run_migration');
      } catch {
        // best effort
      }

      logger.error('Dry-run migration failed during execution', execErr);

      return {
        success: false,
        rolledBack: true,
        executionTimeMs,
        riskAssessment,
        error: (execErr as Error).message,
      };
    }
  } catch (savepointErr) {
    logger.error('Failed to create savepoint', savepointErr);
    return {
      success: false,
      rolledBack: false,
      executionTimeMs: Date.now() - startTime,
      riskAssessment,
      error: `Savepoint error: ${(savepointErr as Error).message}`,
    };
  }
}
