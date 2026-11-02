# mssql-data — Plugin Analis Data untuk SQL Server 2022 (On-Premises)

Plugin Claude Code yang menggabungkan:

- **Skill dari plugin `data`** ([anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins/tree/main/data)), ditulis ulang hanya untuk **T-SQL / SQL Server 2022**. Semua materi Snowflake, BigQuery, Databricks, Redshift, PostgreSQL, dan MySQL sudah dihapus.
- **MCP server [DBHub](https://github.com/bytebase/dbhub)** (`@bytebase/dbhub@1.5.0`). Server ini berjalan **lokal** lewat stdio dan terhubung langsung ke SQL Server internal kamu, tanpa layanan cloud.

## Isi Plugin

### Slash command

| Command | Fungsi |
|---------|--------|
| `/mssql-data:mssql-setup` | Membuat DSN, mengatasi koneksi gagal, membuat login read-only, dan setup multi-database |
| `/mssql-data:analyze` | Menjawab pertanyaan data, dari lookup cepat sampai laporan formal |
| `/mssql-data:explore-data` | Profiling tabel/view: null, kardinalitas, distribusi, isu kualitas data |
| `/mssql-data:write-query` | Menulis T-SQL yang optimal, plus cek execution plan |
| `/mssql-data:validate-data` | QA analisis sebelum dibagikan, termasuk jebakan khas T-SQL |
| `/mssql-data:create-viz` | Visualisasi Python (matplotlib/seaborn/plotly) |
| `/mssql-data:build-dashboard` | Dashboard HTML interaktif (snapshot data) |
| `/mssql-data:data-context-extractor` | Membuat skill khusus perusahaan (entitas, metrik, filter standar) dari database kamu |

### Skill latar (dipakai otomatis oleh Claude)

| Skill | Fungsi |
|-------|--------|
| `tsql-queries` | Referensi T-SQL SQL Server 2022: `DATETRUNC`, `DATE_BUCKET`, `GENERATE_SERIES`, `GREATEST`/`LEAST`, `IS DISTINCT FROM`, `WINDOW`, `APPROX_PERCENTILE_CONT`, JSON 2022, query katalog, performa, dan debugging |
| `schema-discovery` | Eksplorasi skema hemat token dengan `search_objects` milik DBHub |
| `statistical-analysis` | Statistik deskriptif, tren, outlier, uji hipotesis |
| `data-visualization` | Pemilihan chart dan prinsip desain visualisasi |

### Tool MCP (DBHub, source `mssql`)

| Tool | Keterangan |
|------|------------|
| `execute_sql` | Read-only, maksimal 1000 baris, timeout 60 detik |
| `search_objects` | Cari schema, tabel, view, kolom, prosedur, fungsi, dan index |
| `explain_sql` | Estimated execution plan (SHOWPLAN_XML), **tidak** mengeksekusi query |
| `health_check` | Metrik pool koneksi dan buffer cache (butuh `VIEW SERVER STATE`) |

## Prasyarat

- Claude Code
- **Node.js >= 22.5.0** (`node --version`). `npx` mengunduh DBHub saat pertama kali dijalankan
- Mesin ini bisa menjangkau SQL Server (jaringan kantor/VPN, firewall TCP 1433 terbuka)
- Login SQL Server yang **read-only** (lihat skrip di `/mssql-data:mssql-setup`)

## Instalasi

Dari folder yang berisi `mssql-data-marketplace/`, jalankan di Claude Code:

```
/plugin marketplace add ./mssql-data-marketplace
/plugin install mssql-data@mssql-data-marketplace
```

Saat instalasi, Claude Code akan meminta **DSN** dan menyimpannya di secure storage (tidak tersimpan di file mana pun):

```
sqlserver://report_ro:PASSWORD@10.10.1.20:1433/SalesDB?sslmode=require
```

| Kasus | Tambahan di DSN |
|-------|-----------------|
| Named instance | `&instanceName=PROD` |
| Login Windows/AD | `&authentication=ntlm&domain=CORP` |
| Sertifikat self-signed (umum di server internal) | `sslmode=require` |
| Sertifikat dari CA internal yang dipercaya | `sslmode=verify-full` |

Karakter khusus di password wajib di-URL-encode: `@`→`%40`, `:`→`%3A`, `/`→`%2F`, `#`→`%23`, `%`→`%25`, `&`→`%26`.

Untuk mengganti DSN: `/plugin` → **mssql-data** → configuration, lalu `/mcp` → reconnect `dbhub`.

## Keamanan

- **Read-only berlapis.** DBHub hanya menerima statement yang diawali `SELECT`/`WITH`, dan memblokir `EXEC`, `sp_executesql`, `xp_cmdshell`, `OPENQUERY`/`OPENROWSET`, serta keyword DML/DDL. Tetap gunakan login `db_datareader` sebagai lapisan kedua.
- **Kredensial tidak pernah ditulis ke file.** DSN disimpan di secure storage Claude Code.
- **Batas hasil 1000 baris dan timeout 60 detik.** Ini melindungi server produksi. Claude diarahkan untuk melakukan agregasi di server.
- Jangan tempel password ke chat.

## Konsekuensi Mode Read-Only

Karena setiap statement wajib diawali `SELECT`/`WITH`, beberapa hal tidak bisa dijalankan lewat plugin: `DECLARE`, tabel `#temp`, `SELECT INTO`, `EXEC sp_help`, dan dynamic PIVOT. Skill sudah mengarahkan Claude ke alternatifnya (CTE `params`, query katalog `sys.*`, PIVOT eksplisit). Untuk skrip tulis (view, stored procedure, index), Claude akan menuliskan skripnya supaya kamu jalankan sendiri di SSMS/Azure Data Studio.

## Multi-Database / Akses Tulis

Plugin ini menangani satu database. Untuk beberapa database atau server, SSH tunnel, atau custom tool berparameter, salin `templates/dbhub.multi-source.toml`, isi sesuai kebutuhan, lalu:

```bash
claude mcp add dbhub-mssql -- npx -y @bytebase/dbhub@1.5.0 --transport stdio --config ~/.config/dbhub/mssql.toml
```

Setelah itu matikan server `dbhub` bawaan plugin supaya tidak ada dua instance.

## Struktur

```
mssql-data-marketplace/
├── .claude-plugin/marketplace.json
└── plugins/mssql-data/
    ├── .claude-plugin/plugin.json      # manifest + userConfig DSN (sensitive)
    ├── .mcp.json                       # DBHub 1.5.0 via npx, stdio
    ├── dbhub.toml                      # source "mssql", read-only, 4 tools
    ├── templates/dbhub.multi-source.toml
    ├── skills/
    │   ├── mssql-setup/  analyze/  explore-data/  write-query/  validate-data/
    │   ├── create-viz/  build-dashboard/  data-context-extractor/
    │   └── tsql-queries/  schema-discovery/  statistical-analysis/  data-visualization/
    ├── README.md
    └── LICENSE                         # Apache-2.0 (dari plugin data Anthropic)
```

## Atribusi

- Skill diadaptasi dari plugin `data` di [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) (Apache-2.0).
- `schema-discovery` dan `mssql-setup` diadaptasi dari skill plugin [DBHub](https://github.com/bytebase/dbhub) (MIT).
