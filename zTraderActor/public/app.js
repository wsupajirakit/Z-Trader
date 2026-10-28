/* global io */
// Dashboard for zTraderActor. Loaded as a module; no inline scripts or handlers (strict CSP).
// All server data is rendered with textContent / DOM nodes, never innerHTML.

const $ = (id) => document.getElementById(id);

/** Tiny DOM builder: h('span', { className: 't' }, 'text', childNode) */
function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k in el) el[k] = v;
        else el.setAttribute(k, v);
    }
    for (const c of children) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : String(c));
    }
    return el;
}

const session = { user: null, csrf: null, socket: null, timers: [] };
let MODES = [];
let lastActivityId = 0;

// ---------- HTTP ----------
class AuthError extends Error {}

async function api(path, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/json' };
    if (method !== 'GET') {
        headers['content-type'] = 'application/json';
        if (session.csrf) headers['x-csrf-token'] = session.csrf;
    }
    const r = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
    });
    if (r.status === 401 && path !== '/login') {
        showLogin('Your session has ended. Please sign in again.');
        throw new AuthError('signed out');
    }
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
}

const canOperate = () => session.user && (session.user.role === 'operator' || session.user.role === 'admin');

// ---------- login / logout ----------
function showLogin(message = '') {
    stopDashboard();
    session.user = null;
    session.csrf = null;
    $('appView').hidden = true;
    $('loginView').hidden = false;
    $('loginMsg').textContent = message;
    $('loginPass').value = '';
    $('loginUser').focus();
}

async function onLoginSubmit(ev) {
    ev.preventDefault();
    $('btnLogin').disabled = true;
    $('loginMsg').textContent = '';
    try {
        const { status, data } = await api('/login', {
            method: 'POST',
            body: { username: $('loginUser').value, password: $('loginPass').value },
        });
        $('loginPass').value = '';
        if (status === 200) return startDashboard(data);
        if (status === 429) {
            $('loginMsg').textContent = `Too many attempts. Try again in ${data.retryAfterSec ?? 60} s.`;
        } else if (status === 403 && data.error === 'PASSWORD_CHANGE_REQUIRED') {
            $('loginMsg').textContent = data.message;
        } else if (status === 401 || status === 400) {
            $('loginMsg').textContent = 'Invalid username or password.';
        } else {
            $('loginMsg').textContent = 'Sign-in is unavailable right now. Please try again later.';
        }
    } catch {
        $('loginMsg').textContent = 'Network error.';
    } finally {
        $('btnLogin').disabled = false;
    }
}

async function logout() {
    try {
        await api('/logout', { method: 'POST' });
    } catch {
        /* already signed out */
    }
    showLogin('Signed out.');
}

// ---------- dashboard lifecycle ----------
function startDashboard({ user, csrfToken }) {
    session.user = user;
    session.csrf = csrfToken;
    $('loginView').hidden = true;
    $('appView').hidden = false;
    applyRole();

    connectSocket();
    lastActivityId = 0;
    $('log').replaceChildren();
    pollActivity();
    loadModes().then(refreshStatus);
    loadSettings();
    refreshPositions();
    refreshArchive();
    session.timers.push(
        setInterval(pollActivity, 5000),
        setInterval(refreshStatus, 5000),
        setInterval(refreshPositions, 10000),
        setInterval(refreshArchive, 30000),
        setInterval(refreshMe, 60000),
    );
}

/** Enables/disables operator controls for the current role. */
function applyRole() {
    const { user } = session;
    $('userBadge').textContent = `${user.username} · ${user.role}`;
    const op = canOperate();
    $('readonlyNote').hidden = op;
    for (const el of document.querySelectorAll('.op, #loopChecks input')) el.disabled = !op;
}

/** Picks up role changes made on the main dashboard (the server re-checks every 60 s). */
async function refreshMe() {
    try {
        const { ok, data } = await api('/me');
        if (!ok) return;
        const changed = data.user.role !== session.user.role;
        session.user = data.user;
        session.csrf = data.csrfToken;
        if (changed) {
            applyRole();
            addLog(`[ทำ] role changed: ${data.user.role}`, 'warn');
        }
    } catch {
        /* signed out or offline */
    }
}

function stopDashboard() {
    session.timers.forEach(clearInterval);
    session.timers = [];
    if (session.socket) {
        session.socket.disconnect();
        session.socket = null;
    }
}

// ---------- log stream (socket.io from the Actor; authenticated sockets only) ----------
function connectSocket() {
    const socket = io({ withCredentials: true });
    session.socket = socket;
    socket.on('log', (d) => addLog(d.message, d.type === 'error' ? 'error' : 'info'));
    socket.on('orderLog', (d) => addLog(d.message, 'order'));
    socket.on('marketUpdate', (d) => {
        if (d.symbol === 'XAUUSD' && d.price) $('price').textContent = Number(d.price).toFixed(2);
    });
    socket.on('connect_error', (err) => {
        if (err.message === 'unauthorized') {
            socket.disconnect();
            api('/me').catch(() => {}); // a 401 here takes us back to the login screen
        }
    });
    socket.on('disconnect', (reason) => {
        // "io server disconnect" = the server ended our session (logout elsewhere / expiry)
        if (reason === 'io server disconnect' && session.user) api('/me').catch(() => {});
    });
}

function appendLogLine(el) {
    const log = $('log');
    log.appendChild(el);
    while (log.children.length > 400) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
}

function addLog(msg, cls) {
    const t = new Date().toLocaleTimeString('th-TH');
    appendLogLine(h('div', {}, h('span', { className: 't' }, `[${t}]`), h('span', { className: cls }, msg)));
}

// ---------- gold bot activity feed (poll every 5 s) ----------
function addActivity(e) {
    const cls = e.level === 'error' ? 'error' : e.level === 'ok' ? 'order' : e.level === 'warn' ? 'warn' : 'info';
    appendLogLine(
        h(
            'div',
            {},
            h('span', { className: 't' }, `[${e.bkk}]`),
            e.mode ? h('span', { className: 'mtag' }, e.mode) : null,
            e.mode ? ' ' : null,
            h('span', { className: cls }, e.message),
        ),
    );
}

async function pollActivity() {
    try {
        const { ok, data: d } = await api('/api/gold/activity?after=' + lastActivityId);
        if (!ok) return;
        if (lastActivityId === 0 && d.latest_id > 20) lastActivityId = d.latest_id - 20; // first load: last 20 lines only
        for (const e of d.entries || []) {
            if (e.id <= lastActivityId) continue;
            lastActivityId = e.id;
            addActivity(e);
        }
    } catch {
        /* service down or signed out */
    }
}

// ---------- modes (real modes from the service) ----------
async function loadModes() {
    try {
        const { data: d } = await api('/api/gold/modes');
        MODES = d.modes || [];
    } catch {
        MODES = [];
    }
    $('modeSel').replaceChildren(...MODES.map((m) => new Option(`${m.mode} — R:R ≥ ${m.rr_min}`, m.mode)));
    $('loopChecks').replaceChildren(
        ...MODES.map((m) =>
            h(
                'label',
                {},
                h('input', { type: 'checkbox', value: m.mode, checked: m.mode === 'swing', disabled: !canOperate() }),
                ' ' + m.mode,
            ),
        ),
    );
    updateHint();
}

function updateHint() {
    const m = MODES.find((x) => x.mode === $('modeSel').value);
    $('modeHint').textContent = m ? `${m.horizon} · ${m.tf_roles}` : '';
}

// ---------- actions (operator+) ----------
async function runOnce() {
    const mode = $('modeSel').value;
    $('btnRun').disabled = true;
    addLog(`[ทำ] สั่ง run รอบเดียว mode=${mode} …`, 'info');
    try {
        const { data: d } = await api('/api/gold/run', { method: 'POST', body: { mode, force: true } });
        const outcome = d.outcome || d.error || JSON.stringify(d);
        addLog(`[ผล ${mode}] ${outcome}`, String(d.outcome || '').startsWith('order sent') ? 'order' : 'info');
    } catch (e) {
        if (!(e instanceof AuthError)) addLog('run error: ' + e.message, 'error');
    }
    $('btnRun').disabled = !canOperate();
    refreshStatus();
}

async function setLoop(enabled) {
    const modes = Array.from(document.querySelectorAll('#loopChecks input:checked')).map((c) => c.value);
    if (enabled && !modes.length) return alert('เลือกอย่างน้อย 1 โหมด');
    try {
        const { ok, data } = await api('/api/gold/automate', { method: 'POST', body: { enabled, modes } });
        if (!ok) return addLog('automate error: ' + (data.error || data.message || 'failed'), 'error');
        addLog('[ทำ] auto loop ' + (enabled ? 'STARTED: ' + modes.join(', ') : 'STOPPED'), enabled ? 'order' : 'info');
    } catch {
        return;
    }
    refreshStatus();
}

// ---------- risk settings ----------
async function loadSettings() {
    try {
        const { ok, data: s } = await api('/api/gold/settings');
        if (!ok) throw new Error();
        $('s_risk').value = s.risk_usd_per_trade;
        $('s_daily').value = s.daily_max_loss_usd;
        $('s_maxpos').value = s.max_open_positions;
        $('s_scalp').value = s.scalp_max_per_day;
        $('s_conf').value = s.min_confidence;
        $('s_maxlot').value = s.max_lot;
        const overridden = s.overridden || [];
        $('setNote').textContent =
            'sizing: ' +
            s.sizing +
            (overridden.length ? ` · แก้จาก dashboard ${overridden.length} ค่า` : ' · ใช้ค่าจาก .env');
    } catch {
        $('setNote').textContent = 'โหลดค่าไม่ได้';
    }
}

async function saveSettings() {
    $('btnSave').disabled = true;
    try {
        const body = {
            risk_usd_per_trade: $('s_risk').value,
            daily_max_loss_usd: $('s_daily').value,
            max_open_positions: $('s_maxpos').value,
            scalp_max_per_day: $('s_scalp').value,
            min_confidence: $('s_conf').value,
            max_lot: $('s_maxlot').value,
        };
        const { ok, data: d } = await api('/api/gold/settings', { method: 'POST', body });
        if (!ok) {
            $('setNote').textContent = '❌ ' + (d.message || d.error || 'บันทึกไม่สำเร็จ');
        } else {
            $('setNote').textContent = '✅ บันทึกแล้ว (มีผลทันที · อยู่จนกว่าจะรีสตาร์ท service)';
            addLog(
                `[ทำ] ตั้งค่าความเสี่ยงใหม่: เสี่ยง $${d.risk_usd_per_trade}/ไม้ · daily stop $${d.daily_max_loss_usd} · ไม้ค้าง ${d.max_open_positions}`,
                'warn',
            );
            loadSettings();
        }
    } catch (e) {
        if (!(e instanceof AuthError)) $('setNote').textContent = '❌ ' + e.message;
    }
    $('btnSave').disabled = !canOperate();
}

// ---------- live status (real state from /gold/status) ----------
function outcomeClass(o) {
    if (!o) return 'no';
    if (o.startsWith('order sent')) return 'ok';
    if (o.startsWith('error')) return 'err';
    if (o.startsWith('awaiting')) return 'wait';
    return 'no';
}

function modeCard(m, s) {
    const st = (s.state || {})[m];
    const pend = (s.pending || {})[m];
    const dec = st && st.lastDecision;
    const decTxt =
        dec && dec.order_type !== 'NO_TRADE'
            ? `${dec.order_type} @ ${dec.entry} · SL ${dec.sl} · TP1 ${dec.tp1} · RR ${dec.rr_tp1} · conf ${dec.confidence}`
            : '';
    const outcome = st && st.lastOutcome;
    return h(
        'div',
        { className: 'mode-card' },
        h(
            'div',
            { className: 'mc-head' },
            h('span', { className: 'mc-name' }, m),
            h(
                'span',
                { className: 'mc-time' },
                st && st.lastRunAt ? new Date(st.lastRunAt).toLocaleTimeString('th-TH') : 'ยังไม่เคยรัน',
            ),
        ),
        pend
            ? h(
                  'div',
                  { className: 'mc-outcome wait' },
                  `⏳ รอ Claude ตรวจ (id ${pend.id}, เหลือ ${pend.ttl_sec}s): ${pend.order}`,
              )
            : null,
        h('div', { className: 'mc-outcome ' + outcomeClass(outcome) }, outcome || '—'),
        decTxt ? h('div', { className: 'mc-dec' }, decTxt) : null,
    );
}

async function refreshStatus() {
    try {
        const { ok, data: s } = await api('/api/gold/status');
        if (!ok) return;
        const acc = $('accBadge');
        acc.textContent = s.accountMode;
        acc.className = 'badge ' + (s.accountMode === 'LIVE' ? 'live' : 'demo');
        $('engineBadge').textContent = 'engine: ' + String(s.engine || '?').toUpperCase();
        $('ctDot').className = 'dot ' + (s.ctraderAuthorized ? 'on' : 'off');
        if (s.price && s.price.bid) $('price').textContent = Number(s.price.bid).toFixed(2);
        $('btnStart').hidden = Boolean(s.enabled);
        $('btnStop').hidden = !s.enabled;
        $('statTime').textContent = '· loop ' + (s.enabled ? '🟢 ON: ' + (s.modes || []).join(', ') : '⚪ OFF');

        const allModes = MODES.length ? MODES.map((m) => m.mode) : Object.keys(s.state || {});
        $('statGrid').replaceChildren(...allModes.map((m) => modeCard(m, s)));
    } catch {
        /* service down — badges stay */
    }
}

// ---------- positions ----------
const toLots = (v) => (Number(v) / 10000).toFixed(2);

async function refreshPositions() {
    try {
        const { ok, data: d } = await api('/api/gold/positions');
        if (!ok) throw new Error();
        const raw = Array.isArray(d) ? d : d.position || d.positions || [];
        const list = raw.filter((p) => Number(p && p.tradeData && p.tradeData.symbolId) === 41);
        if (!list.length) {
            $('positions').textContent = 'ไม่มีไม้ค้าง';
            return;
        }
        const head = h('tr', {}, ...['Side', 'Lots', 'Entry', 'SL', 'TP'].map((t) => h('th', {}, t)));
        const rows = list.map((p) => {
            const side = p.tradeData && p.tradeData.tradeSide === 1 ? 'BUY' : 'SELL';
            return h(
                'tr',
                {},
                h('td', { className: side.toLowerCase() }, side),
                h('td', {}, toLots(p.tradeData && p.tradeData.volume)),
                h('td', {}, Number(p.price).toFixed(2)),
                h('td', {}, p.stopLoss ? Number(p.stopLoss).toFixed(2) : '—'),
                h('td', {}, p.takeProfit ? Number(p.takeProfit).toFixed(2) : '—'),
            );
        });
        $('positions').replaceChildren(h('table', {}, head, ...rows));
    } catch (e) {
        if (!(e instanceof AuthError)) $('positions').textContent = 'โหลดไม่ได้';
    }
}

// ---------- archive ----------
async function refreshArchive() {
    try {
        const { ok, data: d } = await api('/api/gold/archive?limit=8');
        if (!ok || !Array.isArray(d)) return;
        const links = d
            .filter((a) => typeof a.file === 'string' && a.file.split('/').length === 2)
            .map((a) => {
                const o = a.outcome || '';
                const icon = o.startsWith('order sent')
                    ? '🟢'
                    : o.startsWith('error')
                      ? '🔴'
                      : o.startsWith('awaiting')
                        ? '🟡'
                        : '⚪';
                const short = o.length > 46 ? o.slice(0, 46) + '…' : o;
                const [mode, file] = a.file.split('/');
                return h(
                    'a',
                    {
                        href: `/api/gold/archive/${encodeURIComponent(mode)}/${encodeURIComponent(file)}`,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                        title: o,
                    },
                    `${icon} ${file.replace('.json', '')} — `,
                    h('span', { className: 'muted' }, short),
                );
            });
        if (links.length) $('archList').replaceChildren(...links);
        else $('archList').textContent = 'ยังไม่มีประวัติ';
    } catch {
        /* ignore */
    }
}

// ---------- wiring ----------
$('loginForm').addEventListener('submit', onLoginSubmit);
$('btnLogout').addEventListener('click', logout);
$('btnRun').addEventListener('click', runOnce);
$('btnStart').addEventListener('click', () => setLoop(true));
$('btnStop').addEventListener('click', () => setLoop(false));
$('btnSave').addEventListener('click', saveSettings);
$('modeSel').addEventListener('change', updateHint);

// Resume an existing session, otherwise show the login form.
fetch('/me', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    .then(async (r) => (r.ok ? startDashboard(await r.json()) : showLogin()))
    .catch(() => showLogin('Cannot reach the server.'));
