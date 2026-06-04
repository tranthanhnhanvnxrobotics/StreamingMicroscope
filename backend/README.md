# Backend

## Scripts

- `npm run dev` – start the backend with auto-reload
- `npm start` – start the backend
- `npm run db:check` – verify DB connectivity
- `npm run items:smoke` – basic DB CRUD smoke test
- `npm run uart:send -- <command>` – send one UART command manually (e.g. `left`, `right`, `stop`)
- `npm run uart:focus-calib -- --mode test1 --count 100 --delay 140` – Test 1: send fixed focus clicks
- `npm run uart:focus-calib -- --mode test2 --delay 140` – Test 2: continuous focus clicks, press `Q` to stop and get total clicks
- `npm run pi:agent` – run lightweight Raspberry Pi UART agent

## Health checks

- `GET /health` – backend is running
- `GET /health/db` – backend can connect to DB
- `GET /items` – list items
- `GET /items/:id` – get item
- `POST /items` – create item `{ "name": "..." }`
- `PUT /items/:id` – update item `{ "name": "..." }`
- `DELETE /items/:id` – delete item

## Environment

Expected variables (provided by `docker-compose.yml`):

- `PORT`
- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `DB_PORT` (optional)
- `DB_RETRY_COUNT` (optional, default 10)
- `DB_RETRY_DELAY_MS` (optional, default 2000)
- `FRONTEND_ORIGIN` (optional, comma-separated; default `http://localhost:3000`)
- `SOCKET_AUTH_TOKEN` (optional, required token for socket connection)
- `CONTROL_ENABLED` (optional, `false` to disable control channel)
- `CONTROL_FOCUS_ONLY` (optional, default `false`; set `true` to allow only `focus_in`, `focus_out`, `stop`, `goto`)
- `REQUIRE_HTTPS` (optional, `true` to enforce HTTPS/WSS)
- `UART_ENABLED` (optional, `true` to forward commands to UART)
- `UART_PORT` (optional, default `/dev/serial0`)
- `UART_BAUD_RATE` (optional, default `115200`)
- `UART_WRITE_TIMEOUT_MS` (optional, default `200`)
- `UART_WATCHDOG_ENABLED` (optional, `true` to enable ping watchdog)
- `UART_WATCHDOG_INTERVAL_MS` (optional, default `1500`)
- `PI_AGENT_ENABLED` (optional, `true` to accept Pi agent connection)
- `PI_AGENT_TOKEN` (optional, required token for Pi agent socket auth)
- `PI_AGENT_ACK_TIMEOUT_MS` (optional, default `1800`)

Pi agent variables (on Raspberry Pi):

- `PI_AGENT_SERVER_URL` (required, VPS socket endpoint, e.g. `http://103.124.94.194`)
- `PI_AGENT_TOKEN` (required, must match backend)
- `PI_AGENT_NAME` (optional)
- `PI_UART_ENABLED` (optional, default `true`)
- `PI_UART_PORT` (optional, default `/dev/serial0`)
- `PI_UART_BAUD_RATE` (optional, default `115200`)
- `PI_UART_ACK_TIMEOUT_MS` (optional, default `800`)
- `PI_AGENT_FOCUS_ONLY` (optional, default `false`; when `true`, only `focus_in`, `focus_out`, `stop` are forwarded)

## Control channel behavior

- `control_motor` now supports payload `{ command, mode }` and ACK callback (`accepted` / `rejected`).
- Backend emits `control_status` events for client status and executed command updates.
- If UART is enabled, backend forwards supported commands over serial as line-delimited protocol:
	- `CMD:MOVE_LEFT:<timestamp>`
	- `CMD:MOVE_RIGHT:<timestamp>`
	- `CMD:MOVE_UP:<timestamp>`
	- `CMD:MOVE_DOWN:<timestamp>`
	- `CMD:FOCUS_IN:<timestamp>`
	- `CMD:FOCUS_OUT:<timestamp>`
	- `CMD:STOP:<timestamp>`
- Backend relays UART feedback lines to clients as transport status messages.
- On socket disconnect, backend triggers a failsafe `stop` state internally.
- Frontend does not need code changes for Pi-agent mode; transport stays behind backend socket API.
