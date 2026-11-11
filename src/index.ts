import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { logger } from './utils/logger.js';
import { closeDatabase } from './db/databaseEngine.js';
import {
  ExplainQueryPlanSchema,
  InspectTableSchemaSchema,
  DryRunMigrationSchema,
  SuggestOptimalIndexesSchema,
  SeedDemoDatabaseSchema,
  handleExplainQueryPlan,
  handleInspectTableSchema,
  handleDryRunMigration,
  handleSuggestOptimalIndexes,
  handleSeedDemoDatabase,
} from './tools/dbaTools.js';

const server = new Server(
  {
    name: 'db-dba-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'explain_query_plan',
        description: 'Executes EXPLAIN QUERY PLAN on a SQL query and flags FULL TABLE SCANs, missing indexes, and high-cost operations.',
        inputSchema: {
          type: 'object',
          properties: {
            sqlQuery: { type: 'string', description: 'The SQL SELECT query to analyze' },
            tableName: { type: 'string', description: 'Optional: specific table to focus analysis on' },
          },
          required: ['sqlQuery'],
        },
      },
      {
        name: 'inspect_table_schema',
        description: 'Returns detailed schema info for a table: column types, nullability, primary keys, foreign keys, and index coverage metrics.',
        inputSchema: {
          type: 'object',
          properties: {
            tableName: { type: 'string', description: 'The name of the table to inspect' },
          },
          required: ['tableName'],
        },
      },
      {
        name: 'dry_run_migration',
        description: 'Executes a DDL migration inside an isolated SAVEPOINT, evaluates risks, then ALWAYS rolls back. Returns risk assessment and guardrail warnings.',
        inputSchema: {
          type: 'object',
          properties: {
            migrationSql: { type: 'string', description: 'The DDL SQL statement to dry-run (will be fully rolled back)' },
          },
          required: ['migrationSql'],
        },
      },
      {
        name: 'suggest_optimal_indexes',
        description: 'Analyzes a SQL query or table and generates precise CREATE INDEX recommendations with performance improvement rationale.',
        inputSchema: {
          type: 'object',
          properties: {
            sqlQuery: { type: 'string', description: 'SQL query to analyze for index opportunities' },
            tableName: { type: 'string', description: 'Table name to suggest indexes for' },
          },
        },
      },
      {
        name: 'seed_demo_database',
        description: 'Initializes the in-memory database with high-volume sample tables (users, orders, transactions) intentionally without indexes.',
        inputSchema: {
          type: 'object',
          properties: {
            rowCount: { type: 'number', description: 'Number of rows per table (10–100000, default 1000)' },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  logger.info(`Tool called: ${name}`);

  try {
    switch (name) {
      case 'explain_query_plan': {
        const parsed = ExplainQueryPlanSchema.parse(args);
        return await handleExplainQueryPlan(parsed);
      }
      case 'inspect_table_schema': {
        const parsed = InspectTableSchemaSchema.parse(args);
        return await handleInspectTableSchema(parsed);
      }
      case 'dry_run_migration': {
        const parsed = DryRunMigrationSchema.parse(args);
        return await handleDryRunMigration(parsed);
      }
      case 'suggest_optimal_indexes': {
        const parsed = SuggestOptimalIndexesSchema.parse(args);
        return await handleSuggestOptimalIndexes(parsed);
      }
      case 'seed_demo_database': {
        const parsed = SeedDemoDatabaseSchema.parse(args);
        return await handleSeedDemoDatabase(parsed);
      }
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      logger.error(`Validation error for tool ${name}`, err.errors);
      return {
        content: [{ type: 'text', text: `Validation error: ${err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')}` }],
        isError: true,
      };
    }
    logger.error(`Tool ${name} threw an unexpected error`, err);
    return {
      content: [{ type: 'text', text: `Internal error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

async function main() {
  logger.info('Starting DB DBA MCP Server v1.0.0');
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP Server connected via stdio transport');
}

process.on('SIGINT', () => {
  logger.info('Received SIGINT — shutting down gracefully');
  closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM — shutting down gracefully');
  closeDatabase();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err);
  process.exit(1);
});

main().catch((err) => {
  logger.error('Failed to start server', err);
  process.exit(1);
});
