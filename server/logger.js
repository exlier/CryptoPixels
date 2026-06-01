const winston = require('winston');
const path = require('path');

// Define log directory
const logsDir = path.join(__dirname, 'logs');

// Create the Winston logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'cryptopixels-server' },
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
          return `${timestamp} [${level}]: ${message} ${metaStr}`;
        })
      ),
    }),
    // Combined log file for all logs
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    // Error log file for errors only
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
  ],
});

/**
 * Log a payment verification attempt
 * @param {string} txHash - Transaction hash
 * @param {string} status - Verification status (success, failure)
 * @param {object} details - Additional details (reason, ip, chainId, value, etc.)
 */
function logPaymentAttempt(txHash, status, details = {}) {
  const logLevel = status === 'success' ? 'info' : 'warn';
  const message = `Payment verification attempt: ${status}`;
  
  logger[logLevel](message, {
    txHash,
    status,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

/**
 * Log a security event (e.g., replay attack, suspicious activity)
 * @param {string} eventType - Type of security event
 * @param {object} details - Event details
 */
function logSecurityEvent(eventType, details = {}) {
  logger.warn(`Security event: ${eventType}`, {
    eventType,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

/**
 * Log a rate limit warning
 * @param {string} ip - Client IP address
 * @param {object} details - Additional details
 */
function logRateLimitWarning(ip, details = {}) {
  logger.warn(`Rate limit triggered`, {
    clientIp: ip,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

module.exports = {
  logger,
  logPaymentAttempt,
  logSecurityEvent,
  logRateLimitWarning,
};
