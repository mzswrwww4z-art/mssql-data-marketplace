# mssql-data — Plugin Analis Data untuk SQL Server 2022 (On-Premises)

Plugin Claude Code untuk **Windows**, baik **Claude CLI** maupun **ekstensi Claude Code di VS Code**. macOS juga didukung. Plugin ini menggabungkan:

- **Skill dari plugin `data`** ([anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins/tree/main/data)), ditulis ulang khusus untuk **T-SQL / SQL Server 2022**.
- **MCP server [DBHub](https://github.com/bytebase/dbhub)** (`@bytebase/dbhub@1.5.0`). Server ini berjalan **lokal** di laptop dan terhubung langsung ke SQL Server internal, tanpa layanan cloud.

Server database **tidak** diatur saat instalasi. Setelah plugin terpasang, tambahkan server sebanyak yang dibutuhkan dengan `/mssql-data:add-server`, dan semuanya aktif bersamaan.

## Isi Plugin

### Slash command

| Command | Fungsi |
|---------|--------|
| `/mssql-data:add-server` | Menambah server SQL Server. Password diketik di jendela password, lalu disimpan terenkripsi |
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
| `schema-discovery` | Memilih database dan mengeksplorasi skema dengan hemat token |
| `statistical-analysis` | Statistik deskriptif, tren, outlier, uji hipotesis |
| `data-visualization` | Pemilihan chart dan prinsip desain visualisasi |

### Tool MCP (DBHub)

Setiap server yang ditambahkan menjadi satu source DBHub dengan tool sendiri:

| Satu server | Beberapa server | Keterangan |
|-------------|-----------------|------------|
| `execute_sql` | `execute_sql_<server>` | Read-only, maksimal 1000 baris, timeout 60 detik |
| `search_objects` | `search_objects_<server>` | Cari schema, tabel, view, kolom, prosedur, fungsi, dan index di database default login |
| `explain_sql` | `explain_sql_<server>` | Estimated execution plan (SHOWPLAN_XML), **tidak** mengeksekusi query |
| `health_check` | `health_check_<server>` | Metrik pool koneksi dan buffer cache (butuh `VIEW SERVER STATE`) |

Koneksi tidak terikat ke satu database. Koneksi masuk ke **database default milik login**, dan database lain di server yang sama diakses dengan nama tiga bagian, misalnya `SalesDB.dbo.Orders`. Selama belum ada server, MCP `dbhub` tetap berjalan tanpa tool dan mengarahkan Claude ke `/mssql-data:add-server`.

## Prasyarat (Windows)

- Windows 10 atau 11.
- **Node.js >= 22.5.0**, misalnya `winget install OpenJS.NodeJS.LTS`. Setelah instalasi, tutup lalu buka lagi terminal dan VS Code. DBHub diunduh otomatis lewat npm saat pertama kali dipakai.
- **Claude Code**: CLI `claude`, ekstensi VS Code, atau keduanya. Instalasi plugin memakai perintah `claude` di terminal (PowerShell atau terminal VS Code). Plugin yang diinstal dengan scope `user` otomatis tersedia di CLI maupun di ekstensi VS Code.
- **Git for Windows**, yang memang dibutuhkan Claude Code di Windows.
- **PowerShell bawaan Windows**, dipakai untuk jendela password dan enkripsi DPAPI. Pastikan tidak diblokir kebijakan IT.
- Laptop bisa menjangkau SQL Server (jaringan kantor atau VPN).
- Login SQL Server yang **read-only** (skripnya ada di `/mssql-data:mssql-setup`).

Untuk macOS, kebutuhannya sama, minus PowerShell dan Git for Windows. Password di macOS disimpan di Keychain.

## Instalasi

Jalankan di terminal (PowerShell atau terminal VS Code):

```powershell
claude plugin marketplace add mzswrwww4z-art/mssql-data-marketplace
```
```powershell
claude plugin install mssql-data@mssql-data-marketplace --scope user
```

Setelah itu buka sesi baru: di VS Code, mulai percakapan Claude baru (atau reload window); di CLI, jalankan ulang `claude`.

### Update

```powershell
claude plugin marketplace update mssql-data-marketplace
```
```powershell
claude plugin update mssql-data@mssql-data-marketplace
```

Daftar server dan password tidak terpengaruh oleh update atau instal ulang.

- **Dari 2.x:** opsi `--database` sudah dihapus. Server yang sudah ada tetap bisa dipakai; field database-nya diabaikan, dan koneksi sekarang masuk ke database default login.
- **Dari 1.x:** fitur DSN tunggal (`set-dsn.sh`) sudah dihapus. Tambahkan server dengan `/mssql-data:add-server`.

### Dari folder lokal (untuk pengembangan)

```powershell
claude plugin marketplace add "C:\path\permanen\mssql-data-marketplace"
```

Instalasi dari folder lokal dibaca langsung dari folder itu, jadi jangan dipindah atau dihapus setelahnya.

## Menambah dan Mengelola Server

1. Di Claude (CLI atau VS Code), jalankan `/mssql-data:add-server`. Detail boleh langsung disebutkan, misalnya `/mssql-data:add-server sales di 10.10.1.20, login report_ro`.
2. Claude menanyakan detail yang masih kurang, lalu membuka **jendela password "mssql-data"**. Ketik password di sana, lalu klik **Simpan**. Password tidak pernah lewat chat, dan karakter khusus tidak perlu di-encode.
3. Buka **sesi baru**, dan server langsung bisa dipakai. Ulangi langkah ini untuk server lain.

| Detail | Contoh / default |
|--------|------------------|
| Nama server (`--id`) | `sales`, `hr_prod`: huruf kecil, angka, `_`. Dipakai sebagai akhiran nama tool |
| Host / port | `10.10.1.20` / `1433` |
| Login | Disarankan login read-only |
| Autentikasi | `sql` (default) atau `ntlm` + `--domain CORP` untuk akun Windows/AD |
| Named instance | `--instance PROD` (opsional) |
| Enkripsi | `require` (default, cocok untuk sertifikat self-signed di server internal), `verify-full`, atau `disable` |
| Deskripsi | Opsional; Claude membacanya saat memilih server |

Supaya pencarian skema langsung mengarah ke database tertentu, minta DBA mengatur database default login (`ALTER LOGIN ... WITH DEFAULT_DATABASE`, ada di `/mssql-data:mssql-setup`).

`/mssql-data:manage-servers` dipakai untuk melihat daftar, menghapus server, mengganti password, atau mengubah detail (password lama dipertahankan).

Semua fungsi itu juga bisa dijalankan langsung dari terminal. Kalau dijalankan di terminal, password diminta dengan prompt tersembunyi. Contoh di PowerShell:

```powershell
node "$env:USERPROFILE\.claude\plugins\marketplaces\mssql-data-marketplace\plugins\mssql-data\scripts\mssql-servers.mjs" list
```

Perintah yang tersedia: `add`, `list`, `remove`, `set-password`, `info` (menampilkan lokasi file).

| Data | Windows | macOS |
|------|---------|-------|
| Daftar server (tanpa password) | `%LOCALAPPDATA%\mssql-data\servers.json` | `~/.config/mssql-data/servers.json` |
| Password | `%LOCALAPPDATA%\mssql-data\secrets.dpapi.json`, terenkripsi Windows DPAPI | macOS Keychain, layanan `mssql-data` |

## Keamanan

- **Read-only berlapis.** DBHub hanya menerima statement yang diawali `SELECT`/`WITH`, dan memblokir `EXEC`, `sp_executesql`, `xp_cmdshell`, `OPENQUERY`/`OPENROWSET`, serta keyword DML/DDL. Tetap gunakan login `db_datareader` sebagai lapisan kedua.
- **Password tidak lewat chat dan tidak tersimpan sebagai teks biasa.** Di Windows, password dienkripsi dengan **DPAPI**, sehingga hanya bisa dibuka oleh user Windows yang sama di laptop yang sama; file `secrets.dpapi.json` yang disalin ke komputer lain tidak bisa dibaca. Di macOS, password disimpan di Keychain. Password dikirim ke DBHub lewat environment variable saat sesi dimulai, dan konfigurasi DBHub yang dibuat setiap sesi tidak berisi password.
- **Batas hasil 1000 baris dan timeout 60 detik per query** untuk melindungi server produksi. Claude diarahkan untuk melakukan agregasi di server.

## Konsekuensi Mode Read-Only

Karena setiap statement wajib diawali `SELECT`/`WITH`, beberapa hal tidak bisa dijalankan lewat plugin: `USE`, `DECLARE`, tabel `#temp`, `SELECT INTO`, `EXEC sp_help`, dan dynamic PIVOT. Skill sudah mengarahkan Claude ke alternatifnya (nama tiga bagian, CTE `params`, query katalog `sys.*`, PIVOT eksplisit). Untuk skrip tulis (view, stored procedure, index), Claude akan menuliskan skripnya supaya kamu jalankan sendiri di SSMS/Azure Data Studio.

## Pengembangan

Tes ada di `tests/` di root repo. Jalankan dari root dengan:

```bash
node --test
```

Tes memakai folder konfigurasi sementara dan penyimpanan password berbasis file. Ada juga tes opt-in yang memakai fasilitas OS sungguhan:
- `MSSQL_DATA_TEST_DPAPI=1` untuk Windows DPAPI
- `MSSQL_DATA_TEST_KEYCHAIN=1` untuk macOS Keychain
- `MSSQL_DATA_TEST_DIALOG=1` untuk jendela password

GitHub Actions (`.github/workflows/test.yml`) menjalankan semua tes di Windows, macOS, dan Linux, termasuk DPAPI dan jendela password di Windows.

## Struktur

```
mssql-data-marketplace/
├── .claude-plugin/marketplace.json
├── .github/workflows/test.yml          # tes di Windows, macOS, Linux
├── tests/mssql-servers.test.mjs
└── plugins/mssql-data/
    ├── .claude-plugin/plugin.json      # manifest (tanpa opsi instalasi)
    ├── .mcp.json                       # MCP "dbhub" -> scripts/start-dbhub.mjs
    ├── scripts/
    │   ├── start-dbhub.mjs             # bangun konfigurasi DBHub dari daftar server, jalankan DBHub
    │   ├── mssql-servers.mjs           # add, list, remove, set-password, info
    │   └── lib.mjs                     # validasi, DPAPI/Keychain, jendela password, pembuat TOML
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
