const fs = require('fs');
const path = require('path');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function serialize(value) {
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function createLogger(config) {
  fs.mkdirSync(path.dirname(config.logFile), { recursive: true });
  const configuredLevel = LEVELS[config.logLevel] ? config.logLevel : 'info';
  const threshold = LEVELS[configuredLevel];

  const stream = fs.createWriteStream(config.logFile, { flags: 'a', encoding: 'utf8' });

  function write(level, args) {
    if (LEVELS[level] < threshold) return;
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${args.map(serialize).join(' ')}`;
    console.log(line);
    stream.write(`${line}\n`);
  }

  function close() {
    stream.end();
  }

  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    close
  };
}

module.exports = { createLogger };
