# mssql-data — Plugin Analis Data untuk SQL Server 2022 (On-Premises)

Plugin Claude Code yang menggabungkan:

- **Skill dari plugin `data`** ([anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins/tree/main/data)), ditulis ulang khusus untuk **T-SQL / SQL Server 2022**.
- **MCP server [DBHub](https://github.com/bytebase/dbhub)** (`@bytebase/dbhub@1.5.0`). Server ini berjalan **lokal** dan terhubung langsung ke SQL Server internal, tanpa layanan cloud.

Server database **tidak** diatur saat instalasi. Setelah plugin terpasang, tambahkan server sebanyak yang dibutuhkan dengan `/mssql-data:add-server`, dan semuanya aktif bersamaan.

## Isi Plugin

### Slash command

| Command | Fungsi |
|---------|--------|
| `/mssql-data:add-server` | Menambah server SQL Server. Password diketik di dialog macOS lalu disimpan di Keychain |
| `/mssql-data:manage-servers` | Melihat daftar server, menghapus server, mengganti password atau detail koneksi |
| `/mssql-data:mssql-setup` | Skrip login read-only untuk DBA, verifikasi koneksi, dan troubleshooting |
| `/mssql-data:analyze` | Menjawab pertanyaan data, dari lookup cepat sampai laporan formal |
| `/mssql-data:explore-data` | Profiling tabel/view: null, kardinalitas, distribusi, isu kualitas data |
| `/mssql-data:write-query` | Menulis T-SQL yang optimal, plus cek execution plan |
| `/mssql-data:validate-data` | QA analisis sebelum dibagikan, termasuk jebakan khas T-SQL |
| `/mssql-data:create-viz` | Visualisasi Python (matplotlib, seaborn, plotly) |
| `/mssql-data:build-dashboard` | Dashboard HTML interaktif (snapshot data) |
| `/mssql-data:data-context-extractor` | Membuat skill khusus perusahaan (entitas, metrik, filter standar) dari database kamu |

### Skill latar (dipakai otomatis oleh Claude)

| Skill | Fungsi |
|-------|--------|
| `tsql-queries` | Referensi T-SQL SQL Server 2022: `DATETRUNC`, `DATE_BUCKET`, `GENERATE_SERIES`, `GREATEST`/`LEAST`, `IS DISTINCT FROM`, `WINDOW`, `APPROX_PERCENTILE_CONT`, JSON 2022, query katalog, performa, dan debugging |
| `schema-discovery` | Eksplorasi skema hemat token dengan `search_objects` milik DBHub |
| `statistical-analysis` | Statistik deskriptif, tren, outlier, uji hipotesis |
| `data-visualization` | Pemilihan chart dan prinsip desain visualisasi |

### Tool MCP (DBHub)

Setiap server yang ditambahkan menjadi satu source DBHub dengan tool sendiri:

| Satu server | Beberapa server | Keterangan |
|-------------|-----------------|------------|
| `execute_sql` | `execute_sql_<server>` | Read-only, maksimal 1000 baris, timeout 60 detik |
| `search_objects` | `search_objects_<server>` | Cari schema, tabel, view, kolom, prosedur, fungsi, dan index |
| `explain_sql` | `explain_sql_<server>` | Estimated execution plan (SHOWPLAN_XML), **tidak** mengeksekusi query |
| `health_check` | `health_check_<server>` | Metrik pool koneksi dan buffer cache (butuh `VIEW SERVER STATE`) |

Selama belum ada server, MCP `dbhub` tetap berjalan tanpa tool dan mengarahkan Claude ke `/mssql-data:add-server`.

## Prasyarat

- Claude Code (desktop app atau terminal)
- **Node.js >= 22.5.0** (`node --version`). DBHub diunduh otomatis lewat `npx` saat pertama kali dipakai
- macOS, supaya password tersimpan di Keychain. Di OS lain password disimpan di file dengan izin 600 (lihat "Keamanan")
- Laptop ini bisa menjangkau SQL Server (jaringan kantor atau VPN)
- Login SQL Server yang **read-only** (skripnya ada di `/mssql-data:mssql-setup`)

## Instalasi

Jalankan di **Terminal**. Dialog `/plugin` tidak tersedia di Code tab desktop.

### Dari GitHub

```bash
claude plugin marketplace add mzswrwww4z-art/mssql-data-marketplace
```
```bash
claude plugin install mssql-data@mssql-data-marketplace --scope user
```

### Dari folder lokal

```bash
claude plugin marketplace add "/path/permanen/mssql-data-marketplace"
```
```bash
claude plugin install mssql-data@mssql-data-marketplace --scope user
```

> **Penting:** untuk instalasi dari folder lokal, Claude Code versi terbaru (termasuk yang dibawa desktop app) membaca plugin **langsung dari folder sumbernya**. `claude plugin list` akan menampilkan "Read from: …", sehingga perubahan file di folder itu berlaku di sesi berikutnya. Versi lama mungkin memakai salinan di `~/.claude/plugins/cache/`; kalau perubahan tidak terambil, jalankan `claude plugin update mssql-data@mssql-data-marketplace`. Karena dibaca langsung, simpan folder ini di lokasi permanen dan jangan dipindah atau dihapus.

### Update

```bash
claude plugin marketplace update mssql-data-marketplace && claude plugin update mssql-data@mssql-data-marketplace
```

Daftar server dan password tidak terpengaruh oleh update atau instal ulang.

**Upgrade dari 1.x:** versi 1.x memakai satu DSN yang diisi lewat `set-dsn.sh`. Fitur itu sudah dihapus. Setelah update, tambahkan server dengan `/mssql-data:add-server`.

## Menambah dan Mengelola Server

1. Buka sesi Claude Code dan jalankan `/mssql-data:add-server`. Detail boleh langsung disebutkan, misalnya `/mssql-data:add-server sales di 10.10.1.20, database SalesDB, login report_ro`.
2. Claude menanyakan detail yang masih kurang, lalu membuka **dialog password macOS**. Ketik password di sana; password tidak pernah lewat chat.
3. Buka **sesi baru**, dan server langsung bisa dipakai. Ulangi langkah ini untuk server lain.

| Detail | Contoh / default |
|--------|------------------|
| Nama server (`--id`) | `sales`, `hr_prod`: huruf kecil, angka, `_`. Dipakai sebagai akhiran nama tool |
| Host / port | `10.10.1.20` / `1433` |
| Database | Database default koneksi |
| Login | Disarankan login read-only |
| Autentikasi | `sql` (default) atau `ntlm` + `--domain CORP` untuk akun Windows/AD |
| Named instance | `--instance PROD` (opsional) |
| Enkripsi | `require` (default, cocok untuk sertifikat self-signed di server internal), `verify-full`, atau `disable` |
| Deskripsi | Opsional; Claude membacanya saat memilih server |

`/mssql-data:manage-servers` dipakai untuk melihat daftar, menghapus server, mengganti password, atau mengubah detail (password lama dipertahankan).

Semua fungsi itu juga bisa dijalankan langsung dari terminal dengan `node <folder plugin>/scripts/mssql-servers.mjs <perintah>`. Perintah yang tersedia: `add`, `list`, `remove`, `set-password`, `info`. Jalankan `info` untuk melihat lokasi file.

| Data | Lokasi |
|------|--------|
| Daftar server (tanpa password) | `~/.config/mssql-data/servers.json`, izin 600 |
| Password | macOS Keychain, layanan `mssql-data`, satu item per server |

## Keamanan

- **Read-only berlapis.** DBHub hanya menerima statement yang diawali `SELECT`/`WITH`, dan memblokir `EXEC`, `sp_executesql`, `xp_cmdshell`, `OPENQUERY`/`OPENROWSET`, serta keyword DML/DDL. Tetap gunakan login `db_datareader` sebagai lapisan kedua.
- **Password tidak lewat chat dan tidak ditulis ke file.** Password diketik di dialog macOS (atau prompt tersembunyi di terminal), disimpan di Keychain lewat stdin sehingga tidak terlihat di daftar proses, lalu diberikan ke DBHub lewat environment variable saat sesi dimulai. Konfigurasi DBHub yang dibuat setiap sesi tidak berisi password.
- **Di luar macOS**, password disimpan di `~/.config/mssql-data/secrets.json` dengan izin 600 (teks biasa).
- **Batas hasil 1000 baris dan timeout 60 detik per query** untuk melindungi server produksi. Claude diarahkan untuk melakukan agregasi di server.

## Konsekuensi Mode Read-Only

Karena setiap statement wajib diawali `SELECT`/`WITH`, beberapa hal tidak bisa dijalankan lewat plugin: `DECLARE`, tabel `#temp`, `SELECT INTO`, `EXEC sp_help`, dan dynamic PIVOT. Skill sudah mengarahkan Claude ke alternatifnya (CTE `params`, query katalog `sys.*`, PIVOT eksplisit). Untuk skrip tulis (view, stored procedure, index), Claude akan menuliskan skripnya supaya kamu jalankan sendiri di SSMS/Azure Data Studio.

## Pengembangan

Tes ada di `tests/` di root repo. Jalankan dari root dengan:

```bash
node --test
```

Tes memakai folder konfigurasi sementara dan penyimpanan password berbasis file, jadi tidak menyentuh Keychain.

## Struktur

```
mssql-data-marketplace/
├── .claude-plugin/marketplace.json
├── tests/mssql-servers.test.mjs
└── plugins/mssql-data/
    ├── .claude-plugin/plugin.json      # manifest (tanpa opsi instalasi)
    ├── .mcp.json                       # MCP "dbhub" -> scripts/start-dbhub.mjs
    ├── scripts/
    │   ├── start-dbhub.mjs             # bangun konfigurasi DBHub dari daftar server, jalankan DBHub
    │   ├── mssql-servers.mjs           # add, list, remove, set-password, info
    │   └── lib.mjs                     # validasi, Keychain, pembuat TOML
    ├── skills/
    │   ├── add-server/  manage-servers/  mssql-setup/
    │   ├── analyze/  explore-data/  write-query/  validate-data/
    │   ├── create-viz/  build-dashboard/  data-context-extractor/
    │   └── tsql-queries/  schema-discovery/  statistical-analysis/  data-visualization/
    ├── README.md
    └── LICENSE                         # Apache-2.0 (dari plugin data Anthropic)
```

## Atribusi

- Skill diadaptasi dari plugin `data` di [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) (Apache-2.0).
- `schema-discovery` dan `mssql-setup` diadaptasi dari skill plugin [DBHub](https://github.com/bytebase/dbhub) (MIT).
