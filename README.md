# Zavier Ops Bot (WhatsApp to Google Sheets Bridge)

Bot WhatsApp operasional berbasis Node.js yang dirancang khusus untuk mengotomatisasi *data entry* dari grup WhatsApp ke Google Sheets. Dibangun menggunakan arsitektur **WebSocket (@whiskeysockets/baileys)** untuk skalabilitas tinggi, penggunaan RAM yang sangat rendah (~50MB), dan ketahanan terhadap *update* antarmuka Meta (WhatsApp Web).

## 🚀 Fitur Utama

- **Lightweight Engine:** Menggunakan Baileys (tanpa browser/Puppeteer) sehingga aman dijalankan pada VPS spesifikasi rendah tanpa risiko *CPU Spikes* atau *Memory Leaks*.
- **Native Reaction:** Menggunakan protokol *Signal* WhatsApp untuk memberikan *feedback* emoji (✅, 🖨️, 📦, 🎀) secara instan dan kebal dari blokir antarmuka WA Web.
- **Smart Group Routing:** Memiliki logika *routing* terisolasi untuk 4 divisi operasional (Printing, Finishing, CSM, Desain) berdasarkan deteksi nama grup secara dinamis.
- **Custom In-Memory Cache:** Sistem penyimpanan pesan mandiri (*bypassing* Baileys Store) untuk mencegah *spam/looping* saat terjadi sinkronisasi riwayat pesan (History Sync), dibatasi maksimal 1000 pesan untuk efisiensi RAM.

## 🛠️ Tech Stack

- **Runtime:** Node.js (v18+)
- **WhatsApp API:** `@whiskeysockets/baileys`
- **HTTP Client:** `node-fetch`
- **Process Manager:** `pm2`

## ⚙️ Persiapan & Instalasi

1. **Clone repositori:**
   ```bash
   git clone [https://github.com/username/zavier-ops-bot.git](https://github.com/username/zavier-ops-bot.git)
   cd zavier-ops-bot
Install dependensi:

Bash
npm install
Konfigurasi Webhook:
Buat file sheets-config.json di root directory. File ini berisi pemetaan kode prefix pekerjaan ke URL Webhook Google Apps Script masing-masing.

Contoh sheets-config.json:

JSON
{
    "INV": {
        "sheet": "Data_Undangan",
        "webhook": "[https://script.google.com/macros/s/AKfycby.../exec](https://script.google.com/macros/s/AKfycby.../exec)",
        "kolom": 10,
        "kolom_fix": 12,
        "kolom_printing": 15,
        "kolom_petugas": 16
    }
}
💻 Panduan Penggunaan (Deployment)
Jalankan bot secara manual untuk pertama kali guna memunculkan QR Code otentikasi.

Bash
node index.js
Pindai QR Code yang muncul di terminal menggunakan WhatsApp (Perangkat Tertaut).

Tunggu hingga muncul log ✅ Authenticated!.

Hentikan proses manual (Ctrl + C).

Jalankan bot sebagai background process menggunakan PM2:

Bash
pm2 start index.js --name "zavier-ops-bot"
pm2 save
📝 Format Pesan Operasional
Bot mendengarkan format spesifik di dalam grup WhatsApp operasional.

1. Divisi Printing (Grup: apo printing)
Format: [PREFIX] [NO_JOB] [NAMA_PETUGAS] [OPSIONAL_OFFSET]

Contoh: INV 12345 Dimas (Memproses cetak normal)

Contoh Cut: INV 12345 Daniar Cut (Memproses cetak potong, memicu kolom berbeda)

Feedback: 🖨️ (Normal) / ✂️ (Cut)

2. Divisi Finishing (Grup: apo finishing)
Format: [PREFIX] [NO_JOB] [NAMA_PETUGAS] [KODE_CHECKER]

Kode Checker: CU (Undangan), CP (Paket), PAC (Packing), PT (Potong), DR (Driver)

Contoh: INV 12345 Bayu PAC

Feedback: Sesuai checker (contoh: 📦 untuk PAC)

3. Divisi CSM (Grup: apo csm)
Format: [PREFIX] [NO_JOB] [NAMA_PETUGAS] SA

Contoh: INV 12345 Mega SA

Feedback: 🎀

4. Divisi Desain (Default Fallback)
Format: [PREFIX] [NO_JOB] [KODE_WAKTU(1-4)] [NAMA_PETUGAS]

Contoh: INV 12345 1 Dimas (Angka 1 mewakili target waktu 10.00)

Feedback: ✅

🚨 Troubleshooting
Jika bot mengalami infinite loop connection (menolak koneksi secara berulang), hal ini disebabkan oleh sesi kredensial WA yang sudah hangus di server Meta. Lakukan Hard Reset:

pm2 stop zavier-ops-bot
rm -rf auth_info_baileys
node index.js # Scan QR ulang