# Embedded Web Device Demo

This project simulates an embedded flow transmitter with a separate Express backend and Vue 3 frontend.

## Project structure

- `server/` - Express API and device simulator
- `frontend/` - Vue 3 + Vite + TypeScript user interface

## Stack

- Node.js
- Express
- Vue 3
- Vite
- TypeScript

## Run locally

1. Install all workspace dependencies:
   - `npm install`
2. Start backend and frontend together:
   - `npm run dev`
3. Open browser:
   - `http://localhost:5173`
4. Login:
   - Service: `service / service123`
   - Admin: `admin / admin123`
   - User: `user / user123`

## Access from mobile on same Wi-Fi

1. Find your PC LAN IP (Windows PowerShell):
   - `Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -eq 'Wi-Fi' } | Select-Object IPAddress`
2. Open the frontend from your phone:
   - `http://<your-pc-ip>:5173`
3. If your mobile client app calls the API directly, use:
   - `http://<your-pc-ip>:8080`
   - Do not use `localhost` or `127.0.0.1` on the phone.
4. Verify backend health from another device:
   - `http://<your-pc-ip>:8080/health`
5. If it still fails, allow inbound TCP `5173` and `8080` in Windows Firewall.

### Optional CORS restriction

By default, the backend now allows cross-origin requests for development. To restrict CORS to known origins, set `CORS_ORIGIN` before starting the server:

- PowerShell example:
  - `$env:CORS_ORIGIN='http://192.168.31.209:5173,http://192.168.31.50'`
  - `npm run dev:server`

## Useful scripts

- `npm run dev` - start backend and frontend together
- `npm run dev:server` - start only the Express API
- `npm run dev:frontend` - start only the Vite frontend
- `npm run build` - build the frontend
- `npm start` - start only the backend server

## API endpoints

- `POST /api/login`
- `GET /api/device/telemetry`
- `GET /api/device/config`
- `POST /api/device/config`
- `GET /api/users` (service role only)
- `POST /api/users` (service role only, can create admin/user logins)
- `GET /health`

## Start all 3 processes (backend + frontend + cloudflare)

Run all commands from the project root folder.

1. Terminal 1: start backend (Express on 8080)
   - `npm run start --workspace server`

2. Terminal 2: start frontend (Vite on 5173)
   - `npm run dev --workspace frontend`

3. Terminal 3: start Cloudflare tunnel to frontend
   - `"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:5173`
   - Copy the generated `https://...trycloudflare.com` URL and open it in browser.

4. Verify everything is running
   - Frontend local: `http://localhost:5173`
   - Backend health: `http://localhost:8080/health`
   - Public tunnel URL: `https://...trycloudflare.com`

## Stop all 3 processes

Preferred method:

1. In Terminal 3 (cloudflared), press `Ctrl + C`.
2. In Terminal 2 (frontend), press `Ctrl + C`.
3. In Terminal 1 (backend), press `Ctrl + C`.

Fallback method from any PowerShell terminal:

1. Stop frontend on 5173
   - `$frontPids = Get-NetTCPConnection -State Listen -LocalPort 5173 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`
   - `if ($frontPids) { $frontPids | ForEach-Object { Stop-Process -Id $_ -Force } }`

2. Stop backend on 8080
   - `$backPids = Get-NetTCPConnection -State Listen -LocalPort 8080 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`
   - `if ($backPids) { $backPids | ForEach-Object { Stop-Process -Id $_ -Force } }`

3. Stop cloudflared
   - `Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force`

4. Verify all are stopped
   - `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 5173, 8080 }`
   - `Get-Process cloudflared -ErrorAction SilentlyContinue`
