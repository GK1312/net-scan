import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { appConfig } from './app.config';

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

const scrubPasswords = winston.format((info) => {
  if (info['credentials'] && typeof info['credentials'] === 'object') {
    info['credentials'] = { ...(info['credentials'] as Record<string, unknown>), password: '[REDACTED]' };
  }
  return info;
});

const devFormat = combine(
  colorize({ all: true }),
  timestamp({ format: 'HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts as string}] ${level}: ${message as string}${metaStr}`;
  }),
);

const prodFormat = combine(
  scrubPasswords(),
  timestamp(),
  errors({ stack: true }),
  json(),
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: appConfig.env === 'production' ? prodFormat : devFormat,
  }),

  new DailyRotateFile({
    dirname:        appConfig.log.dir,
    filename:       'app-%DATE%.log',
    datePattern:    'YYYY-MM-DD',
    zippedArchive:  true,
    maxSize:        '20m',
    maxFiles:       '14d',
    format:         combine(scrubPasswords(), timestamp(), errors({ stack: true }), json()),
  }),

  new DailyRotateFile({
    level:          'error',
    dirname:        appConfig.log.dir,
    filename:       'error-%DATE%.log',
    datePattern:    'YYYY-MM-DD',
    zippedArchive:  true,
    maxSize:        '20m',
    maxFiles:       '30d',
    format:         combine(scrubPasswords(), timestamp(), errors({ stack: true }), json()),
  }),
];

export const logger = winston.createLogger({
  level:      appConfig.log.level,
  transports,
  exitOnError: false,
});
