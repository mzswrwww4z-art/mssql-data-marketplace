# mssql-data-marketplace

Marketplace Claude Code berisi plugin **mssql-data**: analis data untuk SQL Server 2022 on-premises, untuk **Windows** (Claude CLI atau ekstensi Claude Code di VS Code) dan macOS. Plugin ini menggabungkan skill dari plugin `data` milik Anthropic (ditulis ulang khusus T-SQL) dengan MCP server [DBHub](https://github.com/bytebase/dbhub). Koneksinya langsung dari laptop ke SQL Server internal, read-only, tanpa layanan cloud.

## Instal

Butuh Claude Code, Node.js minimal 22.5 (`winget install OpenJS.NodeJS.LTS`), dan akses jaringan ke SQL Server (kantor atau VPN). Jalankan di PowerShell atau terminal VS Code:

```powershell
claude plugin marketplace add mzswrwww4z-art/mssql-data-marketplace
```
```powershell
claude plugin install mssql-data@mssql-data-marketplace --scope user
```

## Tambah server

Buka sesi Claude baru (CLI atau VS Code), lalu jalankan `/mssql-data:add-server`. Claude menanyakan host dan login, lalu membuka jendela password "mssql-data". Password tidak lewat chat dan disimpan terenkripsi (Windows DPAPI, atau Keychain di macOS). Setelah itu buka sesi baru, dan server siap dipakai. Server lain bisa ditambahkan dengan cara yang sama, dan semuanya aktif bersamaan.

## Update

```powershell
claude plugin marketplace update mssql-data-marketplace
```
```powershell
claude plugin update mssql-data@mssql-data-marketplace
```

Panduan lengkap (prasyarat Windows, detail server, keamanan, troubleshooting): [plugins/mssql-data/README.md](plugins/mssql-data/README.md).
