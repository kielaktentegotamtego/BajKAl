import readline from 'node:readline';
import { stdin, stdout } from 'node:process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const ESC = '\x1b[';
const CLR = ESC + '2J' + ESC + 'H';
const HIDE = ESC + '?25l';
const SHOW = ESC + '?25h';
const RESET = ESC + '0m';

const C = {
  reset: RESET, bold: ESC + '1m', dim: ESC + '2m',
  red: ESC + '31m', green: ESC + '32m', yellow: ESC + '33m',
  blue: ESC + '34m', magenta: ESC + '35m', cyan: ESC + '36m',
  white: ESC + '37m', gray: ESC + '90m',
  orange: ESC + '38;5;208m', purple: ESC + '38;5;141m',
};

export function friendlyDetail(detail, proxy) {
  const d = String(detail || '');
  if (/hostname\/ip does not match|certificate.*altnames|self.signed|unable to verify/i.test(d)) {
    const proxyScheme = proxy ? String(proxy).split('://')[0].toUpperCase() : '?';
    return `Proxy odrzuca połączenie przez zły protokół (${proxyScheme}) — zmień typ proxy`;
  }
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT|Proxy connection timed out|connect timed out/i.test(d)) return 'Proxy nie odpowiedziało w czasie (timeout)';
  if (/ECONNREFUSED/i.test(d)) return 'Proxy odmówiło połączenia';
  if (/ECONNRESET|socket hang up|socket closed/i.test(d)) return 'Połączenie zerwane przez proxy';
  if (/ENOTFOUND|getaddrinfo/i.test(d)) return 'Nie można rozwiązać adresu proxy (DNS)';
  if (/HostUnreachable|Host unreachable|Socks5 proxy rejected/i.test(d)) return 'Proxy SOCKS5 — host nieosiągalny';
  if (/ConnectionRefused|Connection refused by proxy/i.test(d)) return 'Proxy odrzuciło połączenie';
  if (/GeneralFailure|general SOCKS/i.test(d)) return 'Proxy SOCKS — błąd ogólny';
  if (/session_error/i.test(d)) return 'FB odrzucił sesję — spalone/złe proxy';
  if (/rate_limited|too.many/i.test(d)) return 'FB: rate limit (za dużo requestów)';
  if (/no_csrf_tokens/i.test(d)) return 'FB nie zwrócił tokenów CSRF — blokada IP/proxy';
  if (/captcha/i.test(d)) return 'FB zażądał captcha';
  if (/no_redirect/i.test(d)) return 'FB nie przekierował po submit formularza';
  if (/no_form/i.test(d)) return 'FB nie zwrócił formularza logowania';
  if (/no_recovery_channels|bloks:no_channels/i.test(d)) return 'Brak kanałów odzyskiwania konta';
  if (/channels_encrypted/i.test(d)) return 'FB zaszyfrował opcje — konto wymaga dalszej weryfikacji';
  if (/no_email_in_recovery|email_not_in_recovery/i.test(d)) return 'Email nie widnieje w opcjach odzyskiwania';
  if (/pw_skipped_socks_auth/i.test(d)) return 'Playwright pominięty (SOCKS5 z auth)';
  if (/bloks:not_found|not_found/i.test(d)) return 'Konto nie istnieje w FB';
  if (/bloks:disabled|account_disabled/i.test(d)) return 'Konto zablokowane przez FB';
  if (/bloks:two_factor|2fa_required/i.test(d)) return 'Konto wymaga 2FA';
  if (/bloks:exists/i.test(d)) return 'Konto znalezione (faza HTTP)';
  if (/bloks:bad_email/i.test(d)) return 'Email odrzucony przez FB';
  if (/bloks:/i.test(d)) return `FB Bloks: ${d.replace(/.*bloks:/i, '').replace(/\|.*/,'')}`;
  if (/failed_after_\d+_retries/i.test(d)) { const m = d.match(/\d+/); return `Wyczerpano ${m ? m[0] : '?'} próby — proxy błędne lub konto niedostępne`; }
  if (/^pool:/i.test(d)) return `Błąd workera: ${d.slice(5)}`;
  // Surowy błąd proxy w formacie http:XXX:treść
  const rawProxy = d.match(/^http(?:s)?:[\w_]+:(.+)$/i);
  if (rawProxy) return `Błąd sieci: ${rawProxy[1].trim()}`;
  return d;
}

export const color = C;

export const CATEGORY_COLOR = {
  HIT: C.green, CUSTOM: C.orange, BAD: C.red, RETRY: C.blue, FAILED: C.purple,
};

export function clearScreen() { stdout.write(CLR); }
export function hideCursor() { stdout.write(HIDE); }
export function showCursor() { stdout.write(SHOW); }

const BANNER = [
  '  ██████╗██╗  ██╗███████╗ ██████╗██╗  ██╗████████╗███████╗██████╗',
  ' ██╔════╝██║  ██║██╔════╝██╔════╝██║ ██╔╝╚══██╔══╝██╔════╝██╔══██╗',
  ' ██║     ███████║█████╗  ██║     █████╔╝    ██║   █████╗  ██████╔╝',
  ' ██║     ██╔══██║██╔══╝  ██║     ██╔═██╗    ██║   ██╔══╝  ██╔══██╗',
  ' ╚██████╗██║  ██║███████╗╚██████╗██║  ██╗   ██║   ███████╗██║  ██║',
  '  ╚═════╝╚═╝  ╚═╝╚══════╝ ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝',
];

// "F" (6 rows) — kolor biały
const BANNER_F = [
  '███████╗',
  '██╔════╝',
  '█████╗  ',
  '██╔══╝  ',
  '██║     ',
  '╚═╝     ',
];

// "B" (6 rows) — kolor niebieski
const BANNER_B = [
  '██████╗ ',
  '██╔══██╗',
  '██████╔╝',
  '██╔══██╗',
  '██████╔╝',
  '╚═════╝ ',
];

// Łączy linię CHECKTER + F (biały) + B (niebieski) z odstępami
function bannerLine(i) {
  return C.cyan + BANNER[i] + RESET + '   ' +
         C.bold + C.white + BANNER_F[i] + RESET + ' ' +
         C.bold + C.blue + BANNER_B[i] + RESET;
}

// Szerokość pełnej linii (bez ANSI) — do centrowania
const BANNER_PLAIN_WIDTH = BANNER[0].length + 3 + BANNER_F[0].length + 1 + BANNER_B[0].length;

export function splash() {
  clearScreen();
  for (let i = 0; i < BANNER.length; i++) console.log(bannerLine(i));
  console.log(C.bold + C.red + '              CHECKTER BY KWASNY' + RESET + C.gray + '  ·  4 MORE WRITE TELEGRAM: ' + RESET + C.bold + '@Kwasny2' + RESET);
  console.log(C.gray + '       FB account probe · email:pass · proxy required · workers 1-200' + RESET);
  console.log();
}

export function prompt(question, def) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const q = def !== undefined ? `${question} [${def}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(C.cyan + '? ' + RESET + q, (ans) => {
      rl.close();
      const v = (ans || '').trim();
      resolve(v === '' && def !== undefined ? String(def) : v);
    });
  });
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '--:--';
  sec = Math.round(sec);
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function progressBar(checked, total, w) {
  const ratio = total > 0 ? Math.min(1, checked / total) : 0;
  const filled = Math.round(ratio * w);
  const empty = w - filled;
  return `${C.green}${'█'.repeat(filled)}${C.gray}${'░'.repeat(empty)}${RESET}`;
}

export class Dashboard {
  constructor({ total, workers, proxies }) {
    this.total = total; this.workersTarget = workers; this.proxies = proxies;
    this.checked = 0; this.activeWorkers = 0; this.startedAt = Date.now();
    this.counts = { HIT: 0, CUSTOM: 0, BAD: 0, RETRY: 0, FAILED: 0 };
    this.codeCounts = { '8': 0, '6': 0 };
    this.hits = [];
    this.maxHits = Math.max(6, (stdout.rows || 30) - 16);
  }
  ingest(category, r) {
    this.checked += 1;
    if (this.counts[category] != null) this.counts[category] += 1;
    if (r.code === '8') this.codeCounts['8'] += 1;
    if (r.code === '6') this.codeCounts['6'] += 1;
    this.hits.unshift({ ...r, _cat: category });
    if (this.hits.length > this.maxHits) this.hits.length = this.maxHits;
  }
  retryEvent(r) {
    this.counts.RETRY += 1;
    this.hits.unshift({ ...r, _cat: 'RETRY' });
    if (this.hits.length > this.maxHits) this.hits.length = this.maxHits;
  }
  setActiveWorkers(n) { this.activeWorkers = n; }
  render() {
    const cols = Math.min(stdout.columns || 120, 200);
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate = this.checked / Math.max(elapsed, 0.001);
    const remaining = this.total - this.checked;
    const eta = rate > 0 ? remaining / rate : Infinity;
    const pct = this.total > 0 ? (this.checked / this.total) * 100 : 0;

    const top = '┌' + '─'.repeat(cols - 2) + '┐';
    const sep = '├' + '─'.repeat(cols - 2) + '┤';
    const bot = '└' + '─'.repeat(cols - 2) + '┘';

    const padCol = (s) => {
      const plain = stripAnsi(s);
      const pad = Math.max(0, cols - 4 - plain.length);
      return '│ ' + s + ' '.repeat(pad) + ' │';
    };

    const barWidth = Math.max(20, cols - 4 - 30);
    const progress =
      `${progressBar(this.checked, this.total, barWidth)}  ` +
      `${C.bold}${this.checked.toString().padStart(String(this.total).length)}/${this.total}${RESET} ` +
      `(${C.cyan}${pct.toFixed(1).padStart(5)}%${RESET})`;

    const cats =
      `${C.bold}${C.green}HIT${RESET} ${C.green}${this.counts.HIT}${RESET}   ` +
      `${C.bold}${C.orange}CUSTOM${RESET} ${C.orange}${this.counts.CUSTOM}${RESET}   ` +
      `${C.bold}${C.red}BAD${RESET} ${C.red}${this.counts.BAD}${RESET}   ` +
      `${C.bold}${C.blue}RETRY${RESET} ${C.blue}${this.counts.RETRY}${RESET}   ` +
      `${C.bold}${C.purple}FAILED${RESET} ${C.purple}${this.counts.FAILED}${RESET}   ` +
      `${C.dim}|${RESET} ${C.bold}8d${RESET} ${this.codeCounts['8']}  ${C.bold}6d${RESET} ${this.codeCounts['6']}`;

    const stats =
      `${C.bold}rate${RESET} ${rate.toFixed(2)}/s   ` +
      `${C.bold}eta${RESET} ${fmtTime(eta)}   ` +
      `${C.bold}elapsed${RESET} ${fmtTime(elapsed)}   ` +
      `${C.bold}workers${RESET} ${this.activeWorkers}/${this.workersTarget}   ` +
      `${C.bold}proxies${RESET} ${this.proxies}`;

    const hitLines = this.hits.slice(0, this.maxHits).map((r) => {
      const cat = r._cat;
      const catCol = CATEGORY_COLOR[cat] || C.gray;
      const credPart = r.password ? `${r.email}:${r.password}` : r.email;

      if (r.mailValid) {
        const tag = `${catCol}[${cat}]${RESET}`;
        return `${tag} ${C.bold}${credPart}${RESET} ${C.dim}|${RESET} FB= ${C.red}Brak${RESET} ${C.dim}|${RESET} Poczta= ${C.green}Valid${RESET} ${C.dim}|${RESET} ${C.cyan}Telegram${RESET} ${C.bold}@Kwasny2${RESET}`;
      }

      // not_found — konto nie istnieje w FB
      if (r.status === 'not_found') {
        const tag = `${catCol}[${cat}]${RESET}`;
        return `${tag} ${C.bold}${credPart}${RESET} ${C.dim}|${RESET} SMS= ${C.gray}Nie Istnieje${RESET} ${C.dim}|${RESET} email= ${C.red}Nie Istnieje${RESET} ${C.dim}|${RESET} Aktywny= ${C.gray}BRAK${RESET} ${C.dim}|${RESET} Kod= ${C.gray}BRAK${RESET} ${C.dim}|${RESET} ${C.cyan}Telegram${RESET} ${C.bold}@Kwasny2${RESET}`;
      }

      const sms = (r.phones && r.phones.length) ? r.phones.join(', ') : 'Brak';
      const mailList = []; const seen = new Set();
      const pushMail = (m) => { const v = (m || '').trim(); if (!v) return; const key = v.toLowerCase(); if (seen.has(key)) return; seen.add(key); mailList.push(v); };
      const loginEmail = String(r.email || '').trim();
      const loginEmailFound = loginEmail && (r.emailFound === true || Array.isArray(r.emails) && r.emails.some(m => String(m || '').toLowerCase() === loginEmail.toLowerCase()));
      if (loginEmailFound) pushMail(loginEmail);
      if (Array.isArray(r.emails)) for (const m of r.emails) pushMail(m);
      const hasCode = r.code === '6' || r.code === '8';
      const canShowCode = hasCode && r.status === 'active' && r.emailFound === true;
      if (mailList.length === 0 && loginEmail && canShowCode) pushMail(loginEmail);
      const emails = mailList.length ? mailList.join(', ') : 'Brak';
      let tak;
      if (r.status !== 'active') tak = `${C.gray}BRAK${RESET}`;
      else if (!hasCode) tak = `${C.gray}-${RESET}`;
      else if (r.active === 'yes') tak = `${C.green}Tak${RESET}`;
      else if (r.active === 'phone_only') tak = `${C.gray}Tylko numer${RESET}`;
      else tak = `${C.gray}Nie${RESET}`;
      let kodStr;
      if (canShowCode) {
        kodStr = `${C.green}${r.code}c${RESET}`;
      } else if (r.status === 'bad' || r.status === 'not_found') {
        kodStr = `${C.gray}BRAK${RESET}`;
      } else {
        kodStr = `${C.gray}-${RESET}`;
      }
      const kod = kodStr;
      const tag = `${catCol}[${cat}]${RESET}`;
      const detail = (cat === 'FAILED' || cat === 'RETRY') && r.detail ? ` ${C.dim}:: ${friendlyDetail(r.detail, r.proxy).slice(0, 90)}${RESET}` : '';
      return `${tag} ${C.bold}${credPart}${RESET} ${C.dim}|${RESET} SMS= ${C.cyan}${sms}${RESET} ${C.dim}|${RESET} email= ${C.cyan}${emails}${RESET} ${C.dim}|${RESET} Aktywny= ${tak} ${C.dim}|${RESET} Kod= ${kod}${detail} ${C.dim}|${RESET} ${C.cyan}Telegram${RESET} ${C.bold}@Kwasny2${RESET}`;
    });
    while (hitLines.length < this.maxHits) hitLines.push('');

    const out = [
      top, padCol(progress), padCol(cats), padCol(stats), sep,
      padCol(`${C.bold}${C.cyan}LIVE FEED${RESET} ${C.dim}— [HIT]/[CUSTOM]/[BAD]/[FAILED]/[RETRY]${RESET}`),
      sep, ...hitLines.map(padCol), bot,
      `${C.dim}Ctrl+C — abort & save partial output${RESET}`,
    ].join('\n');
    stdout.write(CLR + out);
  }
}

const SETTINGS_PATH = join(homedir(), '.checkter-settings.json');

function loadSettings() {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) || {};
  } catch { return {}; }
}
function saveSettings(s) {
  try { mkdirSync(dirname(SETTINGS_PATH), { recursive: true }); writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf8'); } catch {}
}

export async function runMenu(defaults = {}) {
  const W = () => Math.min(stdout.columns || 100, 120);
  const saved = loadSettings();
  const merged = {
    emailsPath: defaults.emailsPath ?? saved.emailsPath ?? 'emails.txt',
    proxiesPath: defaults.proxiesPath ?? saved.proxiesPath ?? 'Proxy/proxies.txt',
    proxyType: defaults.proxyType ?? saved.proxyType ?? 'http',
    concurrency: defaults.concurrency ?? saved.concurrency ?? 50,
    timeout: defaults.timeout ?? saved.timeout ?? 30000,
  };
  if (!['socks5', 'socks4', 'https', 'http'].includes(merged.proxyType)) merged.proxyType = 'http';

  const items = [
    { id: 'accounts', label: 'KONTA', type: 'file', value: merged.emailsPath, info: '' },
    { id: 'proxies', label: 'PROXY', type: 'fileselect', value: merged.proxiesPath, dir: 'Proxy', options: [], editing: false, info: '' },
    { id: 'proxyType', label: 'TYP PROXY', type: 'select', value: merged.proxyType, options: ['socks5', 'socks4', 'https', 'http'], editing: false },
    { id: 'workers', label: 'WORKERZY', type: 'number', value: merged.concurrency, min: 1, max: 200, step: 1 },
    { id: 'check', label: 'CHECK PROXY', type: 'action', key: 'check', ac: C.yellow },
    { id: 'start', label: '► START', type: 'action', key: 'start', ac: C.green },
    { id: 'exit', label: 'WYJŚCIE', type: 'action', key: 'exit', ac: C.red },
  ];

  let cursor = 0;
  const checkResult = defaults.proxyCheckResult || null;
  const byId = (id) => items.find(i => i.id === id);

  const persist = () => saveSettings({
    emailsPath: byId('accounts').value,
    proxiesPath: byId('proxies').value,
    proxyType: byId('proxyType').value,
    concurrency: byId('workers').value,
    timeout: merged.timeout,
  });

  const countLines = (path) => {
    try {
      const raw = readFileSync(path, 'utf8');
      if (path.trim().toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.length : 1;
      }
      return raw.split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
    } catch { return null; }
  };

  const refreshInfo = () => {
    byId('accounts').info = countLines(byId('accounts').value) != null ? `${countLines(byId('accounts').value)} kont` : '✗ nie znaleziono';
    byId('proxies').info = countLines(byId('proxies').value) != null ? `${countLines(byId('proxies').value)} proxy` : '✗ nie znaleziono';
  };
  refreshInfo();

  const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

  const render = () => {
    const w = W(); const inner = w - 2;
    clearScreen(); hideCursor();
    for (let i = 0; i < BANNER.length; i++) {
      const pad = Math.max(0, Math.floor((w - BANNER_PLAIN_WIDTH) / 2));
      stdout.write(' '.repeat(pad) + bannerLine(i) + '\n');
    }
    const sub = 'CHECKTER BY KWASNY  ·  4 MORE WRITE TELEGRAM: @Kwasny2';
    const subPad = Math.max(0, Math.floor((w - sub.length) / 2));
    stdout.write(' '.repeat(subPad) + C.bold + C.red + 'CHECKTER BY KWASNY' + RESET + C.gray + '  ·  4 MORE WRITE TELEGRAM: ' + RESET + C.bold + '@Kwasny2' + RESET + '\n');
    stdout.write('\n');
    const row = (s) => { const p = plain(s); const pad = Math.max(0, inner - 2 - p.length); stdout.write(C.gray + '│ ' + RESET + s + ' '.repeat(pad) + C.gray + ' │' + RESET + '\n'); };
    const title = '  KONFIGURACJA  ';
    const tp = Math.floor((inner - title.length) / 2);
    stdout.write(C.gray + '┌' + '─'.repeat(inner) + '┐' + RESET + '\n');
    stdout.write(C.gray + '│' + ' '.repeat(tp) + C.bold + C.yellow + title + RESET + ' '.repeat(inner - tp - title.length) + C.gray + '│' + RESET + '\n');
    stdout.write(C.gray + '├' + '─'.repeat(inner) + '┤' + RESET + '\n');
    row('');
    const groups = [['accounts','proxies'],['proxyType'],['workers'],['check','start','exit']];
    for (let g = 0; g < groups.length; g++) {
      for (const id of groups[g]) {
        const i = items.findIndex(x => x.id === id); const it = items[i]; const sel = i === cursor;
        const arrow = sel ? `${C.cyan}${C.bold}❯${RESET} ` : '  ';
        const lblW = 12;
        if (it.type === 'file') {
          const exists = existsSync(it.value);
          const fc = exists ? C.green : C.yellow;
          const ic = (it.info || '').includes('✗') ? C.red : C.gray;
          row(`${arrow}${(sel ? C.bold : '')}${C.white}${it.label.padEnd(lblW)}${RESET} ${fc}${it.value}${RESET}  ${ic}${it.info}${RESET}`);
        } else if (it.type === 'fileselect') {
          const exists = existsSync(it.value);
          const fc = exists ? C.green : C.yellow;
          const ic = (it.info || '').includes('✗') ? C.red : C.gray;
          if (it.editing) {
            const opts = it.options.map((o, idx) => idx === it._sel ? `${C.yellow}${C.bold}[${o}]${RESET}` : `${C.gray} ${o} ${RESET}`).join('  ');
            row(`${arrow}${C.bold}${C.white}${it.label.padEnd(lblW)}${RESET} ${opts}  ${C.dim}${C.yellow}← → wybierz, Enter zatwierdź${RESET}`);
          } else {
            row(`${arrow}${(sel ? C.bold : '')}${C.white}${it.label.padEnd(lblW)}${RESET} ${fc}${it.value}${RESET}  ${ic}${it.info}${RESET}  ${C.dim}(Enter — wybierz plik)${RESET}`);
          }
        } else if (it.type === 'select') {
          const editing = sel && it.editing;
          const opts = it.options.map(o => o === it.value ? (editing ? `${C.yellow}${C.bold}[${o.toUpperCase()}]${RESET}` : `${C.cyan}${C.bold}[${o.toUpperCase()}]${RESET}`) : `${C.gray} ${o} ${RESET}`).join('  ');
          const hint = editing ? `  ${C.dim}${C.yellow}← → wybierz, Enter zatwierdź${RESET}` : '';
          row(`${arrow}${(sel ? C.bold : '')}${C.white}${it.label.padEnd(lblW)}${RESET} ${opts}${hint}`);
        } else if (it.type === 'number') {
          row(`${arrow}${(sel ? C.bold : '')}${C.white}${it.label.padEnd(lblW)}${RESET} ${C.gray}◄${RESET} ${C.cyan}${C.bold}${String(it.value).padStart(6)}${RESET} ${C.gray}►${RESET}  ${C.dim}(${it.min}–${it.max} co ${it.step}, Enter wpisz)${RESET}`);
        } else if (it.type === 'action') {
          row(`${arrow}${it.ac}${C.bold}[ ${it.label} ]${RESET}`);
        }
      }
      if (g < groups.length - 1) row('');
    }
    row('');
    if (checkResult) { row(`${C.gray}Ostatni check: ${C.green}${checkResult.valid} OK${RESET}  ${C.red}${checkResult.invalid} BAD${RESET}  z ${checkResult.total} proxy${RESET}`); row(''); }
    row(`${C.gray}↑↓ nawigacja  ←→ zmiana  Enter wpisz / potwierdź  Ctrl+C wyjście${RESET}`);
    stdout.write(C.gray + '└' + '─'.repeat(inner) + '┘' + RESET + '\n');
  };

  if (!stdin.isTTY) return { action: 'start', emailsPath: merged.emailsPath, proxiesPath: merged.proxiesPath, proxyType: merged.proxyType, concurrency: merged.concurrency, timeout: merged.timeout };

  return new Promise((resolve) => {
    render();
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const exitRaw = () => { stdin.setRawMode(false); stdin.pause(); };
    const askPath = (it) => new Promise(res => {
      exitRaw(); showCursor();
      const rl = readline.createInterface({ input: stdin, output: stdout });
      stdout.write(`\n${C.cyan}?${RESET} ${it.label} [${it.value}]: `);
      rl.once('line', (ans) => {
        rl.close();
        const v = ans.trim();
        if (v) it.value = v;
        refreshInfo(); persist(); stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8'); hideCursor(); render(); res();
      });
    });
    const askNumber = (it) => new Promise(res => {
      exitRaw(); showCursor();
      const rl = readline.createInterface({ input: stdin, output: stdout });
      stdout.write(`\n${C.cyan}?${RESET} ${it.label} [${it.value}] (${it.min}–${it.max}): `);
      rl.once('line', (ans) => { rl.close(); const n = parseInt(ans.trim(), 10); if (Number.isFinite(n)) it.value = Math.min(it.max, Math.max(it.min, n)); persist(); stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8'); hideCursor(); render(); res(); });
    });
    let busy = false;
    const onData = async (key) => {
      if (busy) return;
      if (key === '\x03') { exitRaw(); showCursor(); process.exit(0); }
      const it = items[cursor];
      const selectEditing = (it.type === 'select' || it.type === 'fileselect') && it.editing;
      if (key === '\x1b' && selectEditing) { it.editing = false; render(); return; }
      if (key === '\x1b[A') { if (selectEditing) return; do { cursor = (cursor - 1 + items.length) % items.length; } while (!items[cursor].type); render(); return; }
      if (key === '\x1b[B') { if (selectEditing) return; do { cursor = (cursor + 1) % items.length; } while (!items[cursor].type); render(); return; }      if (key === '\x1b[C') { if (it.type === 'select' && it.editing) { const i = it.options.indexOf(it.value); it.value = it.options[(i + 1) % it.options.length]; refreshInfo(); render(); } else if (it.type === 'fileselect' && it.editing) { it._sel = (it._sel + 1) % it.options.length; render(); } else if (it.type === 'number') { it.value = Math.min(it.max, it.value + it.step); persist(); render(); } return; }
      if (key === '\x1b[D') { if (it.type === 'select' && it.editing) { const i = it.options.indexOf(it.value); it.value = it.options[(i - 1 + it.options.length) % it.options.length]; refreshInfo(); render(); } else if (it.type === 'fileselect' && it.editing) { it._sel = (it._sel - 1 + it.options.length) % it.options.length; render(); } else if (it.type === 'number') { it.value = Math.max(it.min, it.value - it.step); persist(); render(); } return; }
      if (key === '\r' || key === '\n') {
        if (it.type === 'file') { busy = true; stdin.off('data', onData); await askPath(it); stdin.on('data', onData); busy = false; }
        else if (it.type === 'fileselect') {
          if (!it.editing) {
            // Skanuj folder Proxy/ i pokaż dostępne pliki
            let files = [];
            try { files = readdirSync(it.dir).filter(f => !f.startsWith('.')); } catch {}
            if (files.length === 0) {
              // Brak plików w folderze — fallback do ręcznego wpisania
              busy = true; stdin.off('data', onData); await askPath(it); stdin.on('data', onData); busy = false;
            } else {
              it.options = files;
              const curIdx = files.indexOf(it.value.replace(/^Proxy\//, '').replace(/^Proxy\\/, ''));
              it._sel = curIdx >= 0 ? curIdx : 0;
              it.editing = true;
              render();
            }
          } else {
            // Zatwierdź wybór
            it.value = it.dir + '/' + it.options[it._sel];
            it.editing = false;
            refreshInfo(); persist(); render();
          }
        }
        else if (it.type === 'number') { busy = true; stdin.off('data', onData); await askNumber(it); stdin.on('data', onData); busy = false; }
        else if (it.type === 'select') { if (!it.editing) { it.editing = true; } else { it.editing = false; persist(); } refreshInfo(); render(); }
        else if (it.type === 'action') { persist(); exitRaw(); showCursor(); stdin.off('data', onData); resolve({ action: it.key, emailsPath: byId('accounts').value, proxiesPath: byId('proxies').value, proxyType: byId('proxyType').value, concurrency: byId('workers').value, timeout: merged.timeout }); }
      }
    };
    stdin.on('data', onData);
  });
}