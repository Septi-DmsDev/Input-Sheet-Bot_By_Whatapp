const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs');

const sheetsConfig = JSON.parse(fs.readFileSync('./sheets-config.json'));
const FIXED_TIMES = { "1": "10.00", "2": "14.00", "3": "16.00", "4": "19.00" };
const groupNameCache = new Map();

// ==========================================
// 1. CUSTOM CACHE MANDIRI (Bypass error Baileys Store)
// ==========================================
const messageCache = new Map();

// ==========================================
// 2. SISTEM WATCHDOG (KILL-SWITCH OTOMATIS)
// ==========================================
let watchdogTimer = null;

function startWatchdog() {
    clearTimeout(watchdogTimer);
    // Jika dalam 3 menit (180.000 ms) bot tidak berstatus 'open', matikan paksa!
    watchdogTimer = setTimeout(() => {
        console.error('🚨 [WATCHDOG FATAL] Bot gagal konek/hang terlalu lama. Memaksa restart proses...');
        process.exit(1); 
    }, 180000); 
}

function stopWatchdog() {
    clearTimeout(watchdogTimer);
    console.log('🛡️ [WATCHDOG AMAN] Timer kill-switch dihentikan.');
}

async function safeReact(sock, jid, key, emoji) {
    try {
        await new Promise(resolve => setTimeout(resolve, 1500));
        await sock.sendMessage(jid, { react: { text: emoji, key: key } });
    } catch (e) {
        console.error(`⚠️ Gagal react ${emoji}:`, e.message);
    }
}

async function connectToWhatsApp() {
    // Mulai hitung mundur Watchdog saat booting
    startWatchdog();

    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`🔄 Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version, 
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), 
        browser: ['TeknosBot-MVP', 'Chrome', '1.0.0'],
        
        // ==========================================
        // 3. PARAMETER ANTI ZOMBIE CONNECTION
        // ==========================================
        keepAliveIntervalMs: 10000, // Ping server Meta setiap 10 detik
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        
        getMessage: async (key) => {
            return messageCache.get(key.id) || undefined;
        }
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('📲 QR Code muncul, silakan scan!');
            qrcode.generate(qr, { small: true });
            // Hentikan watchdog agar VPS tidak restart sendiri saat menunggu discan
            stopWatchdog();
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️ Koneksi terputus. Reconnect:', shouldReconnect);
            if (shouldReconnect) {
                // Nyalakan watchdog lagi saat mencoba reconnect
                startWatchdog();
                connectToWhatsApp();
            } else {
                console.log('❌ Sesi logout. Hapus folder "auth_info_baileys" dan scan ulang.');
                process.exit(1);
            }
        } else if (connection === 'open') {
            // Matikan watchdog karena koneksi sudah sukses
            stopWatchdog();
            console.log('✅ Authenticated! Bot siap menerima pesan (Baileys Engine).');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // ========== HANDLE PESAN ==========
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return; 

        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        // SIMPAN PESAN KE CACHE
        if (msg.key.id) {
            messageCache.set(msg.key.id, msg.message);
            if (messageCache.size > 1000) {
                messageCache.delete(messageCache.keys().next().value);
            }
        }

        const text = msg.message?.conversation || 
                     msg.message?.extendedTextMessage?.text || 
                     msg.message?.imageMessage?.caption || 
                     msg.message?.videoMessage?.caption || 
                     msg.message?.documentMessage?.caption || 
                     "";
                     
        if (!text) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');

        const reply = async (teks) => {
            await sock.sendMessage(from, { text: teks }, { quoted: msg });
        };

        let groupName = "";
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
                    console.warn(`⚠️ Gagal memuat metadata grup:`, e.message);
                    return; 
                }
            }
        }

        if (text === '!ping') return reply('✅ Bot aktif (Engine: Baileys).');
        if (text === '!status') return reply(`✅ Bot aktif.\n📦 Prefix aktif: ${Object.keys(sheetsConfig).length}\n🕒 Server: ${getTimestamp()}`);
        if (text === '!reset') { 
            await reply('🔄 Restarting...'); 
            process.exit(1); 
        }

        const lines = text.split('\n');

        // ====== FUNGSI KHUSUS TIM PRINTING ======
        if (isGroup && groupName.includes('apo printing')) {
            for (const line of lines) {
                const match = line.trim().match(/\b([A-Z]{2,3})\s(\d{1,5})\s+([a-zA-Z\/]+(?:\s[a-zA-Z]+)*)(?:\s(\d+))?$/i);
                if (!match) continue;

                const [_, prefix, number, namaPetugas, extraNumber] = match;
                const config = sheetsConfig[prefix.toUpperCase()];
                if (!config?.webhook) continue;

                const isCut = namaPetugas.toLowerCase().endsWith("cut");
                const namaFinal = isCut ? namaPetugas.replace(/cut$/i, '').trim() : namaPetugas;
                const kode = `${prefix.toUpperCase()} ${number}`;

                try {
                    const res = await fetch(config.webhook, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            kode, sheet: config.sheet, timestamp: getTimestamp(),
                            kolom: isCut ? (config.kolom_cut || 17) : (config.kolom_printing || 15),
                            namaPetugas: namaFinal, kolomNama: isCut ? (config.kolom_petugas_cut || 18) : (config.kolom_petugas || 16),
                            offset: extraNumber ? Number(extraNumber) : 0
                        })
                    });
                    const result = await res.json();
                    if (result?.success || String(result?.success).toLowerCase() === 'true') {
                        await safeReact(sock, from, msg.key, isCut ? '✂️' : '🖨️');
                    }
                } catch (err) { console.error('Error Webhook Printing:', err.message); }
            }
            return;
        }

        // ====== FUNGSI TIM FINISHING ======
        if (isGroup && groupName.includes('apo finishing')) {
            for (const line of lines) {
                const match = line.trim().match(/\b([A-Z]{2,3})\s(\d{1,5})\s+([a-zA-Z\/]+)\s+(CU|CP|PAC|PT|DR)(?:\s+(\d+))?$/i);
                if (!match) continue;

                const [_, prefix, number, petugas, jenis, offset] = match;
                const config = sheetsConfig[prefix.toUpperCase()];
                if (!config?.webhook) continue;

                const mapping = {
                    'CU': { tgl: config.kolom_cheker_undangan, ptg: config.kolom_petugas_cheker_undangan, emo: '🗒️' },
                    'CP': { tgl: config.kolom_cheker_paket, ptg: config.kolom_petugas_cheker_paket, emo: '📝' },
                    'PAC': { tgl: config.kolom_cheker_packing, ptg: config.kolom_petugas_cheker_packing, emo: '📦' },
                    'PT': { tgl: config.kolom_potong, ptg: config.kolom_petugas_potong, emo: '🪓' },
                    'DR': { tgl: config.kolom_driver, ptg: config.kolom_petugas_driver, emo: '🚚' }
                };

                const target = mapping[jenis.toUpperCase()];
                if (!target || !target.tgl) continue;

                try {
                    const res = await fetch(config.webhook, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            kode: `${prefix.toUpperCase()} ${number}`, sheet: config.sheet, timestamp: getTimestamp(),
                            kolom: target.tgl, kolom_petugas: target.ptg, petugas, offset: offset || 0
                        })
                    });
                    const result = await res.json();
                    if (result?.success || String(result?.success).toLowerCase() === 'true') {
                        await safeReact(sock, from, msg.key, target.emo);
                    }
                } catch (err) { console.error('Error Webhook Finishing:', err.message); }
            }
            return;
        }

        // ====== FUNGSI TIM CSM ======
        if (isGroup && groupName.includes('apo csm')) {
            for (const line of lines) {
                const match = line.trim().match(/\b([A-Z]{2,3})\s(\d{1,5})\s+([a-zA-Z\/]+)\s+(SA)(?:\s+(\d+))?$/i);
                if (!match) continue;

                const [_, prefix, number, petugas, jenis, offset] = match;
                const config = sheetsConfig[prefix.toUpperCase()];
                if (!config?.webhook) continue;

                if (jenis.toUpperCase() === 'SA') {
                    try {
                        const res = await fetch(config.webhook, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                kode: `${prefix.toUpperCase()} ${number}`, sheet: config.sheet, timestamp: getTimestamp(),
                                kolom: config.kolom_cs, kolom_petugas: config.kolom_petugas_cs, petugas, offset: offset || 0
                            })
                        });
                        const result = await res.json();
                        if (result?.success || String(result?.success).toLowerCase() === 'true') {
                            await safeReact(sock, from, msg.key, '🎀');
                        }
                    } catch (err) { console.error('Error Webhook CSM:', err.message); }
                }
            }
            return;
        }

        // ====== FUNGSI TIM DESAIN ======
        for (const line of lines) {
            const clean = line.trim().replace(/[*_~`]/g, '');
            const match = clean.match(/\b([A-Z]{2,3})\s(\d{1,5})(?:\s([1-4]))?(?:\s+([a-zA-Z\/]+))?$/i);
            if (!match) continue;

            const [_, prefix, number, kodeFix, namaPetugas] = match;
            const config = sheetsConfig[prefix.toUpperCase()];
            if (!config?.webhook) continue;

            const now = new Date();
            const day = String(now.getDate()).padStart(2, '0');
            const month = String(now.getMonth() + 1).padStart(2, '0');

            let timestamp, kolomTarget;
            if (kodeFix && FIXED_TIMES[kodeFix]) {
                timestamp = `${day}/${month}/ ${FIXED_TIMES[kodeFix]}`;
                kolomTarget = config.kolom_fix;
            } else {
                const hours = String(now.getHours()).padStart(2, '0');
                const minutes = String(now.getMinutes()).padStart(2, '0');
                timestamp = `${day}/${month}/ ${hours}.${minutes}`;
                kolomTarget = config.kolom;
            }

            try {
                const res = await fetch(config.webhook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        kode: `${prefix.toUpperCase()} ${number}`, sheet: config.sheet, timestamp, kolom: kolomTarget,
                        ...(namaPetugas && config.kolom_petugas_desain && { namaPetugas, kolomNama: config.kolom_petugas_desain })
                    })
                });
                const resultText = await res.text();
                let result = { success: false };
                try { result = JSON.parse(resultText); } catch { result.success = resultText.trim().toLowerCase() === 'ok'; }

                if (result.success) {
                    await safeReact(sock, from, msg.key, '✅');
                }
            } catch (err) { console.error('Error Webhook Desain:', err.message); }
        }
    });
}

function getTimestamp() {
    const now = new Date();
    const options = { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
    const parts = new Intl.DateTimeFormat('id-ID', options).formatToParts(now);
    const map = new Map(parts.map(p => [p.type, p.value]));
    return `${map.get('day')}/${map.get('month')}/ ${map.get('hour')}.${map.get('minute')}`;
}

connectToWhatsApp();
