import { readFileSync, existsSync } from 'node:fs';

export function loadLines(path) {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  const raw = readFileSync(path, 'utf8').trim();

  // Obsługa pliku JSON z tablicą proxy: [{...},{...}]
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr
          .map((item) => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item).trim()))
          .filter(Boolean);
      }
    } catch { /* nie JSON — traktuj jako zwykły tekst */ }
  }

  // Obsługa wieloliniowych obiektów JSON ({...} rozbitych na wiele linii)
  const lines = raw.split(/\r?\n/);
  const result = [];
  let jsonBuf = '';
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (depth === 0 && !trimmed.startsWith('{')) {
      result.push(trimmed);
      continue;
    }
    // Zliczaj { i } żeby wiedzieć kiedy obiekt jest kompletny
    for (const ch of trimmed) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    jsonBuf += (jsonBuf ? ' ' : '') + trimmed;
    if (depth === 0) {
      result.push(jsonBuf.trim().replace(/,$/, ''));  // usuń przecinek między obiektami
      jsonBuf = '';
    }
  }
  return result;
}

// Parsuje linię proxy w formatach:
// socks5://user:pass@host:port:Label[https://api.asocks.com/.../refresh-ip]
// host:port:user:pass                          (bez schematu)
// host:port:user:pass:Label[refresh_url]
// {"login":"...","password":"...","protocol":"socks5","host":"...","port":1080}  (JSON)
// Zwraca { proxyUrl, refreshUrl } — refreshUrl może być null
export function parseProxyLine(raw) {
  let line = String(raw || '').trim();
  let refreshUrl = null;

  // Format JSON: {"login":..., "password":..., "protocol":..., "host":..., "port":...}
  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line);
      const protocol = String(obj.protocol || 'socks5').toLowerCase().replace(/[^a-z0-9]/g, '');
      const host     = String(obj.host || '').trim();
      const port     = String(obj.port || '').trim();
      const login    = String(obj.login || '').trim();
      const password = String(obj.password || '').trim();
      if (host && port) {
        const scheme = /^socks/.test(protocol) ? protocol : (protocol === 'https' ? 'https' : 'http');
        if (login && password) {
          line = `${scheme}://${encodeURIComponent(login)}:${encodeURIComponent(password)}@${host}:${port}`;
        } else {
          line = `${scheme}://${host}:${port}`;
        }
      }
    } catch { /* niepoprawny JSON — leciej przez normalny parser */ }
    return { proxyUrl: line, refreshUrl };
  }

  // Wyciągnij [https://...] z końca linii
  const bracketMatch = line.match(/\[([^\]]+)\]\s*$/);
  if (bracketMatch) {
    refreshUrl = bracketMatch[1].trim();
    line = line.slice(0, bracketMatch.index).trim();
  }

  // Czy linia ma schemat protokołu (socks5://, http://, itd.)?
  if (/^[a-z][a-z0-9+]*:\/\//i.test(line)) {
    // Format ze schematem: usuń :Label po host:port (etykieta zaczyna się od litery)
    // np. socks5://user:pass@1.2.3.4:443:CorpPoland - Lodz  →  socks5://user:pass@1.2.3.4:443
    line = line.replace(/(:\d+):[A-Za-z][^@]*$/, '$1');
  } else {
    // Format bez schematu: host:port:user:pass[:Label]
    // Rozdziel na części i usuń etykietę (5. część i dalej)
    const parts = line.split(':');
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
      // parts[0]=host, parts[1]=port, parts[2]=user, parts[3]=pass, reszta=label
      line = parts.slice(0, 4).join(':');
    }
  }

  return { proxyUrl: line, refreshUrl };
}

export function parseAccounts(lines) {
  const out = []; const seen = new Set();
  for (const raw of lines) {
    let email, password = '';
    const idx = raw.indexOf(':');
    if (idx === -1) email = raw.trim();
    else { email = raw.slice(0, idx).trim(); password = raw.slice(idx + 1).trim(); }
    if (!email) continue;
    const k = email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push({ email, password });
  }
  return out;
}