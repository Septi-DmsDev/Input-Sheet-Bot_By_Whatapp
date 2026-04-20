const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs');
const http = require('http');
const { google } = require('googleapis');

const sheetsConfig = JSON.parse(fs.readFileSync('./sheets-config.json'));
const FIXED_TIMES = { "1": "10.00", "2": "14.00", "3": "16.00", "4": "19.00" };
const groupNameCache = new Map();
const messageCache = new Map();

const HEALTH_PORT = Number(process.env.HEALTH_PORT || process.env.PORT || 3000);
const BOOT_WATCHDOG_MS = Number(process.env.WA_BOOT_WATCHDOG_MS || 180000);
const RECONNECT_DELAY_MS = Number(process.env.WA_RECONNECT_DELAY_MS || 5000);
const LIVENESS_INTERVAL_MS = Number(process.env.WA_LIVENESS_INTERVAL_MS || 120000);
const LIVENESS_TIMEOUT_MS = Number(process.env.WA_LIVENESS_TIMEOUT_MS || 15000);
const LIVENESS_MAX_FAILURES = Number(process.env.WA_LIVENESS_MAX_FAILURES || 2);
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS || 20000);
const WEBHOOK_MAX_RETRIES = Number(process.env.WEBHOOK_MAX_RETRIES || 3);
const WEBHOOK_RETRY_DELAY_MS = Number(process.env.WEBHOOK_RETRY_DELAY_MS || 2000);
const WEBHOOK_FAILURE_LOG = process.env.WEBHOOK_FAILURE_LOG || './failed_webhooks.ndjson';
const SHEETS_REQUEST_MIN_INTERVAL_MS = Number(process.env.SHEETS_REQUEST_MIN_INTERVAL_MS || 1100);
const SHEETS_LOOKUP_CACHE_TTL_MS = Number(process.env.SHEETS_LOOKUP_CACHE_TTL_MS || 21600000);
const SHEETS_NEGATIVE_LOOKUP_CACHE_TTL_MS = Number(process.env.SHEETS_NEGATIVE_LOOKUP_CACHE_TTL_MS || 300000);
const SHEETS_429_RETRY_DELAY_MS = Number(process.env.SHEETS_429_RETRY_DELAY_MS || 15000);
const HEALTH_MAX_STALENESS_MS = Number(
    process.env.WA_HEALTH_MAX_STALENESS_MS || (LIVENESS_INTERVAL_MS + LIVENESS_TIMEOUT_MS + 30000)
);

let watchdogTimer = null;
let livenessTimer = null;
let reconnectTimer = null;
let activeSock = null;
let activeGeneration = 0;
let activeConnectionState = 'close';
let isProbeRunning = false;
let consecutiveProbeFailures = 0;
let lastSuccessfulProbeAt = 0;
let lastConnectionOpenAt = 0;
let lastDisconnectReason = 'boot';
let isShuttingDown = false;
let sheetsClientPromise = null;
let sheetsRequestChain = Promise.resolve();
let lastSheetsRequestAt = 0;
const sheetsRowCache = new Map();

function normalizeJid(jid) {
    return jid ? jid.replace(/:\d+@/, '@') : jid;
}

function forceExit(message, code = 1) {
    console.error(message);
    process.exit(code);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSheetsRequest(task) {
    const runner = async () => {
        const now = Date.now();
        const waitMs = Math.max(0, lastSheetsRequestAt + SHEETS_REQUEST_MIN_INTERVAL_MS - now);
        if (waitMs > 0) {
            await sleep(waitMs);
        }

        const result = await task();
        lastSheetsRequestAt = Date.now();
        return result;
    };

    const pending = sheetsRequestChain.then(runner, runner);
    sheetsRequestChain = pending.catch(() => {});
    return pending;
}

function getSheetsLookupCacheKey(spreadsheetId, sheetName, kode, lookupColumn) {
    return [spreadsheetId, sheetName, lookupColumn, normalizeCellValue(kode)].join('::');
}

function getCachedRowLookup(cacheKey) {
    const cached = sheetsRowCache.get(cacheKey);
    if (!cached) return undefined;

    if (cached.expiresAt <= Date.now()) {
        sheetsRowCache.delete(cacheKey);
        return undefined;
    }

    return cached.rowNumber;
}

function setCachedRowLookup(cacheKey, rowNumber, ttlMs) {
    sheetsRowCache.set(cacheKey, {
        rowNumber,
        expiresAt: Date.now() + ttlMs
    });
}

function truncate(value, max = 300) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function startWatchdog() {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
        forceExit(`[WATCHDOG FATAL] Bot gagal open dalam ${BOOT_WATCHDOG_MS} ms. Force exit.`);
    }, BOOT_WATCHDOG_MS);
}

function stopWatchdog() {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    console.log('[WATCHDOG SAFE] Boot watchdog dihentikan.');
}

function clearLivenessProbe() {
    clearInterval(livenessTimer);
    livenessTimer = null;
    isProbeRunning = false;
}

function destroySocket(sock) {
    if (!sock) return;

    try {
        sock.ev.removeAllListeners();
    } catch {}

    try {
        sock.ws?.close?.();
    } catch {}
}

function getHealthSnapshot() {
    const now = Date.now();
    const lastProbeReference = lastSuccessfulProbeAt || lastConnectionOpenAt || 0;
    const probeAgeMs = lastProbeReference ? now - lastProbeReference : null;
    const ok =
        !isShuttingDown &&
        activeConnectionState === 'open' &&
        probeAgeMs !== null &&
        probeAgeMs <= HEALTH_MAX_STALENESS_MS &&
        consecutiveProbeFailures < LIVENESS_MAX_FAILURES;

    return {
        ok,
        connection: activeConnectionState,
        lastProbeAt: lastSuccessfulProbeAt || null,
        lastConnectionOpenAt: lastConnectionOpenAt || null,
        probeAgeMs,
        consecutiveProbeFailures,
        lastDisconnectReason
    };
}

function startHealthServer() {
    const server = http.createServer((req, res) => {
        if (req.url !== '/healthz' && req.url !== '/readyz') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'not_found' }));
            return;
        }

        const snapshot = getHealthSnapshot();
        res.writeHead(snapshot.ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot));
    });

    server.listen(HEALTH_PORT, '0.0.0.0', () => {
        console.log(`[HEALTH] Endpoint aktif di :${HEALTH_PORT}/healthz`);
    });
}

function scheduleReconnect(reason = 'unknown') {
    if (isShuttingDown || reconnectTimer) return;

    console.log(`[RECONNECT] Menjadwalkan reconnect dalam ${RECONNECT_DELAY_MS} ms. reason=${reason}`);
    startWatchdog();
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToWhatsApp().catch((error) => {
            forceExit(`[RECONNECT] Gagal membuat socket baru: ${error.stack || error.message}`);
        });
    }, RECONNECT_DELAY_MS);
}

async function runLivenessProbe(sock, generation) {
    if (isShuttingDown || generation !== activeGeneration || activeConnectionState !== 'open' || isProbeRunning) {
        return;
    }

    const botJid = normalizeJid(sock?.user?.id);
    if (!botJid) {
        forceExit('[LIVENESS] sock.user.id tidak tersedia. Force exit.');
        return;
    }

    isProbeRunning = true;
    let timeoutHandle = null;

    try {
        await Promise.race([
            sock.fetchStatus(botJid),
            new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => {
                    reject(new Error(`fetchStatus timeout ${LIVENESS_TIMEOUT_MS} ms`));
                }, LIVENESS_TIMEOUT_MS);
            })
        ]);

        consecutiveProbeFailures = 0;
        lastSuccessfulProbeAt = Date.now();
        console.log(`[LIVENESS] OK jid=${botJid}`);
    } catch (error) {
        consecutiveProbeFailures += 1;
        console.error(`[LIVENESS] FAIL ${consecutiveProbeFailures}/${LIVENESS_MAX_FAILURES}: ${error.message}`);

        if (consecutiveProbeFailures >= LIVENESS_MAX_FAILURES) {
            forceExit('[LIVENESS] Batas gagal terlampaui. Force exit untuk trigger auto-heal.');
        }
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        isProbeRunning = false;
    }
}

function startLivenessProbe(sock, generation) {
    clearLivenessProbe();
    consecutiveProbeFailures = 0;
    lastSuccessfulProbeAt = Date.now();

    livenessTimer = setInterval(() => {
        runLivenessProbe(sock, generation).catch((error) => {
            forceExit(`[LIVENESS] Unexpected probe error: ${error.stack || error.message}`);
        });
    }, LIVENESS_INTERVAL_MS);

    runLivenessProbe(sock, generation).catch((error) => {
        forceExit(`[LIVENESS] Initial probe error: ${error.stack || error.message}`);
    });
}

function shutdown(signal) {
    if (isShuttingDown) return;

    isShuttingDown = true;
    console.log(`[SHUTDOWN] Signal ${signal} diterima. Menutup bot.`);
    clearTimeout(watchdogTimer);
    clearTimeout(reconnectTimer);
    clearLivenessProbe();
    destroySocket(activeSock);
    setTimeout(() => process.exit(0), 250);
}

async function safeReact(sock, jid, key, emoji) {
    try {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await sock.sendMessage(jid, { react: { text: emoji, key } });
    } catch (e) {
        console.error(`Gagal react ${emoji}:`, e.message);
    }
}

function appendWebhookFailure(entry) {
    try {
        fs.appendFileSync(WEBHOOK_FAILURE_LOG, `${JSON.stringify(entry)}\n`);
    } catch (error) {
        console.error(`[WEBHOOK] Gagal menulis failure spool: ${error.message}`);
    }
}

function isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function parseWebhookResponse(res) {
    const bodyText = await res.text();
    const contentType = res.headers.get('content-type') || '';
    let data = null;

    try {
        data = bodyText ? JSON.parse(bodyText) : null;
    } catch {}

    const success =
        (data && (data.success === true || String(data.success).toLowerCase() === 'true')) ||
        bodyText.trim().toLowerCase() === 'ok';

    return {
        ok: res.ok,
        status: res.status,
        contentType,
        bodyText,
        data,
        success
    };
}

function getGoogleServiceAccountRaw() {
    const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
    if (encoded) {
        try {
            return Buffer.from(encoded, 'base64').toString('utf8');
        } catch (error) {
            throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not valid base64: ${error.message}`);
        }
    }

    return process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
}

function hasGoogleSheetsAuth() {
    return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 || process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function getSheetRange(sheetName, a1Range) {
    const escapedSheetName = String(sheetName).replace(/'/g, "''");
    return `'${escapedSheetName}'!${a1Range}`;
}

function columnNumberToLetter(columnNumber) {
    let value = Number(columnNumber);
    let result = '';

    while (value > 0) {
        const remainder = (value - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        value = Math.floor((value - 1) / 26);
    }

    return result;
}

function normalizeCellValue(value) {
    return String(value || '').trim().toUpperCase();
}

async function getSheetsClient() {
    if (!sheetsClientPromise) {
        sheetsClientPromise = (async () => {
            const raw = getGoogleServiceAccountRaw();
            if (!raw) {
                throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_B64 is missing');
            }

            let credentials;
            try {
                credentials = JSON.parse(raw);
            } catch (error) {
                throw new Error(`Google service account JSON is invalid: ${error.message}`);
            }

            const auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets']
            });
            const client = await auth.getClient();
            return google.sheets({ version: 'v4', auth: client });
        })().catch((error) => {
            sheetsClientPromise = null;
            throw error;
        });
    }

    return sheetsClientPromise;
}

async function findRowByKode({ sheets, spreadsheetId, sheetName, kode, lookupColumn = 1 }) {
    const cacheKey = getSheetsLookupCacheKey(spreadsheetId, sheetName, kode, lookupColumn);
    const cachedRowNumber = getCachedRowLookup(cacheKey);
    if (cachedRowNumber !== undefined) {
        return cachedRowNumber;
    }

    const lookupLetter = columnNumberToLetter(lookupColumn);
    const range = getSheetRange(sheetName, `${lookupLetter}:${lookupLetter}`);
    const res = await runSheetsRequest(() => sheets.spreadsheets.values.get({
        spreadsheetId,
        range
    }));

    const rows = res.data.values || [];
    const targetKode = normalizeCellValue(kode);

    for (let index = 0; index < rows.length; index += 1) {
        if (normalizeCellValue(rows[index]?.[0]) === targetKode) {
            const rowNumber = index + 1;
            setCachedRowLookup(cacheKey, rowNumber, SHEETS_LOOKUP_CACHE_TTL_MS);
            return rowNumber;
        }
    }

    setCachedRowLookup(cacheKey, null, SHEETS_NEGATIVE_LOOKUP_CACHE_TTL_MS);
    return null;
}

async function writePayloadToSheet(config, payload) {
    const spreadsheetId = config?.spreadsheet_id;
    if (!spreadsheetId) {
        throw new Error('spreadsheet_id is missing in config');
    }

    const sheetName = payload.sheet || config.sheet;
    const lookupColumn = Number(config.lookup_column || 1);
    const offset = Number(payload.offset || 0);
    const sheets = await getSheetsClient();
    const rowNumber = await findRowByKode({
        sheets,
        spreadsheetId,
        sheetName,
        kode: payload.kode,
        lookupColumn
    });

    if (!rowNumber) {
        throw new Error(`kode ${payload.kode} not found on sheet ${sheetName}`);
    }

    const targetRow = rowNumber + offset;
    const data = [];

    if (payload.kolom && payload.timestamp) {
        data.push({
            range: getSheetRange(sheetName, `${columnNumberToLetter(payload.kolom)}${targetRow}`),
            values: [[payload.timestamp]]
        });
    }

    if (payload.kolomNama && payload.namaPetugas) {
        data.push({
            range: getSheetRange(sheetName, `${columnNumberToLetter(payload.kolomNama)}${targetRow}`),
            values: [[payload.namaPetugas]]
        });
    }

    if (payload.kolom_petugas && payload.petugas) {
        data.push({
            range: getSheetRange(sheetName, `${columnNumberToLetter(payload.kolom_petugas)}${targetRow}`),
            values: [[payload.petugas]]
        });
    }

    if (!data.length) {
        throw new Error(`no update data generated for ${payload.kode}`);
    }

    await runSheetsRequest(() => sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'USER_ENTERED',
            data
        }
    }));

    const cacheKey = getSheetsLookupCacheKey(spreadsheetId, sheetName, payload.kode, lookupColumn);
    setCachedRowLookup(cacheKey, rowNumber, SHEETS_LOOKUP_CACHE_TTL_MS);

    return {
        success: true,
        spreadsheetId,
        sheetName,
        rowNumber: targetRow
    };
}

function getGoogleErrorStatus(error) {
    return Number(
        error?.code ||
        error?.response?.status ||
        error?.status
    ) || 0;
}

async function callSheetsApi(tag, config, payload) {
    let lastError = null;

    for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt += 1) {
        try {
            const result = await writePayloadToSheet(config, payload);
            if (attempt > 1) {
                console.log(`[SHEETS ${tag}] RECOVERED attempt=${attempt} row=${result.rowNumber}`);
            }
            return result;
        } catch (error) {
            lastError = error;
            const status = getGoogleErrorStatus(error);
            console.error(`[SHEETS ${tag}] RETRY attempt=${attempt}/${WEBHOOK_MAX_RETRIES} status=${status || 'unknown'} error=${error.message}`);

            if (!(status === 408 || status === 425 || status === 429 || status >= 500)) {
                break;
            }

            if (attempt < WEBHOOK_MAX_RETRIES) {
                const delayMs = status === 429
                    ? SHEETS_429_RETRY_DELAY_MS * attempt
                    : WEBHOOK_RETRY_DELAY_MS * attempt;
                await sleep(delayMs);
            }
        }
    }

    appendWebhookFailure({
        failedAt: new Date().toISOString(),
        tag,
        type: 'sheets_api',
        spreadsheetId: config?.spreadsheet_id || null,
        sheet: payload?.sheet || config?.sheet || null,
        payload,
        error: lastError?.message || 'unknown_sheets_error'
    });

    throw lastError || new Error('unknown_sheets_error');
}

async function callDataSink(tag, config, payload) {
    if (config?.spreadsheet_id && hasGoogleSheetsAuth()) {
        console.log(`[DATASINK] tag=${tag} prefix=${payload?.sheet || config?.sheet || 'unknown'} mode=sheets_api`);
        return callSheetsApi(tag, config, payload);
    }

    console.log(`[DATASINK] tag=${tag} prefix=${payload?.sheet || config?.sheet || 'unknown'} mode=webhook`);
    return callWebhook(tag, config.webhook, payload);
}

async function callWebhook(tag, url, payload) {
    let lastError = null;

    for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt += 1) {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            const parsed = await parseWebhookResponse(res);
            clearTimeout(timeoutHandle);

            if (parsed.success) {
                if (attempt > 1) {
                    console.log(`[WEBHOOK ${tag}] RECOVERED attempt=${attempt} status=${parsed.status}`);
                }
                return parsed;
            }

            const details =
                `status=${parsed.status} ok=${parsed.ok} contentType=${parsed.contentType || 'unknown'} body=${truncate(parsed.bodyText)}`;
            lastError = new Error(details);

            if (!isRetryableStatus(parsed.status)) {
                break;
            }

            console.error(`[WEBHOOK ${tag}] RETRY attempt=${attempt}/${WEBHOOK_MAX_RETRIES} ${details}`);
        } catch (error) {
            clearTimeout(timeoutHandle);
            const message = error.name === 'AbortError'
                ? `timeout ${WEBHOOK_TIMEOUT_MS} ms`
                : (error.message || String(error));
            lastError = new Error(message);
            console.error(`[WEBHOOK ${tag}] RETRY attempt=${attempt}/${WEBHOOK_MAX_RETRIES} error=${lastError.message}`);
        }

        if (attempt < WEBHOOK_MAX_RETRIES) {
            await sleep(WEBHOOK_RETRY_DELAY_MS * attempt);
        }
    }

    appendWebhookFailure({
        failedAt: new Date().toISOString(),
        tag,
        url,
        payload,
        error: lastError?.message || 'unknown_webhook_error'
    });

    throw lastError || new Error('unknown_webhook_error');
}

async function connectToWhatsApp() {
    if (isShuttingDown) return;

    startWatchdog();
    clearLivenessProbe();
    destroySocket(activeSock);
    activeSock = null;
    activeConnectionState = 'connecting';

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`[BOOT] Menggunakan WA v${version.join('.')}, isLatest=${isLatest}`);

    const generation = ++activeGeneration;
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['TeknosBot-MVP', 'Chrome', '1.0.0'],
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        getMessage: async (key) => messageCache.get(key.id) || undefined
    });

    activeSock = sock;

    sock.ev.on('connection.update', (update) => {
        if (generation !== activeGeneration) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('[AUTH] QR Code muncul, silakan scan.');
            qrcode.generate(qr, { small: true });
            stopWatchdog();
        }

        if (connection === 'close') {
            activeConnectionState = 'close';
            clearLivenessProbe();
            lastDisconnectReason = String(
                (lastDisconnect?.error instanceof Boom && lastDisconnect.error.output?.statusCode) ||
                lastDisconnect?.error?.message ||
                'unknown_close'
            );

            const shouldReconnect =
                (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

            console.log(`[WA] connection=close reconnect=${shouldReconnect} reason=${lastDisconnectReason}`);

            if (shouldReconnect) {
                scheduleReconnect(lastDisconnectReason);
            } else {
                forceExit('[AUTH] Sesi logout. Hapus folder auth_info_baileys lalu scan ulang.');
            }

            return;
        }

        if (connection === 'open') {
            activeConnectionState = 'open';
            lastConnectionOpenAt = Date.now();
            lastSuccessfulProbeAt = Date.now();
            stopWatchdog();
            startLivenessProbe(sock, generation);
            console.log('[WA] connection=open bot siap menerima pesan.');
            return;
        }

        if (connection) {
            activeConnectionState = connection;
            console.log(`[WA] connection=${connection}`);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        if (generation !== activeGeneration) return;
        if (m.type !== 'notify') return;

        const msg = m.messages[0];
        if (!msg?.message || msg.key.fromMe) return;

        if (msg.key.id) {
            messageCache.set(msg.key.id, msg.message);
            if (messageCache.size > 1000) {
                messageCache.delete(messageCache.keys().next().value);
            }
        }

        const text =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            msg.message?.documentMessage?.caption ||
            '';

        if (!text) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');

        const reply = async (teks) => {
            await sock.sendMessage(from, { text: teks }, { quoted: msg });
        };

        let groupName = '';
        if (isGroup) {
            if (groupNameCache.has(from)) {
                groupName = groupNameCache.get(from);
            } else {
                try {
                    const groupMetadata = await sock.groupMetadata(from);
                    if (groupMetadata?.subject) {
                        groupName = groupMetadata.subject.toLowerCase();
                        groupNameCache.set(from, groupName);
                    }
                } catch (e) {
                    console.warn('Gagal memuat metadata grup:', e.message);
                    return;
                }
            }
        }

        if (text === '!ping') return reply('Bot aktif (Engine: Baileys).');
        if (text === '!status') {
            return reply(`Bot aktif.\nPrefix aktif: ${Object.keys(sheetsConfig).length}\nServer: ${getTimestamp()}`);
        }
        if (text === '!reset') {
            await reply('Restarting...');
            process.exit(1);
        }

        const lines = text.split('\n');

        if (isGroup && groupName.includes('apo printing')) {
            for (const line of lines) {
                const match = line.trim().match(/\b([A-Z]{2,3})\s(\d{1,5})\s+([a-zA-Z\/]+(?:\s[a-zA-Z]+)*)(?:\s(\d+))?$/i);
                if (!match) continue;

                const [_, prefix, number, namaPetugas, extraNumber] = match;
                const config = sheetsConfig[prefix.toUpperCase()];
                if (!config?.webhook) continue;

                const isCut = namaPetugas.toLowerCase().endsWith('cut');
                const namaFinal = isCut ? namaPetugas.replace(/cut$/i, '').trim() : namaPetugas;
                const kode = `${prefix.toUpperCase()} ${number}`;

                try {
                    const payload = {
                        kode,
                        sheet: config.sheet,
                        timestamp: getTimestamp(),
                        kolom: isCut ? (config.kolom_cut || 17) : (config.kolom_printing || 15),
                        namaPetugas: namaFinal,
                        kolomNama: isCut ? (config.kolom_petugas_cut || 18) : (config.kolom_petugas || 16),
                        offset: extraNumber ? Number(extraNumber) : 0
                    };
                    const result = await callDataSink('PRINTING', config, payload);
                    if (result.success) {
                        await safeReact(sock, from, msg.key, isCut ? '✂️' : '🖨️');
                    }
                } catch (err) {
                    console.error('Error Webhook Printing:', err.message);
                }
            }

            return;
        }

        if (isGroup && groupName.includes('apo finishing')) {
            for (const line of lines) {
                const match = line.trim().match(/\b([A-Z]{2,3})\s(\d{1,5})\s+([a-zA-Z\/]+)\s+(CU|CP|PAC|PT|DR)(?:\s+(\d+))?$/i);
                if (!match) continue;

                const [_, prefix, number, petugas, jenis, offset] = match;
                const config = sheetsConfig[prefix.toUpperCase()];
                if (!config?.webhook) continue;

                const mapping = {
                    CU: { tgl: config.kolom_cheker_undangan, ptg: config.kolom_petugas_cheker_undangan, emo: '🗒️' },
                    CP: { tgl: config.kolom_cheker_paket, ptg: config.kolom_petugas_cheker_paket, emo: '📝' },
                    PAC: { tgl: config.kolom_cheker_packing, ptg: config.kolom_petugas_cheker_packing, emo: '📦' },
                    PT: { tgl: config.kolom_potong, ptg: config.kolom_petugas_potong, emo: '🪓' },
                    DR: { tgl: config.kolom_driver, ptg: config.kolom_petugas_driver, emo: '🚚' }
                };

                const target = mapping[jenis.toUpperCase()];
                if (!target || !target.tgl) continue;

                try {
                    const payload = {
                        kode: `${prefix.toUpperCase()} ${number}`,
                        sheet: config.sheet,
                        timestamp: getTimestamp(),
                        kolom: target.tgl,
                        kolom_petugas: target.ptg,
                        petugas,
                        offset: offset || 0
                    };
                    const result = await callDataSink('FINISHING', config, payload);
                    if (result.success) {
                        await safeReact(sock, from, msg.key, target.emo);
                    }
                } catch (err) {
                    console.error('Error Webhook Finishing:', err.message);
                }
            }

            return;
        }

        if (isGroup && groupName.includes('apo csm')) {
            for (const line of lines) {
                const match = line.trim().match(/\b([A-Z]{2,3})\s(\d{1,5})\s+([a-zA-Z\/]+)\s+(SA)(?:\s+(\d+))?$/i);
                if (!match) continue;

                const [_, prefix, number, petugas, jenis, offset] = match;
                const config = sheetsConfig[prefix.toUpperCase()];
                if (!config?.webhook) continue;

                if (jenis.toUpperCase() === 'SA') {
                    try {
                        const payload = {
                            kode: `${prefix.toUpperCase()} ${number}`,
                            sheet: config.sheet,
                            timestamp: getTimestamp(),
                            kolom: config.kolom_cs,
                            kolom_petugas: config.kolom_petugas_cs,
                            petugas,
                            offset: offset || 0
                        };
                        const result = await callDataSink('CSM', config, payload);
                        if (result.success) {
                            await safeReact(sock, from, msg.key, '🎀');
                        }
                    } catch (err) {
                        console.error('Error Webhook CSM:', err.message);
                    }
                }
            }

            return;
        }

        for (const line of lines) {
            const clean = line.trim().replace(/[*_~`]/g, '');
            const match = clean.match(/\b([A-Z]{2,3})\s(\d{1,5})(?:\s([1-4]))?(?:\s+([a-zA-Z\/]+))?$/i);
            if (!match) continue;

            const [_, prefix, number, kodeFix, namaPetugas] = match;
                const config = sheetsConfig[prefix.toUpperCase()];
            if (!config?.webhook) continue;

            const { day, month, hour, minute } = getJakartaDateParts();

            let timestamp;
            let kolomTarget;

            if (kodeFix && FIXED_TIMES[kodeFix]) {
                timestamp = `${day}/${month}/ ${FIXED_TIMES[kodeFix]}`;
                kolomTarget = config.kolom_fix;
            } else {
                timestamp = `${day}/${month}/ ${hour}.${minute}`;
                kolomTarget = config.kolom;
            }

            try {
                const payload = {
                    kode: `${prefix.toUpperCase()} ${number}`,
                    sheet: config.sheet,
                    timestamp,
                    kolom: kolomTarget,
                    ...(namaPetugas && config.kolom_petugas_desain && {
                        namaPetugas,
                        kolomNama: config.kolom_petugas_desain
                    })
                };
                const result = await callDataSink('DESAIN', config, payload);
                if (result.success) {
                    await safeReact(sock, from, msg.key, '✅');
                }
            } catch (err) {
                console.error('Error Webhook Desain:', err.message);
            }
        }
    });
}

function getJakartaDateParts(now = new Date()) {
    const options = {
        timeZone: 'Asia/Jakarta',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    };
    const parts = new Intl.DateTimeFormat('id-ID', options).formatToParts(now);
    const map = new Map(parts.map((p) => [p.type, p.value]));
    return {
        day: map.get('day'),
        month: map.get('month'),
        hour: map.get('hour'),
        minute: map.get('minute')
    };
}

function getTimestamp() {
    const now = new Date();
    const { day, month, hour, minute } = getJakartaDateParts(now);
    return `${day}/${month}/ ${hour}.${minute}`;
}

startHealthServer();

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
    forceExit(`[FATAL] uncaughtException: ${error.stack || error.message}`);
});
process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    forceExit(`[FATAL] unhandledRejection: ${message}`);
});

connectToWhatsApp().catch((error) => {
    forceExit(`[BOOT] Gagal start socket: ${error.stack || error.message}`);
});
