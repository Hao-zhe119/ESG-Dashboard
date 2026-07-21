# ESG Dashboard

Republic Polytechnic ESG dashboard built with Node.js, Express, EJS, MySQL/XAMPP, and Bootstrap.

## Setup

1. Install Node.js and XAMPP.
2. Start MySQL from XAMPP.
3. Import `esgdashboard.sql` into a MySQL database named `esgdashboard`.
4. Copy `databaseinfo.env.example` to `databaseinfo.env`.
5. Update `databaseinfo.env` if your MySQL username or password is different.
6. Install dependencies:

```powershell
npm.cmd install
```

7. Start the dashboard:

```powershell
npm.cmd run devStart
```

Open `http://localhost:3000/`.

## Useful Commands

Run checks:

```powershell
npm.cmd test
```

Start production-style without nodemon:

```powershell
npm.cmd start
```

If PowerShell blocks `npm`, use `npm.cmd` instead.

## Database Migration

Older local XAMPP databases may be missing the timer animation column. Run this once if the admin page says the database is unavailable even though XAMPP MySQL is running:

```powershell
Get-Content scripts\migrate-timers-background-animation.sql | C:\xampp\mysql\bin\mysql.exe -u root esgdashboard
```

## Admin Demo Notes

- Dashboard settings include a protected default profile and custom profiles.
- Timer settings include default timing and timer profiles.
- Health checks show PC health and application/database health.
- Process controls can start, stop, and restart the app or XAMPP database.
- Auto-hibernate can hibernate/sleep the laptop at scheduled times.
- Auto-wake uses Windows Task Scheduler and can wake from sleep/hibernate, but a normal app cannot reliably power on a laptop from full shutdown. Full shutdown wake depends on BIOS/UEFI RTC alarm or Wake-on-LAN support.
- `Hibernate Now` is a real demo action and can immediately put the laptop into hibernate.

## Local Files

These files are intentionally local and should not be committed:

- `databaseinfo.env`
- `config/dashboardRuntimeConfig.json`
- `node_modules/`
- new files inside `public/uploads/`
- `.DS_Store`
