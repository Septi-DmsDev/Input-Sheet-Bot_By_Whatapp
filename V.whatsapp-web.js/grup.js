const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs');

// Load Config
const sheetsConfig = JSON.parse(fs.readFileSync('./sheets-config.json'));

// Waktu fix (Desain)
const FIXED_TIMES = {
    "1": "10.00",
    "2": "14.00",
    "3": "16.00",
    "4": "19.00"
};

const client = new Client({
    authStrategy: new LocalAuth({ 
        dataPath: './.wwebjs_auth',
        //clientId: 'bot-utama' // Opsional: jika mau multi-device nanti
    }),
    // PENTING: Mencegah timeout saat sinkronisasi berat
    authTimeoutMs: 60000, 
    qrMaxRetries: 5,
    
    // PENTING: Mengunci versi WA Web agar tidak auto-refresh
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-js/main/dist/wppconnect-wa.js',
    },
    
    puppeteer: {
        // executablePath: '/usr/bin/google-chrome-stable',
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Wajib untuk server/VPS
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ],
    }
});

// ========== EVENT CLIENT ==========
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('📲 QR Code muncul, silakan scan!');
});

client.on('ready', () => {
    console.log('🤖 Bot siap menerima pesan.');
});

client.on('authenticated', () => {
    console.log('✅ Authenticated! Menunggu sinkronisasi chat...');
});

client.on('loading_screen', (percent, message) => {
    console.log(`🔄 LOADING: ${percent}% - ${message}`);
});

client.on('auth_failure', (msg) => {
    console.error('❌ Auth failure:', msg);
});

client.on('disconnected', (reason) => {
    console.warn('⚠️ Bot terputus:', reason);
    process.exit(1); // Biarkan PM2 merestart secara bersih
});

// Helper function untuk react aman
async function safeReact(msg, emoji) {
    try {
        await msg.react(emoji);
    } catch (e) {
        console.error(`⚠️ Gagal react ${emoji}:`, e.message);
    }
}

// ========== HANDLE PESAN ==========
client.on('message', async (msg) => {
    const text = msg.body.trim();
    const from = msg.from;
    const isGroup = from.endsWith('@g.us');

    // Ambil data chat dengan penanganan error (agar grup terdeteksi)
    let chat;
    try {
        chat = await msg.getChat();
    } catch (e) {
        console.warn('⚠️ Gagal memuat metadata chat/grup:', e.message);
    }

    const groupName = chat?.name?.toLowerCase() || "";

    // ========== COMMAND DASAR (Bisa di Personal & Grup) ==========
    if (text === '!ping') return msg.reply('✅ Bot aktif.');
    if (text === '!status') return msg.reply(`✅ Bot aktif.\n📦 Prefix aktif: ${Object.keys(sheetsConfig).length}\n🕒 Server: ${getTimestamp()}`);
    
    if (text === '!reset') { 
        await msg.reply('🔄 Restarting...'); 
        process.exit(1); 
    }

    // Parse baris pesan
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
                        kode,
                        sheet: config.sheet,
                        timestamp: getTimestamp(),
                        kolom: isCut ? (config.kolom_cut || 17) : (config.kolom_printing || 15),
                        namaPetugas: namaFinal,
                        kolomNama: isCut ? (config.kolom_petugas_cut || 18) : (config.kolom_petugas || 16),
                        offset: extraNumber ? Number(extraNumber) : 0
                    })
                });
                const result = await res.json();
                if (result?.success || String(result?.success).toLowerCase() === 'true') {
                    await safeReact(msg, isCut ? '✂️' : '🖨️');
                }
            } catch (err) { console.error('Error Webhook Printing:', err.message); }
        }
        return;
    }

    // ====== FUNGSI TIM FINISHING (CU, CP, PAC, PT, DR) ======
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
                        kode: `${prefix.toUpperCase()} ${number}`,
                        sheet: config.sheet,
                        timestamp: getTimestamp(),
                        kolom: target.tgl,
                        kolom_petugas: target.ptg,
                        petugas,
                        offset: offset || 0
                    })
                });
                const result = await res.json();
                if (result?.success || String(result?.success).toLowerCase() === 'true') {
                    await safeReact(msg, target.emo);
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
                            kode: `${prefix.toUpperCase()} ${number}`,
                            sheet: config.sheet,
                            timestamp: getTimestamp(),
                            kolom: config.kolom_cs,
                            kolom_petugas: config.kolom_petugas_cs,
                            petugas,
                            offset: offset || 0
                        })
                    });
                    const result = await res.json();
                    if (result?.success || String(result?.success).toLowerCase() === 'true') {
                        await safeReact(msg, '🎀');
                    }
                } catch (err) { console.error('Error Webhook CSM:', err.message); }
            }
        }
        return;
    }

    // ====== FUNGSI TIM DESAIN (Default Fallback) ======
    for (const line of lines) {
        const clean = line.trim().replace(/[*_~`]/g, '');
        const match = clean.match(/\b([A-Z]{2,3})\s(\d{1,5})(?:\s([1-4]))?(?:\s+([a-zA-Z\/]+))?$/i);
        if (!match) continue;

        const [_, prefix, number, kodeFix, namaPetugas] = match;
        const config = sheetsConfig[prefix.toUpperCase()];
        if (!config?.webhook) continue;

        const now = new Date();
        const timeStr = kodeFix ? FIXED_TIMES[kodeFix] : `${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`;
        const timestamp = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/ ${timeStr}`;

        try {
            const res = await fetch(config.webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    kode: `${prefix.toUpperCase()} ${number}`,
                    sheet: config.sheet,
                    timestamp,
                    kolom: kodeFix ? config.kolom_fix : config.kolom,
                    ...(namaPetugas && config.kolom_petugas_desain && { namaPetugas, kolomNama: config.kolom_petugas_desain })
                })
            });
            const resultText = await res.text();
            let result = { success: false };
            try { result = JSON.parse(resultText); } catch { result.success = resultText.trim().toLowerCase() === 'ok'; }

            if (result.success) {
                await safeReact(msg, '✅');
            }
        } catch (err) { console.error('Error Webhook Desain:', err.message); }
    }
});

function getTimestamp() {
    const now = new Date();
    const options = { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
    const parts = new Intl.DateTimeFormat('id-ID', options).formatToParts(now);
    const map = new Map(parts.map(p => [p.type, p.value]));
    return `${map.get('day')}/${map.get('month')}/ ${map.get('hour')}.${map.get('minute')}`;
}

client.initialize();