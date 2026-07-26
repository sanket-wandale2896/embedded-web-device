# Embedded Web Device Demo 1

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
