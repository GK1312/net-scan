import 'dotenv/config';
import http from 'http';
import { createApp } from './app';
import { appConfig } from './config/app.config';
import { logger } from './config/logger.config';

const app    = createApp();
const server = http.createServer(app);

server.listen(appConfig.port, () => {
  logger.info('Server started', {
    port:    appConfig.port,
    env:     appConfig.env,
    version: process.version,
  });
});

function gracefulShutdown(signal: string): void {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { err });
  process.exit(1);
});
