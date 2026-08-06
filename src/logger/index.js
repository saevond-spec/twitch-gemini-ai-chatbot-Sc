import winston from 'winston';
const { combine, timestamp, printf, colorize, errors } = winston.format;
const logFormat = printf(({ level, message, timestamp, label, stack }) => {
  const labelStr = label ? `[${label}]` : '';
  return `${timestamp} ${level} ${labelStr} ${stack || message}`;
});
const transports = [new winston.transports.Console()];
if (process.env.NODE_ENV === 'production') {
  transports.push(new winston.transports.File({ filename: 'logs/combined.log' }));
}
export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    colorize({ all: true }),
    logFormat
  ),
  transports,
  exceptionHandlers: transports,
});
export const createLogger = (label) => logger.child({ label });
