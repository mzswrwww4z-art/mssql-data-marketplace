# mssql-data-marketplace

Marketplace Claude Code berisi plugin **mssql-data**: analis data untuk SQL Server 2022 on-premises. Plugin ini menggabungkan skill dari plugin `data` milik Anthropic (ditulis ulang khusus T-SQL) dengan MCP server [DBHub](https://github.com/bytebase/dbhub). Koneksinya langsung dari laptop ke SQL Server internal, read-only, tanpa layanan cloud.

## Instal

Butuh Claude Code minimal 2.1.285, Node.js minimal 22.5, dan akses jaringan ke SQL Server (kantor atau VPN). Jalankan di Terminal:

```bash
claude plugin marketplace add mzswrwww4z-art/mssql-data-marketplace
```
```bash
claude plugin install mssql-data@mssql-data-marketplace --scope user
```

Isi DSN. Langkah ini wajib, karena MCP `dbhub` baru terdaftar setelah DSN diisi:

```bash
~/.claude/plugins/marketplaces/mssql-data-marketplace/plugins/mssql-data/scripts/set-dsn.sh
```

Lalu buka sesi Claude Code baru. Panduan lengkap (format DSN, login read-only, troubleshooting): [plugins/mssql-data/README.md](plugins/mssql-data/README.md).
