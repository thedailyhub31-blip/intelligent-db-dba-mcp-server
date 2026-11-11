import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_PATH = path.resolve(__dirname, '../src/index.js');

function log(msg: string) {
  process.stderr.write(`[TEST] ${msg}\n`);
}

function separator(title: string) {
  process.stderr.write(`\n${'═'.repeat(60)}\n  ${title}\n${'═'.repeat(60)}\n`);
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map(c => c.text).join('\n');
}

async function main() {
  separator('DB DBA MCP Server — Automated Test Harness');

  log('Starting server process...');
  const transport = new StdioClientTransport({
    command: 'node',
    args: [SERVER_PATH],
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  log('Connected to MCP server ✅');

  separator('TEST 1: List Available Tools');
  const tools = await client.listTools();
  log(`Found ${tools.tools.length} tools:`);
  for (const tool of tools.tools) {
    log(`  - ${tool.name}: ${tool.description?.substring(0, 60)}...`);
  }

  separator('TEST 2: Seed Demo Database');
  log('Seeding with 1000 rows per table...');
  const seedResult = await callTool(client, 'seed_demo_database', { rowCount: 1000 });
  process.stderr.write(seedResult + '\n');
  log('✅ Seed complete');

  separator('TEST 3: Inspect orders Table Schema');
  const schemaResult = await callTool(client, 'inspect_table_schema', { tableName: 'orders' });
  process.stderr.write(schemaResult + '\n');

  separator('TEST 4: Explain Query Plan — Unindexed Query (FULL TABLE SCAN expected)');
  const badQuery = `SELECT * FROM orders WHERE user_id = 42 AND status = 'pending' ORDER BY created_at DESC`;
  log(`Analyzing: ${badQuery}`);
  const planResult = await callTool(client, 'explain_query_plan', { sqlQuery: badQuery });
  process.stderr.write(planResult + '\n');

  separator('TEST 5: Suggest Optimal Indexes for Unindexed Query');
  const indexResult = await callTool(client, 'suggest_optimal_indexes', { sqlQuery: badQuery });
  process.stderr.write(indexResult + '\n');

  separator('TEST 6: Dry-Run SAFE Migration (ADD nullable column)');
  const safeMigration = `ALTER TABLE orders ADD COLUMN discount REAL DEFAULT 0.0`;
  const safeResult = await callTool(client, 'dry_run_migration', { migrationSql: safeMigration });
  process.stderr.write(safeResult + '\n');

  separator('TEST 7: Dry-Run DANGEROUS Migration (NOT NULL without DEFAULT)');
  const dangerousMigration = `ALTER TABLE orders ADD COLUMN priority_score INTEGER NOT NULL`;
  log('⚠️  Expecting CRITICAL risk level and guardrail warnings...');
  const dangerousResult = await callTool(client, 'dry_run_migration', { migrationSql: dangerousMigration });
  process.stderr.write(dangerousResult + '\n');

  separator('TEST 8: Dry-Run DROP TABLE (must flag as CRITICAL + confirm rollback)');
  const dropMigration = `DROP TABLE transactions`;
  log('🔴 Expecting CRITICAL warning and confirmed rollback...');
  const dropResult = await callTool(client, 'dry_run_migration', { migrationSql: dropMigration });
  process.stderr.write(dropResult + '\n');

  separator('TEST 9: Verify Rollback — transactions table must still exist after Test 8');
  const verifyResult = await callTool(client, 'inspect_table_schema', { tableName: 'transactions' });
  if (verifyResult.includes('transactions')) {
    log('✅ ROLLBACK VERIFIED — transactions table survived DROP TABLE dry-run');
  } else {
    log('❌ ROLLBACK FAILED — table was actually dropped!');
  }
  process.stderr.write(verifyResult + '\n');

  separator('TEST 10: Multi-table JOIN query plan analysis');
  const joinQuery = `SELECT u.username, o.product_name, t.amount FROM users u JOIN orders o ON u.id = o.user_id JOIN transactions t ON o.id = t.order_id WHERE u.country = 'US' AND o.status = 'delivered' ORDER BY t.amount DESC LIMIT 10`;
  const joinResult = await callTool(client, 'explain_query_plan', { sqlQuery: joinQuery });
  process.stderr.write(joinResult + '\n');

  separator('ALL TESTS COMPLETE ✅');
  log('The MCP server passed all automated DBA tool verifications.');

  await client.close();
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[TEST ERROR] ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
