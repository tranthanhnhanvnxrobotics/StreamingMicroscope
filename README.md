# DoAnTotNghiep — STM32 Motor Controller + Web Control

Hệ thống điều khiển camera 3 trục từ xa qua web, gồm firmware STM32F401CC và ứng dụng web full-stack.

## Kiến trúc tổng thể

```
[Browser] ──WebSocket──► [VPS: Backend + Frontend]
                                    │
                              Socket.io (PI_AGENT)
                                    │
                         [Raspberry Pi: Pi Agent]
                                    │
                              UART 115200 baud
                                    │
                         [STM32F401CC Firmware]
                                    │
                     ┌──────────────┴─────────────┐
               Stepper (Z Focus)         DC Motor (X/Y)
               AS5600 Encoder            Quadrature Encoder
               Endstops (Z/X/Y)
```

---

## Thành phần

| Thư mục | Vai trò |
|---|---|
| `firmware/` | Firmware C cho STM32F401CC (STM32CubeIDE) |
| `backend/` | Node.js API + Socket.io server (chạy trên VPS) |
| `frontend/` | Next.js web app (chạy trên VPS) |
| `backend/scripts/pi-agent.js` | Agent chạy trên Raspberry Pi, bridge UART ↔ Socket.io |

---

## Phần cứng (Firmware)

| Thành phần | Chi tiết |
|---|---|
| MCU | STM32F401CCUx (84 MHz) |
| RTOS | FreeRTOS (CMSIS-RTOS v2) |
| Giao tiếp host | UART2 — 115200 baud, DMA TX |
| Trục Z (Focus) | Stepper motor, microstepping ×8 |
| Trục X / Y | DC motor + encoder quadrature (TIM2, TIM4) |
| Encoder vị trí | AS5600 (I2C2) — 12-bit magnetic |
| Endstop | ENDSTOP_MIN (PB12), ENDSTOP_X (PA10), ENDSTOP_Y (PA11) |
| PWM motor | TIM3 CH1/CH2 |
| Timer điều khiển | TIM5 — 20 kHz tick |

### Homing sequence

```
Z Focus:  SEEK_MIN → BACKOFF → APPROACH_SLOW → set encoder zero
X:        seek X_MIN endstop → reset encoder X
Y:        seek Y_MIN endstop → reset encoder Y
```

---

## Giao thức UART (STM32 ↔ Pi Agent)

### Lệnh gửi xuống firmware

| Lệnh | Mô tả |
|---|---|
| `CMD:HOME_MIN` | Homing trục Z |
| `CMD:HOME_X` | Homing trục X |
| `CMD:HOME_Y` | Homing trục Y |
| `CMD:FOCUS_IN` | Focus in một bước |
| `CMD:FOCUS_OUT` | Focus out một bước |
| `CMD:GOTO:<pos>` | Di chuyển focus đến vị trí encoder |
| `CMD:MOVE_LEFT[:<duty%>]` | Di chuyển X trái |
| `CMD:MOVE_RIGHT[:<duty%>]` | Di chuyển X phải |
| `CMD:MOVE_UP[:<duty%>]` | Di chuyển Y lên |
| `CMD:MOVE_DOWN[:<duty%>]` | Di chuyển Y xuống |
| `CMD:ENC_POS` | Đọc vị trí encoder |
| `CMD:ENC_ZERO` | Đặt gốc encoder tại vị trí hiện tại |

### Phản hồi từ firmware

| Message | Ý nghĩa |
|---|---|
| `ACK:<CMD>` | Lệnh được nhận |
| `ERR:<reason>` | Lỗi |
| `HOME_STATE:STARTED\|DONE\|FAILED` | Trạng thái homing |
| `POS:<step>/<max>` | Vị trí focus |
| `ENC_POS:<val>` / `ENC_PCT:<pct>` | Encoder tuyệt đối / % |
| `XY_POS:<x>,<y>` | Vị trí X/Y |
| `ENDSTOP:MIN\|X_MIN\|Y_MIN:TRIGGERED\|RELEASED` | Endstop |
| `POS_VALID:0\|1` | Đã homed chưa |
| `MOTOR_START:<CMD>` / `MOTOR_DONE` | Trạng thái motor |
| `PING` | Heartbeat mỗi 500 ms |

---

## Build firmware

Mở project bằng **STM32CubeIDE**:

```
firmware/DoAnTotNghiep/StepMotor/
```

- Toolchain: ARM GCC (arm-none-eabi)
- Debug config: `StepMotor Debug (3).launch`
- Linker script: `STM32F401CCUX_FLASH.ld`
- Flash bằng ST-Link hoặc DFU

---

## Deploy lên VPS

### Yêu cầu

- Ubuntu 22.04+
- Node.js LTS, PM2, Nginx
- PostgreSQL (có thể chạy bằng Docker)

### 1. Cài runtime

```bash
apt update && apt install -y curl git nginx
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt install -y nodejs
npm i -g pm2
```

### 2. Clone repo

```bash
git clone <repo-url> ~/WEB
cd ~/WEB
```

### 3. Cấu hình backend

```bash
cd ~/WEB/backend
npm install
cp .env.vps.example .env
nano .env
```

Các biến bắt buộc:

```env
# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=doan
DB_USER=postgres
DB_PASSWORD=<password>

# Socket auth
SOCKET_AUTH_TOKEN=<random-secret>

# Pi Agent
PI_AGENT_ENABLED=true
PI_AGENT_TOKEN=<shared-token-voi-pi>

# Trên VPS không có UART trực tiếp
UART_ENABLED=false

FRONTEND_ORIGIN=http://<VPS-IP>
```

### 4. Cấu hình frontend

```bash
cd ~/WEB/frontend
npm install
cp .env.production.example .env.production
nano .env.production
```

```env
NEXT_PUBLIC_BACKEND_URL=http://<VPS-IP>:5000
NEXT_PUBLIC_SOCKET_TOKEN=<same-as-SOCKET_AUTH_TOKEN>
```

Build frontend:

```bash
npm run build
```

### 5. Khởi động PM2

```bash
cd ~/WEB
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root
# Chạy lệnh hiện ra sau đó
pm2 save
```

Kiểm tra trạng thái:

```bash
pm2 status
pm2 logs backend --lines 50
pm2 logs frontend --lines 50
```

### 6. Cấu hình Nginx

```bash
cp ~/WEB/deploy/nginx/webapp-ip.conf /etc/nginx/sites-available/webapp
ln -sf /etc/nginx/sites-available/webapp /etc/nginx/sites-enabled/webapp
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
```

Nginx forward:
- `http://<VPS-IP>/` → Frontend (port 3000)
- `http://<VPS-IP>/api/` → Backend (port 5000)
- `http://<VPS-IP>/socket.io/` → Socket.io (port 5000)

### 7. Database (Docker)

Nếu chưa có PostgreSQL, chạy bằng Docker:

```bash
cd ~/WEB
docker compose up -d database
```

### Kiểm tra nhanh

```bash
curl -s http://127.0.0.1:5000/health
curl -I http://127.0.0.1:3000
```

### Cập nhật code

```bash
cd ~/WEB
git pull
cd backend && npm install
cd ../frontend && npm install && npm run build
pm2 restart all
```

---

## Deploy Pi Agent lên Raspberry Pi

Pi Agent là bridge giữa STM32 (UART) và VPS backend (Socket.io). Chạy trên Raspberry Pi đặt gần STM32.

### Yêu cầu

- Raspberry Pi (bất kỳ model nào có UART)
- Node.js LTS
- Cáp USB-UART hoặc kết nối GPIO UART đến STM32
- Kết nối internet đến VPS

### 1. Clone repo lên Pi

```bash
git clone <repo-url> ~/WEB
cd ~/WEB/backend
npm install
```

### 2. Cấu hình Pi Agent

```bash
cp .env.pi-agent.example .env.pi-agent
nano .env.pi-agent
```

```env
# URL của VPS backend
PI_AGENT_SERVER_URL=http://<VPS-IP>:5000

# Token phải khớp với PI_AGENT_TOKEN trên VPS
PI_AGENT_TOKEN=<shared-token>

PI_AGENT_NAME=pi-agent

# UART kết nối đến STM32
PI_UART_ENABLED=true
PI_UART_PORT=/dev/serial0      # hoặc /dev/ttyUSB0 nếu dùng USB-UART
PI_UART_BAUD_RATE=115200
```

Kiểm tra cổng UART:

```bash
ls /dev/serial* /dev/ttyUSB* /dev/ttyAMA* 2>/dev/null
```

Nếu dùng GPIO UART trên Pi, bật trong `raspi-config`:

```bash
sudo raspi-config
# Interface Options → Serial Port → Login shell: No → Serial hardware: Yes
```

### 3. Chạy thử Pi Agent

```bash
cd ~/WEB/backend
export $(grep -v '^#' .env.pi-agent | xargs)
node scripts/pi-agent.js
```

Kết quả mong đợi:

```
[PI-AGENT] UART ready
[PI-AGENT] Connected to http://<VPS-IP>:5000
```

### 4. Chạy tự động khi Pi khởi động (PM2)

```bash
npm i -g pm2

pm2 start scripts/pi-agent.js \
  --name pi-agent \
  --env-file /root/WEB/backend/.env.pi-agent

pm2 save
pm2 startup systemd -u root --hp /root
# Chạy lệnh hiện ra
pm2 save
```

Kiểm tra:

```bash
pm2 status
pm2 logs pi-agent --lines 50
```

### 5. Troubleshoot UART

```bash
# Test đọc UART thô
stty -F /dev/serial0 115200 raw && cat /dev/serial0

# Test gửi lệnh
echo "CMD:FOCUS_POS" > /dev/serial0

# Kiểm tra quyền truy cập
sudo usermod -aG dialout $USER
```

---

## Ops & Monitoring

```bash
# VPS
pm2 status
pm2 logs backend --lines 100
pm2 restart backend frontend

# Pi
pm2 logs pi-agent --lines 100
pm2 restart pi-agent

# Health check
curl -s http://<VPS-IP>/api/health
```

---

## Biến môi trường tổng hợp

| Biến | Chạy ở | Mô tả |
|---|---|---|
| `SOCKET_AUTH_TOKEN` | VPS | Token xác thực frontend ↔ backend |
| `PI_AGENT_ENABLED` | VPS | Bật chế độ nhận Pi Agent |
| `PI_AGENT_TOKEN` | VPS + Pi | Token chung VPS–Pi |
| `UART_ENABLED` | VPS | Tắt (`false`) vì VPS không nối UART |
| `PI_AGENT_SERVER_URL` | Pi | URL của VPS backend |
| `PI_UART_PORT` | Pi | Cổng UART đến STM32 (vd. `/dev/serial0`) |
| `FRONTEND_ORIGIN` | VPS | CORS origin của frontend |
| `NEXT_PUBLIC_BACKEND_URL` | Frontend | URL API backend |
| `NEXT_PUBLIC_SOCKET_TOKEN` | Frontend | Token Socket.io |
