# Windows installation fix: `better-sqlite3` / `node-gyp`

## Why the earlier install failed

The previous package range resolved `better-sqlite3` 11.x. That release line does not provide a matching prebuilt binary for Node.js 24, so npm fell back to compiling native code. The local Visual Studio Build Tools installation does not have a compatible C++ toolset, causing `node-gyp` to fail. The deprecation and cleanup warnings are secondary; the native-build failure is the blocker.

## What changed in this package

- `better-sqlite3` is now set to `^12.10.0`, which has prebuilt Windows x64 binaries for Node.js 24.
- The Node engine minimum is updated to `>=22.15.0` to align with the supported prebuilt runtime line.
- `.nvmrc` selects Node 24.

The SQLite API used by this project remains the same for its current database operations.

## Clean reinstall (PowerShell)

Run these commands from the folder that contains `package.json`. Stop the development server and close other terminals running this project first.

```powershell
node -v
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force .\node_modules -ErrorAction SilentlyContinue
Remove-Item -Force .\package-lock.json -ErrorAction SilentlyContinue
npm cache verify
npm install
```

If `node_modules` is still locked (`EPERM`), close VS Code and File Explorer windows that have a terminal or process in the project folder, then retry. Keep `.env` and `data` intact. The clean install will create a new lockfile for the updated dependency versions.

Then run:

```powershell
npm test
npm run typecheck
npm run build
npm run dev
```

Open `http://localhost:5173`.

If it still fails, send the new first `npm error` section and the `better-sqlite3` version shown in the output. Do not install Visual Studio C++ Build Tools unless a later package genuinely requires a source build.
