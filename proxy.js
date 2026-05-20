import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import axios from 'axios';
import { parseProxyLine } from './loaders.js';

function schemeForType(proxyType = 'http') {
  if (proxyType === 'socks5') return 'socks5h';
  if (proxyType === 'socks4') return 'socks4a';
  if (proxyType === 'https') return 'https';
  return 'http';
}

function splitScheme(raw) {
  const t = String(raw || '').trim();
  const m = t.match(/^([a-z][a-z0-9+]*):\/\/(.+)$/i);
  if (!m) return { scheme: null, rest: t };
  return { scheme: m[1].toLowerCase(), rest: m[2] };
}

export function normalizeProxy(raw, defaultScheme = 'socks5h', forceTypeScheme = false) {
  const parsed = splitScheme(raw);
  const t = parsed.rest;
  if (!t) return null;

  if (!forceTypeScheme && parsed.scheme) {
    if (parsed.scheme === 'socks5') return 'socks5h://' + t;
    if (parsed.scheme === 'socks4') return 'socks4a://' + t;
    return `${parsed.scheme}://${t}`;
  }

  const scheme = defaultScheme || 'http';
  const parts = t.split(':');
  if (parts.length === 4 && /^\d+$/.test(parts[1])) {
    const [host, port, user, pass] = parts;
    const authScheme = scheme === 'socks4' ? 'socks4a' : scheme === 'socks5' ? 'socks5h' : scheme;
    return `${authScheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  return `${scheme}://${t}`;
}

export function buildAgent(proxyUrl, defaultScheme = 'socks5h', forceTypeScheme = false) {
  const url = normalizeProxy(proxyUrl, defaultScheme, forceTypeScheme);
  if (!url) throw new Error('Empty proxy URL');
  if (url.startsWith('socks')) {
    return { httpAgent: new SocksProxyAgent(url), httpsAgent: new SocksProxyAgent(url) };
  }
  const a = new HttpsProxyAgent(url, { rejectUnauthorized: false });
  return { httpAgent: a, httpsAgent: a };
}

// Use an old-Android UA so mbasic returns its classic feature-phone HTML
// (with the <form id="identify_yourself_flow"> recovery form) instead of
// redirecting to the modern React desktop site.
const MBASIC_UA = 'Mozilla/5.0 (Linux; Android 4.4.4; Nexus 5 Build/KTU84P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/35.0.1916.114 Mobile Safari/537.36';

export async function checkMbasicProxy(proxyUrl, timeout = 12000, proxyType = 'http') {
  try {
    const scheme = schemeForType(proxyType);
    const normalized = normalizeProxy(proxyUrl, scheme, true);
    if (!normalized) return false;
    const agents = buildAgent(normalized, scheme, true);
    const res = await axios.get('https://mbasic.facebook.com/', {
      httpAgent: agents.httpAgent,
      httpsAgent: agents.httpsAgent,
      timeout,
      validateStatus: () => true,
      headers: { 'User-Agent': MBASIC_UA, Accept: '*/*' },
      maxRedirects: 2,
      decompress: true,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function checkProxy(proxyUrl, timeout = 8000, proxyType = 'http') {
  try {
    const scheme = schemeForType(proxyType);
    const normalized = normalizeProxy(proxyUrl, scheme, true);
    if (!normalized) return false;
    const agents = buildAgent(normalized, scheme, true);
    const res = await axios.get('https://www.facebook.com/', {
      httpAgent: agents.httpAgent,
      httpsAgent: agents.httpsAgent,
      timeout,
      validateStatus: () => true,
      headers: { 'User-Agent': 'curl/8.7.1', Accept: '*/*' },
      maxRedirects: 3,
      decompress: true,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function validateProxies(list, { concurrency = 20, timeout = 8000, proxyType = 'http', onProgress, checker } = {}) {
  if (!list.length) return { valid: [], invalid: [] };
  const results = new Array(list.length).fill(null);
  let done = 0;
  let idx = 0;
  let active = 0;
  let validCount = 0;
  const check = checker || ((p) => checkProxy(p, timeout, proxyType));

  return new Promise((resolve) => {
    const finish = () => {
      const valid = list.filter((_, i) => results[i]);
      const invalid = list.filter((_, i) => !results[i]);
      resolve({ valid, invalid });
    };

    const launch = () => {
      while (active < concurrency && idx < list.length) {
        const i = idx++;
        active++;
        check(list[i])
          .then((ok) => {
            results[i] = !!ok;
            if (ok) validCount++;
          })
          .catch(() => {
            results[i] = false;
          })
          .finally(() => {
            active--;
            done++;
            if (onProgress) onProgress(done, list.length, validCount);
            if (done === list.length) finish();
            else launch();
          });
      }
    };

    launch();
  });
}

export class ProxyRotator {
  constructor(list, proxyType = 'http') {
    const scheme = schemeForType(proxyType);
    this.list = list
      .map((raw) => {
        const { proxyUrl } = parseProxyLine(raw);
        return normalizeProxy(proxyUrl, scheme, true) || null;
      })
      .filter(Boolean);
    this.idx = 0;
    this.banned = new Map();
    if (this.list.length === 0) throw new Error('Proxy list is empty');
  }

  markBanned(url, durationMs = 45_000) {
    const norm = normalizeProxy(url) || url;
    this.banned.set(norm, Date.now() + durationMs);
  }

  next() {
    const now = Date.now();
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const p = this.list[this.idx % n];
      this.idx++;
      const exp = this.banned.get(p);
      if (!exp || now > exp) {
        if (exp) this.banned.delete(p);
        return p;
      }
    }
    const p = this.list[this.idx % n];
    this.idx++;
    return p;
  }

  size() {
    return this.list.length;
  }
}
