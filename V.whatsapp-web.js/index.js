const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const fs = require('fs');

const sheetsConfig = JSON.parse(fs.readFileSync('./sheets-config.json'));

// Waktu fix (Desain)
const FIXED_TIMES = {
    "1": "10.00",
    "2": "14.00",
    "3": "16.00",
    "4": "19.00"
};

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    authTimeoutMs: 60000, 
    qrMaxRetries: 5,
    // PENTING: Mengunci versi WA Web agar bot tidak mudah rusak karena update sepihak dari WA
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-js/main/dist/wppconnect-wa.js',
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Menggunakan /tmp daripada shared memory
            '--disable-gpu',           // Menghemat resource
            '--no-first-run',
            '--no-zygote',
            '--single-process',       // Jika RAM < 2GB
        ],
    }
});

// GLOBAL CACHE: Ingatan bot untuk menyimpan Nama Grup
const groupNameCache = new Map();

// ==========================================
// FUNGSI FEEDBACK AMAN (REPLY ONLY + KODE JOB)
// ==========================================
async function safeReact(msg, emoji, kode) {
    try {
        // Fitur React WA sedang diblokir, kita gunakan Reply dengan menyertakan Kode Job
        await msg.reply(`*Gacorr kang:* ${kode} ${emoji}`);
    } catch (err) {
        console.error(`⚠️ Gagal mengirim reply konfirmasi:`, err.message);
    }
}

// ========== EVENT CLIENT ==========
client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('📲 QR Code muncul, silakan scan!');
});

client.on('ready', () => {
    console.log('🤖 Bot siap menerima pesan.');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Auth failure:', msg);
});

client.on('disconnected', (reason) => {
    console.warn('⚠️ Bot terputus:', reason);
    process.exit(1); // Biarkan PM2 merestart agar memori bersih
});

client.on('loading_screen', (percent, message) => {
    console.log(`🔄 LOADING PROGRESS: ${percent}% - ${message}`);
});

client.on('authenticated', () => {
    console.log('✅ Authenticated! Menunggu sinkronisasi chat...');
});

// ========== HANDLE PESAN ==========
client.on('message', async (msg) => {
    const text = msg.body.trim();
    const from = msg.from;
    const isGroup = from.endsWith('@g.us');

    // ==========================================
    // SAFETY CHECK: DAPATKAN NAMA GRUP
    // ==========================================
    let groupName = "";
    if (isGroup) {
        if (groupNameCache.has(from)) {
            groupName = groupNameCache.get(from);
        } else {
            try {
                const chat = await msg.getChat();
                if (chat?.name) {
                    groupName = chat.name.toLowerCase();
                    groupNameCache.set(from, groupName);
                }
            } catch (e) {
                console.warn(`⚠️ Gagal memuat metadata chat/grup, skip demi keamanan.`);
                return; // Setop di sini agar tidak error undefined
            }
        }
    }

    // ========== COMMAND DASAR ==========
    if (text === '!ping') return msg.reply('✅ Bot aktif dan berjalan.');
    if (text === '!help') return msg.reply(`📌 *Perintah Tersedia:*
- !ping → Cek status bot
- !status → Status aktif + jumlah prefix
- !list → Daftar kode prefix aktif
- !refreshgroup → Hapus ingatan nama grup bot
- !reset → Reset koneksi bot`);
    
    if (text === '!status') return msg.reply(`✅ Bot aktif.\n📦 Jumlah prefix aktif: ${Object.keys(sheetsConfig).length}\n🕒 Waktu server: ${getTimestamp()}`);
    if (text === '!list') return msg.reply(`📄 Daftar Prefix Aktif:\n${Object.keys(sheetsConfig).map(p => `- ${p} → ${sheetsConfig[p].sheet}`).join('\n')}`);
    
    if (text === '!refreshgroup' && isGroup) {
        groupNameCache.delete(from);
        return msg.reply('🔄 Ingatan nama grup berhasil dihapus. Kirim pesan lagi untuk mensinkronisasi ulang.');
    }

    if (text === '!reset') { 
        await msg.reply('🔄 Bot akan direstart (soft)...'); 
        process.exit(1); 
    }

    const lines = text.split('\n');

    // ====== FUNGSI KHUSUS TIM PRINTING ======
    if (isGroup && groupName.includes('apo printing')) {
        for (const line of lines) {
            const match = line.trim().match(/\b([A-Z]{2,3})\s(\d{1,5})\s+([a-zA-Z\/]+(?:\s[a-zA-Z]+)*)(?:\s(\d+))?$/i);
            const isDesainCode = line.trim().match(/\b[A-Z]{2,3}\s\d{1,5}\s[1-4]\b/);
            
            if (!match || isDesainCode) continue;

            const prefix = match[1].toUpperCase();
            const number = match[2];
            const namaPetugas = match[3].trim();
            const extraNumber = match[4];

            const isExtraRow = !!extraNumber;
            const kode = `${prefix} ${number}`;

            const isCut = namaPetugas.toLowerCase().endsWith("cut");
            const namaFinal = isCut ? namaPetugas.replace(/cut$/i, '').trim() : namaPetugas;

            const config = sheetsConfig[prefix];
            if (!config || !config.webhook) continue;

            const kolomPrinting = isCut ? (config.kolom_cut || 17) : (config.kolom_printing || 15);
            const kolomNama = isCut ? (config.kolom_petugas_cut || 18) : (config.kolom_petugas || 16);

            try {
                const res = await fetch(config.webhook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        kode,
                        sheet: config.sheet,
                        timestamp: getTimestamp(),
                        kolom: kolomPrinting,
                        namaPetugas: namaFinal,
                        kolomNama,
                        offset: isExtraRow ? Number(extraNumber) : 0
                    })
                });

                const result = await res.json();
                if (result && String(result.success).toLowerCase() === 'true') {
                    // Update: Kirim parameter kode ke safeReact
                    await safeReact(msg, isCut ? '✂️' : '🖨️', kode);
                } else {
                    client.sendMessage(from, `❌ JOB ID *${kode}* tidak ditemukan.`);
                }
            } catch (err) {
                console.error('❌ Error saat fetch webhook:', err.message);
            }
        }
        return;
    }

    // ====== FUNGSI TIM CHECKER (CU, CP, PAC, PT, DR) ======
    if (isGroup && groupName.includes('apo finishing')) {
        for (const line of lines) {
            const match = line.trim().match(/\b([A-Z]{2,3})\s(\d{1,5})\s+([a-zA-Z\/]+)\s+(CU|CP|PAC|PT|DR)(?:\s+(\d+))?$/i);
            if (!match) continue;

            const prefix = match[1].toUpperCase();
            const number = match[2];
            const namaPetugas = match[3].trim();
            const jenisChecker = match[4].toUpperCase();
            const offset = match[5] ? parseInt(match[5], 10) : 0;

            const kode = `${prefix} ${number}`;
            const config = sheetsConfig[prefix];
            if (!config || !config.webhook) continue;

            let kolomTanggal, kolomPetugas, emoji;
            if (jenisChecker === 'CU') {
                kolomTanggal = config.kolom_cheker_undangan;
                kolomPetugas = config.kolom_petugas_cheker_undangan;
                emoji = '🗒️';
            } else if (jenisChecker === 'CP') {
                kolomTanggal = config.kolom_cheker_paket;
                kolomPetugas = config.kolom_petugas_cheker_paket;
                emoji = '📝';
            } else if (jenisChecker === 'PAC') {
                kolomTanggal = config.kolom_cheker_packing;
                kolomPetugas = config.kolom_petugas_cheker_packing;
                emoji = '📦';
            } else if (jenisChecker === 'PT') {
                kolomTanggal = config.kolom_potong;
                kolomPetugas = config.kolom_petugas_potong;
                emoji = '🪓';
            } else if (jenisChecker === 'DR') {
                kolomTanggal = config.kolom_driver;
                kolomPetugas = config.kolom_petugas_driver;
                emoji = '🚚';
            }

            if (!kolomTanggal || !kolomPetugas) continue;

            try {
                const res = await fetch(config.webhook, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        kode,
                        sheet: config.sheet,
                        timestamp: getTimestamp(),
                        kolom: kolomTanggal,
                        kolom_petugas: kolomPetugas,
                        petugas: namaPetugas,
                        offset
                    })
                });

                const result = await res.json();
                if (result && String(result.success).toLowerCase() === 'true') {
                    // Update: Kirim parameter kode ke safeReact
                    await safeReact(msg, emoji, kode);
                } else {
                    client.sendMessage(from, `⚠️ JOB ID "${kode}" tidak ditemukan.`);
                }
            } catch (err) {
                console.error(`❌ Gagal kirim data checker ${jenisChecker}:`, err.message);
            }
        }
        return;
    }

    // ====== FUNGSI TIM CS ======
    if (isGroup && groupName.includes('apo csm')) {
        for (const line of lines) {
            const match = line.trim().match(/\b([A-Z]{2,3})\s(\d{1,5})\s+([a-zA-Z\/]+)\s+(SA)(?:\s+(\d+))?$/i);
            if (!match) continue;

            const prefix = match[1].toUpperCase();
            const number = match[2];
            const namaPetugas = match[3].trim();
            const jeniscs = match[4].toUpperCase();
            const offset = match[5] ? parseInt(match[5], 10) : 0;

            const kode = `${prefix} ${number}`;
            const config = sheetsConfig[prefix];
            if (!config || !config.webhook) continue;

            if (jeniscs === 'SA') {
                try {
                    const res = await fetch(config.webhook, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            kode,
                            sheet: config.sheet,
                            timestamp: getTimestamp(),
                            kolom: config.kolom_cs,
                            kolom_petugas: config.kolom_petugas_cs,
                            petugas: namaPetugas,
                            offset
                        })
                    });

                    const result = await res.json();
                    if (result && String(result.success).toLowerCase() === 'true') {
                        // Update: Kirim parameter kode ke safeReact
                        await safeReact(msg, '🎀', kode);
                    } else {
                        client.sendMessage(from, `⚠️ JOB ID "${kode}" tidak ditemukan.`);
                    }
                } catch (err) {
                    console.error(`❌ Gagal kirim data CS ${jeniscs}:`, err.message);
                }
            }
        }
        return;
    }

    // ====== FUNGSI KHUSUS TIM DESAIN ======
    for (const line of lines) {
        const clean = line.trim().replace(/[*_~`]/g, '');
        const match = clean.match(/\b([A-Z]{2,3})\s(\d{1,5})(?:\s([1-4]))?(?:\s+([a-zA-Z\/]+))?$/i);
        if (!match) continue;

        const prefix = match[1].toUpperCase();
        const number = match[2];
        const kodeFix = match[3];
        const namaPetugas = match[4]?.trim();

        const config = sheetsConfig[prefix];
        if (!config || !config.sheet || !config.webhook) continue;

        const kode = `${prefix} ${number}`;
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
                    kode,
                    sheet: config.sheet,
                    timestamp,
                    kolom: kolomTarget,
                    ...(namaPetugas && config.kolom_petugas_desain && { namaPetugas, kolomNama: config.kolom_petugas_desain })
                })
            });

            const resultText = await res.text();
            let result = { success: false };
            try { result = JSON.parse(resultText); } catch { result.success = resultText.trim().toLowerCase() === 'ok'; }

            if (result.success) {
                // Update: Kirim parameter kode ke safeReact
                await safeReact(msg, '✅', kode);
            } else {
                client.sendMessage(from, `⚠️ JOB ID "${kode}" tidak ditemukan.`);
            }
        } catch (err) {
            console.error('❌ Gagal kirim ke webhook Desain:', err.message);
        }
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