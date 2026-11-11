import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_FILE = path.resolve(__dirname, '../../server.log');

function formatMessage(level: string, message: string, data?: unknown): string {
  const timestamp = new Date().toISOString();
  const dataStr = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
  return `[${timestamp}] [${level}] ${message}${dataStr}\n`;
}

export const logger = {
  info(message: string, data?: unknown): void {
    const formatted = formatMessage('INFO', message, data);
    fs.appendFileSync(LOG_FILE, formatted);
    process.stderr.write(formatted);
  },
  warn(message: string, data?: unknown): void {
    const formatted = formatMessage('WARN', message, data);
    fs.appendFileSync(LOG_FILE, formatted);
    process.stderr.write(formatted);
  },
  error(message: string, data?: unknown): void {
    const formatted = formatMessage('ERROR', message, data);
    fs.appendFileSync(LOG_FILE, formatted);
    process.stderr.write(formatted);
  },
  debug(message: string, data?: unknown): void {
    const formatted = formatMessage('DEBUG', message, data);
    fs.appendFileSync(LOG_FILE, formatted);
    // debug only to file, not stderr to reduce noise
  },
};
