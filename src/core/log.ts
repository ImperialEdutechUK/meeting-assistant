// Minimal structured logger. One JSON object per line, which Azure Log Analytics parses as is.

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return ORDER[level] ?? ORDER.info;
}

// Settings whose values must never reach a log line, matched by name.
const SECRET_SETTING = /(SECRET|API_KEY|_KEY$|PASSWORD|CONNECTION_STRING|TOKEN)/i;
// Known secret formats, in case one arrives by another route such as an error message.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/((?:AccountKey|SharedAccessKey|accesskey)=)[^;"\s]+/gi, '$1[redacted]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1[redacted]'],
  [/([?&]sig=)[^&"\s]+/gi, '$1[redacted]'],
];

/** Removes secret setting values and known key formats from text. Exported for tests. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 8 && SECRET_SETTING.test(name)) {
      out = out.split(value).join('[redacted]');
      // JSON.stringify escapes some characters, so also try the escaped form.
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) out = out.split(escaped).join('[redacted]');
    }
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function emit(level: Level, scope: string, message: string, extra?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const line = redact(JSON.stringify({ t: new Date().toISOString(), level, scope, message, ...extra }));
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
