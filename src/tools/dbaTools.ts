import { z } from 'zod';
import { Database } from 'sql.js';
import { getDatabase, analyzeQueryPlan, getTableSchema, queryFirst } from '../db/databaseEngine.js';
import { runDryMigration } from '../db/migrationGuardrail.js';
import { logger } from '../utils/logger.js';

// ─── Zod Schemas ────────────────────────────────────────────────────────────

export const ExplainQueryPlanSchema = z.object({
  sqlQuery: z.string().min(1).describe('The SQL SELECT query to analyze'),
  tableName: z.string().optional().describe('Optional: specific table name to focus analysis on'),
});

export const InspectTableSchemaSchema = z.object({
  tableName: z.string().min(1).describe('The name of the table to inspect'),
});

export const DryRunMigrationSchema = z.object({
  migrationSql: z.string().min(1).describe('The DDL SQL statement to dry-run (will be fully rolled back)'),
});

export const SuggestOptimalIndexesSchema = z.object({
  sqlQuery: z.string().optional().describe('SQL query to analyze for index opportunities'),
  tableName: z.string().optional().describe('Table name to suggest indexes for'),
}).refine(data => data.sqlQuery || data.tableName, {
  message: 'Either sqlQuery or tableName must be provided',
});

export const SeedDemoDatabaseSchema = z.object({
  rowCount: z.number().int().min(10).max(100000).default(1000).describe('Number of rows to seed per table'),
});

// ─── Tool Handlers ───────────────────────────────────────────────────────────

export async function handleExplainQueryPlan(args: z.infer<typeof ExplainQueryPlanSchema>) {
  const db = await getDatabase();
  logger.info('Tool: explain_query_plan', { query: args.sqlQuery.substring(0, 80) });

  try {
    const analysis = analyzeQueryPlan(db, args.sqlQuery);

    const planText = analysis.rawPlan
      .map(r => `  [${r.id}] parent=${r.parent} | ${r.detail}`)
      .join('\n');

    const sections: string[] = [
      `## Query Plan Analysis`,
      ``,
      `**SQL:** \`${args.sqlQuery.substring(0, 120)}${args.sqlQuery.length > 120 ? '...' : ''}\``,
      `**Cost Level:** ${analysis.estimatedCostLevel}`,
      `**Full Table Scan Detected:** ${analysis.hasFullTableScan ? '❌ YES' : '✅ NO'}`,
      `**Index Scans Used:** ${analysis.hasIndexScan ? `✅ YES (${analysis.indexesUsed.join(', ')})` : '❌ NONE'}`,
      ``,
      `### Raw EXPLAIN QUERY PLAN Output`,
      `\`\`\``,
      planText || '(no plan rows returned)',
      `\`\`\``,
    ];

    if (analysis.warnings.length > 0) {
      sections.push('', '### ⚠️ Warnings', ...analysis.warnings.map(w => `- ${w}`));
    }

    if (analysis.recommendations.length > 0) {
      sections.push('', '### 💡 Recommendations', ...analysis.recommendations.map(r => `- ${r}`));
    }

    if (analysis.fullTableScanTables.length > 0) {
      sections.push(
        '',
        '### 🚨 Tables Requiring Indexes',
        ...analysis.fullTableScanTables.map(t => `- **${t}**: Run \`suggest_optimal_indexes\` with tableName="${t}" for precise recommendations`),
      );
    }

    return { content: [{ type: 'text', text: sections.join('\n') }] };
  } catch (err) {
    logger.error('explain_query_plan failed', err);
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
  }
}

export async function handleInspectTableSchema(args: z.infer<typeof InspectTableSchemaSchema>) {
  const db = await getDatabase();
  logger.info('Tool: inspect_table_schema', { tableName: args.tableName });

  try {
    const schema = getTableSchema(db, args.tableName);

    const colRows = schema.columns.map(c =>
      `  ${c.name.padEnd(24)} ${c.type.padEnd(16)} ${c.notnull ? 'NOT NULL' : 'NULLABLE'} ${c.pk ? '🔑 PK' : ''} ${c.dfltValue !== null ? `DEFAULT ${c.dfltValue}` : ''}`
    ).join('\n');

    const indexRows = schema.indexes.length > 0
      ? schema.indexes.map(i => `  - ${i.name} [${i.unique ? 'UNIQUE' : 'NON-UNIQUE'}] on (${i.columns.join(', ')})`).join('\n')
      : '  (no indexes)';

    const fkRows = schema.foreignKeys.length > 0
      ? schema.foreignKeys.map(fk => `  - ${fk.from} → ${fk.table}(${fk.to}) ON DELETE ${fk.onDelete}`).join('\n')
      : '  (no foreign keys)';

    const coveragePercent = schema.columns.length > 0
      ? Math.round(((schema.columns.length - schema.unindexedColumns.length) / schema.columns.length) * 100)
      : 0;

    const sections = [
      `## Table Schema: \`${schema.tableName}\``,
      ``,
      `**Columns (${schema.columns.length}):**`,
      colRows,
      ``,
      `**Primary Key(s):** ${schema.primaryKeys.length > 0 ? schema.primaryKeys.join(', ') : '(none)'}`,
      ``,
      `**Foreign Keys:**`,
      fkRows,
      ``,
      `**Indexes (${schema.totalIndexCount}):**`,
      indexRows,
      ``,
      `**Index Coverage:** ${coveragePercent}% of columns indexed`,
      `**Unindexed Columns:** ${schema.unindexedColumns.length > 0 ? schema.unindexedColumns.join(', ') : '(all indexed)'}`,
    ];

    if (schema.unindexedColumns.length > 3) {
      sections.push('', `> ⚠️ ${schema.unindexedColumns.length} unindexed columns detected — query performance may suffer without targeted indexes`);
    }

    return { content: [{ type: 'text', text: sections.join('\n') }] };
  } catch (err) {
    logger.error('inspect_table_schema failed', err);
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
  }
}

export async function handleDryRunMigration(args: z.infer<typeof DryRunMigrationSchema>) {
  const db = await getDatabase();
  logger.info('Tool: dry_run_migration');

  const result = runDryMigration(db, args.migrationSql);

  const riskEmoji = { SAFE: '✅', WARNING: '🟡', DANGEROUS: '🟠', CRITICAL: '🔴' }[result.riskAssessment.level];

  const sections = [
    `## Dry-Run Migration Report`,
    ``,
    `**Migration SQL:**`,
    `\`\`\`sql`,
    args.migrationSql,
    `\`\`\``,
    ``,
    `**Execution Result:** ${result.success ? '✅ SQL executed successfully' : `❌ FAILED: ${result.error}`}`,
    `**Transaction Rolled Back:** ${result.rolledBack ? '✅ YES — database state unchanged' : '❌ NO (savepoint error)'}`,
    `**Execution Time:** ${result.executionTimeMs}ms`,
    `**Risk Level:** ${riskEmoji} ${result.riskAssessment.level}`,
  ];

  if (result.riskAssessment.issues.length > 0) {
    sections.push('', '### ⚠️ Detected Issues', ...result.riskAssessment.issues.map(i => `- ${i}`));
  }

  if (result.riskAssessment.recommendations.length > 0) {
    sections.push('', '### 💡 Guardrail Recommendations', ...result.riskAssessment.recommendations.map(r => `- ${r}`));
  }

  if (result.riskAssessment.level === 'SAFE' && result.success) {
    sections.push('', '> ✅ This migration appears safe. Review and apply with your migration runner.');
  } else if (result.riskAssessment.level === 'CRITICAL') {
    sections.push('', '> 🚨 **CRITICAL RISK**: This migration has been blocked from production execution. Address all issues before applying.');
  }

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}

export async function handleSuggestOptimalIndexes(args: z.infer<typeof SuggestOptimalIndexesSchema>) {
  const db = await getDatabase();
  logger.info('Tool: suggest_optimal_indexes', args);

  const suggestions: string[] = [];
  const sections: string[] = ['## Index Optimization Recommendations', ''];

  if (args.sqlQuery) {
    // Parse WHERE clause columns
    const whereMatch = args.sqlQuery.match(/WHERE\s+(.+?)(?:ORDER\s+BY|GROUP\s+BY|LIMIT|$)/is);
    const orderByMatch = args.sqlQuery.match(/ORDER\s+BY\s+(.+?)(?:LIMIT|$)/is);
    const joinMatch = args.sqlQuery.matchAll(/JOIN\s+(\w+)\s+ON\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi);

    const whereColumns: string[] = [];
    const orderByColumns: string[] = [];
    const joinConditions: Array<{ table: string; col: string }> = [];

    if (whereMatch) {
      const whereClause = whereMatch[1];
      const colMatches = whereClause.matchAll(/(?:(\w+)\.)?(\w+)\s*(?:=|>|<|>=|<=|!=|LIKE|IN|BETWEEN)/gi);
      for (const m of colMatches) {
        whereColumns.push(m[1] ? `${m[1]}.${m[2]}` : m[2]);
      }
    }

    if (orderByMatch) {
      const orderClause = orderByMatch[1];
      const colMatches = orderClause.matchAll(/(?:(\w+)\.)?(\w+)(?:\s+(?:ASC|DESC))?/gi);
      for (const m of colMatches) {
        orderByColumns.push(m[1] ? `${m[1]}.${m[2]}` : m[2]);
      }
    }

    for (const m of joinMatch) {
      joinConditions.push({ table: m[1], col: m[3] });
      joinConditions.push({ table: m[4], col: m[5] });
    }

    const fromMatch = args.sqlQuery.match(/FROM\s+(\w+)/i);
    const mainTable = fromMatch ? fromMatch[1] : (args.tableName || 'your_table');

    if (whereColumns.length > 0) {
      sections.push('### WHERE Clause Indexes');
      for (const col of whereColumns) {
        const colName = col.includes('.') ? col.split('.')[1] : col;
        const tableName = col.includes('.') ? col.split('.')[0] : mainTable;
        const indexName = `idx_${tableName}_${colName}`;
        const suggestion = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName} (${colName});`;
        suggestions.push(suggestion);
        sections.push(`- **${col}**: \`${suggestion}\``);
        sections.push(`  - Expected benefit: Converts FULL TABLE SCAN to index seek — O(log n) lookup`);
      }
    }

    if (orderByColumns.length > 0 && whereColumns.length > 0) {
      sections.push('', '### Composite Index (WHERE + ORDER BY)');
      const cols = [...new Set([...whereColumns.map(c => c.includes('.') ? c.split('.')[1] : c), ...orderByColumns.map(c => c.includes('.') ? c.split('.')[1] : c)])];
      const compositeName = `idx_${mainTable}_${cols.slice(0, 3).join('_')}`;
      const compositeIndex = `CREATE INDEX IF NOT EXISTS ${compositeName} ON ${mainTable} (${cols.join(', ')});`;
      suggestions.push(compositeIndex);
      sections.push(`- **Composite**: \`${compositeIndex}\``);
      sections.push(`  - Expected benefit: Eliminates both filter scan and sort operation`);
    }

    if (joinConditions.length > 0) {
      sections.push('', '### JOIN Condition Indexes');
      for (const { table, col } of joinConditions) {
        const indexName = `idx_${table}_${col}`;
        const suggestion = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (${col});`;
        if (!suggestions.includes(suggestion)) {
          suggestions.push(suggestion);
          sections.push(`- **${table}.${col}**: \`${suggestion}\``);
          sections.push(`  - Expected benefit: Avoids nested-loop full scan on joined table`);
        }
      }
    }

    try {
      const analysis = analyzeQueryPlan(db, args.sqlQuery);
      if (analysis.fullTableScanTables.length > 0) {
        sections.push('', `### 🚨 Confirmed: FULL TABLE SCAN on ${analysis.fullTableScanTables.join(', ')}`, '(Indexes above will directly address these scans)');
      }
    } catch {
      // ignore if query fails
    }
  }

  if (args.tableName && !args.sqlQuery) {
    try {
      const schema = getTableSchema(db, args.tableName);
      sections.push(`### Suggested Indexes for \`${args.tableName}\``);
      if (schema.unindexedColumns.length === 0) {
        sections.push('> ✅ All columns are covered by existing indexes');
      } else {
        for (const col of schema.unindexedColumns) {
          const indexName = `idx_${args.tableName}_${col}`;
          const suggestion = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${args.tableName} (${col});`;
          suggestions.push(suggestion);
          sections.push(`- **${col}**: \`${suggestion}\``);
        }
      }
    } catch (err) {
      sections.push(`> Error inspecting table: ${(err as Error).message}`);
    }
  }

  if (suggestions.length === 0) {
    sections.push('> No specific index recommendations could be generated. Provide a SQL query with WHERE/JOIN clauses for precise analysis.');
  } else {
    sections.push('', '---', `**${suggestions.length} index(es) recommended.** Apply them in a migration and re-run \`explain_query_plan\` to verify improvement.`);
  }

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}

export async function handleSeedDemoDatabase(args: z.infer<typeof SeedDemoDatabaseSchema>) {
  const db = await getDatabase();
  const rowCount = args.rowCount ?? 1000;
  logger.info('Tool: seed_demo_database', { rowCount });

  try {
    db.run(`DROP TABLE IF EXISTS transactions`);
    db.run(`DROP TABLE IF EXISTS orders`);
    db.run(`DROP TABLE IF EXISTS users`);

    db.run(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      username TEXT NOT NULL,
      country TEXT NOT NULL,
      age INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    )`);

    db.run(`CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      shipped_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      payment_method TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL DEFAULT 'pending',
      processed_at TEXT NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )`);

    const countries = ['US', 'UK', 'DE', 'FR', 'JP', 'IN', 'CA', 'AU', 'BR', 'MX'];
    const statuses = ['active', 'inactive', 'suspended'];

    db.run('BEGIN');
    for (let i = 0; i < rowCount; i++) {
      db.run(
        `INSERT INTO users (email, username, country, age, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          `user${i}@example.com`,
          `user_${i}`,
          countries[i % countries.length],
          18 + (i % 60),
          new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString(),
          statuses[i % statuses.length],
        ]
      );
    }
    db.run('COMMIT');

    const orderStatuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
    const products = ['Laptop', 'Phone', 'Tablet', 'Monitor', 'Keyboard', 'Mouse', 'Headphones', 'Webcam'];

    db.run('BEGIN');
    for (let i = 0; i < rowCount * 3; i++) {
      const status = orderStatuses[i % orderStatuses.length];
      db.run(
        `INSERT INTO orders (user_id, product_name, amount, status, created_at, shipped_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          (i % rowCount) + 1,
          products[i % products.length],
          Math.round((10 + Math.random() * 990) * 100) / 100,
          status,
          new Date(Date.now() - Math.random() * 180 * 24 * 60 * 60 * 1000).toISOString(),
          status === 'shipped' || status === 'delivered' ? new Date().toISOString() : null,
        ]
      );
    }
    db.run('COMMIT');

    const paymentMethods = ['credit_card', 'paypal', 'bank_transfer', 'crypto'];
    const currencies = ['USD', 'EUR', 'GBP', 'JPY'];

    db.run('BEGIN');
    for (let i = 0; i < rowCount * 2; i++) {
      db.run(
        `INSERT INTO transactions (order_id, payment_method, amount, currency, status, processed_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          (i % (rowCount * 3)) + 1,
          paymentMethods[i % paymentMethods.length],
          Math.round((10 + Math.random() * 990) * 100) / 100,
          currencies[i % currencies.length],
          statuses[i % statuses.length],
          new Date(Date.now() - Math.random() * 90 * 24 * 60 * 60 * 1000).toISOString(),
        ]
      );
    }
    db.run('COMMIT');

    const userCountRow = queryFirst(db, 'SELECT COUNT(*) as c FROM users');
    const orderCountRow = queryFirst(db, 'SELECT COUNT(*) as c FROM orders');
    const txCountRow = queryFirst(db, 'SELECT COUNT(*) as c FROM transactions');
    const userCount = userCountRow ? userCountRow['c'] : 0;
    const orderCount = orderCountRow ? orderCountRow['c'] : 0;
    const txCount = txCountRow ? txCountRow['c'] : 0;

    logger.info('Demo database seeded', { userCount, orderCount, txCount });

    return {
      content: [{
        type: 'text',
        text: [
          '## ✅ Demo Database Seeded Successfully',
          '',
          '| Table | Rows | Indexes |',
          '|-------|------|---------|',
          `| users | ${userCount} | PRIMARY KEY only (intentionally unindexed) |`,
          `| orders | ${orderCount} | PRIMARY KEY only (intentionally unindexed) |`,
          `| transactions | ${txCount} | PRIMARY KEY only (intentionally unindexed) |`,
          '',
          '**Next steps to test the DBA tools:**',
          '1. Run `explain_query_plan` with `SELECT * FROM orders WHERE user_id = 42 AND status = \'pending\'`',
          '2. Run `suggest_optimal_indexes` with the same query',
          '3. Run `dry_run_migration` with `ALTER TABLE orders ADD COLUMN discount REAL NOT NULL`',
        ].join('\n'),
      }],
    };
  } catch (err) {
    logger.error('seed_demo_database failed', err);
    return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
  }
}
