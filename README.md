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

## Ollama Setup (Ask AI Assistant)

The dashboard's "Ask AI" chat assistant (in the Building Controls panel) runs entirely on your local machine using [Ollama](https://ollama.com) — no data leaves the machine, and no API key is required.

1. Download and install Ollama for Windows from https://ollama.com/download.
2. Pull the model the app uses by default:

```powershell
ollama pull llama3.2:3b
```

3. Ollama normally starts automatically in the background after install. If the Ask AI chat shows "Assistant unavailable", start the server manually:

```powershell
ollama serve
```

4. (Optional) To use a different model or a remote Ollama host, add these to `databaseinfo.env`:

```
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:3b
```

If you change `OLLAMA_MODEL`, pull that model first with `ollama pull <model-name>` — otherwise the assistant will fail with a "model not found" error.

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

## Troubleshooting

**`#1142 - CREATE command denied to user 'ESGAdmin'@'localhost'`** (or the console shows "Could not create assistant_questions table")

The `ESGAdmin` MySQL user on this machine is missing `CREATE` privilege. Fix it by running `scripts/setup-esgadmin-user.sql` as `root` — via phpMyAdmin's SQL tab (paste the file's contents into the SQL tab and click Go), or:

```powershell
C:\xampp\mysql\bin\mysql.exe -u root < scripts\setup-esgadmin-user.sql
```

Safe to re-run any time, on any machine. Then restart the app.

**`#1030 - Got error 176 "Read page with wrong checksum" from storage engine Aria`** (when running any SQL in phpMyAdmin, including `scripts/setup-esgadmin-user.sql`), or MySQL won't start at all / crashes on startup with an InnoDB assertion failure

This means MariaDB's own internal system tables (in the `mysql` database) are corrupted — it is not caused by this app or by any script you were running. It happens when MySQL is shut down improperly: closing the XAMPP window instead of clicking **Stop**, sleeping/hibernating the laptop while MySQL is running, or a crash/power loss. Once it reaches this state, table-level repair tools (e.g. `aria_chk`) are not reliable and can make it worse (including a full InnoDB crash) — reset the data directory instead:

1. Make sure MySQL is fully stopped (check Task Manager for no `mysqld.exe` process).
2. Rename the broken data folder so nothing is lost: `ren C:\xampp\mysql\data data_broken`
3. Restore XAMPP's clean template: `xcopy C:\xampp\mysql\backup C:\xampp\mysql\data /E /I`
4. Start MySQL in the XAMPP Control Panel — it should come up clean.
5. In phpMyAdmin, create the `esgdashboard` database and import `esgdashboard.sql` fresh (this already includes every table the app needs, including `assistant_questions`).
6. Run `scripts/setup-esgadmin-user.sql` as root.
7. Restart the app.

**To avoid this happening again:** always click **Stop** in the XAMPP Control Panel before closing XAMPP or shutting down/sleeping the laptop — never force-close the window while MySQL is running.

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
