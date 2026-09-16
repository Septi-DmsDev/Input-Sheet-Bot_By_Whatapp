// =========================================================================
// 1. MENU KHUSUS (TOMBOL EKSEKUSI & WIPER SYSTEM)
// =========================================================================
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('⚡ TEKNOS MENU')
    .addItem('🚀 Proses Semua Scanner', 'processBatchScanner')
    .addSeparator() // Garis pemisah visual
    .addItem('🧹 1. Bersihkan Data Shopee (WAJIB)', 'clearDataShopee')
    .addToUi();
}

function clearDataShopee() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.alert('Konfirmasi', 'Yakin ingin MENGHAPUS SEMUA ISI tab Data_Shopee sebelum paste data baru?', ui.ButtonSet.YES_NO);
  
  if (response == ui.Button.YES) {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Data_Shopee");
    if (!sheet) {
      ui.alert("⚠️ Sheet 'Data_Shopee' tidak ditemukan!");
      return;
    }
    
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    
    // Hanya hapus jika ada data di bawah header (Baris 2 ke bawah)
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    }
    
    ui.alert("✅ Data Shopee berhasil dibersihkan! Silakan Paste data yang baru di sel A2.");
  }
}

// =========================================================================
// 2. MAIN DISPATCHER (Hanya untuk Auto-Timestamp)
// =========================================================================
function onEdit(e) {
  if (!e || !e.range) return;
  handleAutoTimestamp(e); 
}

// =========================================================================
// 3. MODULE NODE 1: BATCH SCANNER (NATURAL SUM + ANTI DUPLIKAT SCAN)
// =========================================================================

// =========================================================================
// [DIAGNOSTIK] Jalankan fungsi ini dulu untuk lihat apa yang dibaca script
// =========================================================================
function debugBatchScanner() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var lastRow = sheet.getLastRow();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dataSheet = ss.getSheetByName("Data_Shopee");

  Logger.log("=== DEBUG MODE ===");
  Logger.log("Sheet Aktif: " + sheet.getName());
  Logger.log("Last Row: " + lastRow);

  // Cek 10 baris terakhir yang punya isi di kolom F
  var currentSheetData = sheet.getRange(1, 1, lastRow, 7).getValues();
  var found = 0;
  for (var i = lastRow - 1; i >= 1 && found < 10; i--) {
    var colA = currentSheetData[i][0] ? currentSheetData[i][0].toString() : "(kosong)";
    var colB = currentSheetData[i][1] ? currentSheetData[i][1].toString() : "(kosong)";
    var colF = currentSheetData[i][5] ? currentSheetData[i][5].toString() : "(kosong)";
    var colFType = typeof currentSheetData[i][5];
    var colFRaw = JSON.stringify(currentSheetData[i][5]);

    // Cetak semua baris yang A-nya berisi Job ID
    if (colA !== "(kosong)") {
      Logger.log("Baris " + (i+1) + " → A=" + colA + " | B=" + colB + " | F=" + colF + " | F-type=" + colFType + " | F-raw=" + colFRaw);
      found++;
    }
  }

  // Cek header Data_Shopee
  if (dataSheet) {
    var headers = dataSheet.getRange(1, 1, 1, dataSheet.getLastColumn()).getValues()[0];
    Logger.log("=== HEADER Data_Shopee ===");
    headers.forEach(function(h, idx) {
      if (h) Logger.log("Kolom " + (idx+1) + ": " + h);
    });
    Logger.log("Total baris Data_Shopee: " + dataSheet.getLastRow());
  } else {
    Logger.log("⚠️ Data_Shopee TIDAK DITEMUKAN!");
  }
}

function processBatchScanner() {
  var sheet = SpreadsheetApp.getActiveSheet();
  
  if (sheet.getName() === "Data_Shopee") {
    SpreadsheetApp.getUi().alert("⚠️ Pindah ke sheet antrean (SN/SG/dll) sebelum memproses!");
    return;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var dataSheet = ss.getSheetByName("Data_Shopee");
  if (!dataSheet) return SpreadsheetApp.getUi().alert("⚠️ Sheet 'Data_Shopee' tidak ditemukan!");

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var banWords = [];
  var banSheet = ss.getSheetByName("Ban_List");
  if (banSheet) {
    var banData = banSheet.getDataRange().getValues();
    for (var b = 1; b < banData.length; b++) {
      if (banData[b][0]) banWords.push(banData[b][0].toString().toLowerCase().trim());
    }
  }

  var dataRange = dataSheet.getDataRange().getValues();
  var headers = dataRange[0];
  
  var colNopes     = headers.indexOf("No. Pesanan");
  var colEkspedisi = headers.indexOf("Opsi Pengiriman");
  var colProduk    = headers.indexOf("Nama Produk");
  var colVariasi   = headers.indexOf("Nama Variasi");
  var colQty       = headers.indexOf("Jumlah");
  var colUsername  = headers.indexOf("Username (Pembeli)");
  var colPenerima  = headers.indexOf("Nama Penerima"); 

  if (colNopes === -1) {
    return SpreadsheetApp.getUi().alert("⚠️ Header 'No. Pesanan' tidak ditemukan di Data_Shopee.");
  }

  // --- HASH MAP NATURAL (BIARKAN MULTIPLE ROWS SHOPEE TETAP MASUK UTUH) ---
  var shopeeIndex = {};
  for (var r = 1; r < dataRange.length; r++) {
    var rowNopes = dataRange[r][colNopes] ? dataRange[r][colNopes].toString().replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : "";
    if (rowNopes) {
      if (!shopeeIndex[rowNopes]) shopeeIndex[rowNopes] = []; 
      shopeeIndex[rowNopes].push(dataRange[r]); 
    }
  }

  var currentSheetData = sheet.getRange(1, 1, lastRow, 7).getValues();
  var countProses = 0;

  // 🚨 REGISTRI ANTI-DUPLIKAT SCAN (UNIQUE KEY DI SISI INPUT SCANNER) 🚨
  var processedRegistry = {};
  
  // Daftarkan semua resi yang SUDAH ADA di sheet antrean biar gak kecetak ulang
  for (var r = 0; r < lastRow; r++) {
    var kb = currentSheetData[r][1] ? currentSheetData[r][1].toString().trim() : "";
    var kf = currentSheetData[r][5] ? currentSheetData[r][5].toString().trim() : "";
    if (kf !== "" && kb !== "" && kb !== "DUPLIKAT SCAN" && kb !== "TIDAK DITEMUKAN") {
      var cleanKf = kf.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
      processedRegistry[cleanKf] = true;
    }
  }

  for (var i = lastRow - 1; i >= 1; i--) {
    var rowNum = i + 1;
    var isiKolomB = currentSheetData[i][1] ? currentSheetData[i][1].toString().trim() : ""; 
    var isiKolomF = currentSheetData[i][5] ? currentSheetData[i][5].toString().trim() : ""; 

    if (isiKolomF !== "" && isiKolomB === "") {
      
      var scannedStr = isiKolomF.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

      // PENJAGA GERBANG SCAN GANDA DARI ANAK GUDANG (SILENT IGNORE)
      if (processedRegistry[scannedStr]) {
        // Hapus input resi dari scanner agar baris kembali kosong untuk antrean berikutnya
        sheet.getRange(rowNum, 6).clearContent(); 
        continue; 
      }
      // Langsung daftarin resi ini biar baris atasnya yg kembar langsung mental
      processedRegistry[scannedStr] = true;

      var matchItems = shopeeIndex[scannedStr] || []; 

      if (matchItems.length > 0) {

        var rawUsername = matchItems[0][colUsername] ? matchItems[0][colUsername].toString().trim() : "";
        var rawPenerima = colPenerima > -1 && matchItems[0][colPenerima] ? matchItems[0][colPenerima].toString().trim() : "";
        var formattedCustomer = rawPenerima;

        if (rawPenerima.indexOf('*') > -1 && rawUsername !== "") {
          formattedCustomer = rawPenerima + " (" + rawUsername + ")";
        } else if (!rawPenerima) {
          formattedCustomer = rawUsername;
        }

        var ekspedisi = matchItems[0][colEkspedisi] || "";
        var groupedProducts = {};

        // LOOPING PENJUMLAHAN QTY
        matchItems.forEach(function(row) {
          var variasi = (row[colVariasi] && row[colVariasi].toString().trim() !== "") ? row[colVariasi].toString().trim() : "Tidak Ada Variasi";
          var produkName = (row[colProduk] && row[colProduk].toString().trim() !== "") ? row[colProduk].toString().trim() : "Produk Tidak Diketahui";
          var rawQty = row[colQty] ? row[colQty].toString().replace(/[^0-9]/g, '') : "1";
          var qty = parseInt(rawQty) || 1;

          var isBanned = false;
          var textToTest = (produkName + " " + variasi).toLowerCase();
          for (var b = 0; b < banWords.length; b++) {
            if (banWords[b] && textToTest.indexOf(banWords[b].toString().toLowerCase().trim()) > -1) {
              isBanned = true; break; 
            }
          }

          if (!isBanned) {
            var keyName = (variasi !== "" && variasi !== "-" && variasi.toLowerCase() !== "none") ? variasi : 
                          (produkName.indexOf("/") > -1 ? produkName.split("/")[0].trim() : produkName.split(" ").slice(0, 4).join(" ").trim());
            
            if (!groupedProducts[keyName]) groupedProducts[keyName] = 0;
            groupedProducts[keyName] += qty; // Disini logic SUM terjadi
          }
        });

        var outputValuesBtoE = [];
        var outputValuesF = [];
        var outputValuesG = [];
        var timeZone = Session.getScriptTimeZone();
        var formattedDate = Utilities.formatDate(new Date(), timeZone, "dd/MM/YY");

        for (var key in groupedProducts) {
          outputValuesBtoE.push([formattedCustomer, key, ekspedisi, groupedProducts[key]]);
          outputValuesF.push([isiKolomF]);
          outputValuesG.push([formattedDate]);
        }

        if (outputValuesBtoE.length === 0) {
          sheet.getRange(rowNum, 6).clearContent(); 
          continue; 
        }

        if (outputValuesBtoE.length > 1) {
          sheet.insertRowsAfter(rowNum, outputValuesBtoE.length - 1);
        }
        
        // Update Kolom B-E (Customer, Produk, Ekspedisi, Qty)
        sheet.getRange(rowNum, 2, outputValuesBtoE.length, 4).setValues(outputValuesBtoE);
        
        // Update Kolom F (No. Pesanan) dan G (Tanggal) untuk semua baris item
        sheet.getRange(rowNum, 6, outputValuesF.length, 1).setValues(outputValuesF);
        sheet.getRange(rowNum, 7, outputValuesG.length, 1).setValues(outputValuesG);
        
        countProses++;

      } else {
        sheet.getRange(rowNum, 2, 1, 4).setValues([["TIDAK DITEMUKAN", "-", "-", "-"]]);
        sheet.getRange(rowNum, 7).clearContent();
      }
    }
  }

  if (countProses > 0) {
    ss.toast("✅ Berhasil memproses data yang baru di-scan.", "SUKSES", 5);
  }
}

// =========================================================================
// 4. MODULE TIMESTAMP & 5. WEBHOOK TRACKING (TETAP SAMA)
// =========================================================================
function handleAutoTimestamp(e) {
  var sheet = e.range.getSheet();
  var range = e.range;
  var row = range.getRow();
  var col = range.getColumn();

  var now = new Date();
  var timeZone = Session.getScriptTimeZone();

  if (col === 13) {
    var cellM = range.getValue();
    if (cellM === "*") {
      sheet.getRange(row, 13).setValue("BALIK CS");
    } else if (cellM === 1) {
      sheet.getRange(row, 13).setValue(Utilities.formatDate(now, timeZone, "dd/MM/ 10.00"));
    } else if (cellM === 2) {
      sheet.getRange(row, 13).setValue(Utilities.formatDate(now, timeZone, "dd/MM/ 14.00"));
    } else if (cellM === 3) {
      sheet.getRange(row, 13).setValue(Utilities.formatDate(now, timeZone, "dd/MM/ 16.00"));
    } else if (cellM === 4) {
      sheet.getRange(row, 13).setValue(Utilities.formatDate(now, timeZone, "dd/MM/ 19.00"));
    }
    updateStatusAA(sheet, row);
  }

  if (col === 25) {
    var cellY = range.getValue();
    if (cellY === 1) {
      var formattedNow1 = Utilities.formatDate(now, timeZone, "dd/MM/ 10.00");
      sheet.getRange(row, 25).setValue(formattedNow1);
    }
  }

  var targetCols = [9, 11, 15, 17, 19, 21, 23, 25];
  if (targetCols.indexOf(col) > -1) {
    var cellVal = range.getValue();
    if (cellVal === "," || cellVal === ".") {
      sheet.getRange(row, col).setValue(Utilities.formatDate(now, timeZone, "dd/MM/ HH.mm"));
    }
  }

  if (col === 9 || col === 11) {
    updateStatus(sheet, row);
  }

  if (col === 25) {
    updateStatusAA(sheet, row);
  }
}

function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    const kode = params.kode;
    const sheetName = params.sheet;
    const timestamp = params.timestamp || params.value;
    const kolom = parseInt(params.kolom, 10);
    const offset = parseInt(params.offset || 0, 10);

    if (!kode || !sheetName || !timestamp || isNaN(kolom)) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: 'Data tidak lengkap.' })).setMimeType(ContentService.MimeType.JSON);
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: 'Sheet tidak ditemukan.' })).setMimeType(ContentService.MimeType.JSON);
    }

    const cache = CacheService.getUserCache();
    const lookupColumn = parseInt(params.lookupColumn || params.lookup_column || 1, 10);
    const cacheKey = `jobid_${sheetName}_col${lookupColumn}_${kode.toUpperCase()}`;
    const cachedRow = cache.get(cacheKey);

    let targetSheet = sheet;
    let baseRow = null;

    if (cachedRow) {
      baseRow = parseInt(cachedRow, 10);
    } else {
      const lastRow = Math.max(targetSheet.getLastRow(), 2);
      const range = targetSheet.getRange(2, lookupColumn, lastRow - 1, 1);
      const finder = range.createTextFinder(kode).matchCase(false).useRegularExpression(false);
      const match = finder.findNext();
      if (match) {
        baseRow = match.getRow();
        cache.put(cacheKey, baseRow.toString(), 21600); 
      } else if (lookupColumn === 2) {
        // Fallback: cari di tab-tab lain dalam spreadsheet yang sama jika tidak ada di tab utama
        const allSheets = ss.getSheets();
        for (let s = 0; s < allSheets.length; s++) {
          const sObj = allSheets[s];
          if (sObj.getName() === targetSheet.getName() || sObj.getName() === 'Data_Shopee' || sObj.getName() === 'Ban_List') continue;
          const sLastRow = Math.max(sObj.getLastRow(), 2);
          if (sLastRow < 2) continue;
          const sRange = sObj.getRange(2, lookupColumn, sLastRow - 1, 1);
          const sMatch = sRange.createTextFinder(kode).matchCase(false).useRegularExpression(false).findNext();
          if (sMatch) {
            targetSheet = sObj;
            baseRow = sMatch.getRow();
            const altCacheKey = `jobid_${targetSheet.getName()}_col${lookupColumn}_${kode.toUpperCase()}`;
            cache.put(altCacheKey, baseRow.toString(), 21600);
            break;
          }
        }
      }
    }

    if (baseRow) {
      const rowToUpdate = baseRow + offset;
      targetSheet.getRange(rowToUpdate, kolom).setValue(timestamp);

      const namaPetugas = params.namaPetugas || params.petugas;
      const kolomNama = parseInt(params.kolomNama || params.kolom_petugas, 10);

      if (namaPetugas && !isNaN(kolomNama)) {
        targetSheet.getRange(rowToUpdate, kolomNama).setValue(namaPetugas);
      }

      // Hanya jalankan auto-status pada sheet reguler (di mana lookupColumn == 1)
      if ((kolom === 11 || kolom === 9) && lookupColumn === 1 && targetSheet.getName() !== 'Prismatica') {
        updateStatus(targetSheet, rowToUpdate);
      }

      return ContentService.createTextOutput(JSON.stringify({ success: true, message: `Berhasil update baris ${rowToUpdate} di sheet ${targetSheet.getName()}` })).setMimeType(ContentService.MimeType.JSON);
    } else {
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: `Kode "${kode}" tidak ditemukan di kolom ${lookupColumn}.` })).setMimeType(ContentService.MimeType.JSON);
    }

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, message: err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}

function updateStatus(sheet, row) {
  var startTimeCell = sheet.getRange(row, 9).getValue(); 
  var endTimeCell = sheet.getRange(row, 11).getValue();  
  var statusCell = sheet.getRange(row, 12);              

  var formattedI = parseCustomDate(startTimeCell);
  var formattedK = parseCustomDate(endTimeCell);

  if (formattedI && formattedK) {
    var timeDiff = (formattedK - formattedI) / (1000 * 60 * 60); 
    if (timeDiff > 6) {
      statusCell.setValue("❌").setBackground("#FF0000").setFontColor("#FFFFFF");
    } else {
      statusCell.setValue("✅").setBackground("#00FF00").setFontColor("#000000");
    }
  } else {
    const colStatus = 11;
    const val = sheet.getRange(row, colStatus).getValue();
    if (!val || val === '') {
      sheet.getRange(row, colStatus).setValue('✅');
    }
  }
}

// function updateStatusAA(sheet, row) {
//   var colM = sheet.getRange(row, 13).getValue(); 
//   var colY = sheet.getRange(row, 25).getValue(); 
//   var statusCell = sheet.getRange(row, 27);      

//   if (!(colM instanceof Date)) colM = parseCustomDate(colM);
//   if (!(colY instanceof Date)) colY = parseCustomDate(colY);

//   if (colM instanceof Date && colY instanceof Date) {
//     var selisihHari = Math.floor((colY - colM) / (1000 * 60 * 60 * 24));

//     if (selisihHari > 3) {
//       statusCell.setValue("❌").setBackground("#FF0000").setFontColor("#FFFFFF");
//     } else {
//       statusCell.setValue("✅").setBackground("#00FF00").setFontColor("#000000");
//     }
//   } else {
//     statusCell.setValue("").setBackground("#FFFFFF").setFontColor("#000000");
//   }
// }

function parseCustomDate(inputValue) {
  if (!inputValue) return null;
  var tahunSekarang = new Date().getFullYear();
  inputValue = inputValue.toString().replace(",", "."); 
  var regex = /^(\d{2})\/(\d{2})\/ (\d{2})\.(\d{2})$/;
  var match = inputValue.match(regex);

  if (match) {
    var day = parseInt(match[1], 10);
    var month = parseInt(match[2], 10) - 1;
    var hour = parseInt(match[3], 10);
    var minute = parseInt(match[4], 10);
    return new Date(tahunSekarang, month, day, hour, minute);
  }
  return null;
}

function updateAllStatusAA() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const lastRow = sheet.getLastRow();

  for (let i = 2; i <= lastRow; i++) {
    updateStatusAA(sheet, i);
  }
}

function doGet(e) {
  try {
    const { jobId, sheetName, configJson } = e.parameter;
    if (!jobId || !sheetName || !configJson) throw new Error("Parameter tidak lengkap.");

    const config = JSON.parse(configJson);
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(sheetName);

    if (!sheet) throw new Error(`Sheet dengan nama "${sheetName}" tidak ditemukan.`);
    
    const result = searchInSingleSheetWithCache(sheet, jobId.trim(), config);

    if (result) return createJsonResponse(result);
    return createJsonResponse({ "error": "Job ID tidak ditemukan." });

  } catch (error) {
    return createJsonResponse({ "error": "Kesalahan server: " + error.message });
  }
}

function searchInSingleSheetWithCache(sheet, jobId, config) {
  const cache = CacheService.getUserCache();
  const cacheKey = `jobid_${sheet.getName()}_${jobId.toUpperCase()}`;
  
  const cachedRow = cache.get(cacheKey);
  if (cachedRow) {
    const rowNumber = parseInt(cachedRow, 10);
    const rowData = sheet.getRange(rowNumber, 1, 1, sheet.getLastColumn()).getValues()[0];
    return buildResultObject(rowData, config);
  }

  const dataRows = sheet.getDataRange().getValues(); 
  const jobIdColIndex = config.jobId - 1;
  
  for (let i = 1; i < dataRows.length; i++) { 
    const row = dataRows[i];
    const currentRowJobId = row[jobIdColIndex] ? row[jobIdColIndex].toString().trim() : '';

    if (currentRowJobId.toLowerCase() === jobId.toLowerCase()) {
      const rowNumber = i + 1; 
      cache.put(cacheKey, rowNumber.toString(), 172800); 
      return buildResultObject(row, config);
    }
  }
  return null; 
}

function buildResultObject(row, config) {
  const progressData = {};
  const nonProgressKeys = ['sheet', 'webhook', 'jobId', 'customer', 'product', 'expedisi', 'orderNumber'];

  for (const key in config) {
    if (!nonProgressKeys.includes(key)) {
      const columnIndex = config[key];
      progressData[key] = formatStatus(row[columnIndex - 1]);
    }
  }

  return {
    jobId: row[config.jobId - 1],
    customer: row[config.customer - 1],
    product: row[config.product - 1],
    orderNumber: row[config.orderNumber - 1],
    expedisi: row[config.expedisi - 1],
    progress: progressData
  };
}

function formatStatus(cellValue) {
  if (!cellValue) return null;

  if (cellValue instanceof Date) {
    const day = ('0' + cellValue.getDate()).slice(-2);
    const month = ('0' + (cellValue.getMonth() + 1)).slice(-2);
    const hours = ('0' + cellValue.getHours()).slice(-2);
    const minutes = ('0' + cellValue.getMinutes()).slice(-2);
    return `${day}/${month}/ ${hours}.${minutes}`;
  }
  
  const trimmedValue = cellValue.toString().trim();
  if (trimmedValue.includes('/') && (trimmedValue.includes('.') || trimmedValue.includes(':'))) return trimmedValue;
  return trimmedValue !== '' ? 'Selesai' : null;
}

function createJsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}