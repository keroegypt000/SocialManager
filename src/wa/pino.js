// Tiny logger with pino's shape (Baileys only calls level methods and child()).
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
function make(bindings = {}, level = globalThis.__WA_LOG_LEVEL || 'warn') {
  const min = LEVELS.indexOf(level);
  const logger = { level, bindings: () => bindings };
  for (const [i, name] of LEVELS.entries()) {
    logger[name] = (...args) => {
      if (i < min) return;
      try {
        const parts = args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'object' ? JSON.stringify(a)?.slice(0, 500) : String(a)));
        (i >= 4 ? console.error : console.log)(`[wa:${name}]`, ...parts);
      } catch { /* ignore */ }
    };
  }
  logger.child = (b = {}, opts = {}) => make({ ...bindings, ...b }, opts.level || logger.level);
  logger.isLevelEnabled = (l) => LEVELS.indexOf(l) >= LEVELS.indexOf(logger.level);
  return logger;
}
export default function pino(opts = {}) { return make({}, opts.level); }
export { pino };
