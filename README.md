# DoAnTotNghiep — STM32 Motor Controller Firmware

Firmware cho STM32F401CC điều khiển hệ thống 3 trục: **Focus (Z)**, **X**, **Y** — dùng trong dự án tốt nghiệp.

## Tổng quan phần cứng

| Thành phần | Chi tiết |
|---|---|
| MCU | STM32F401CCUx (84 MHz) |
| RTOS | FreeRTOS (CMSIS-RTOS v2) |
| Giao tiếp host | UART2 — 115200 baud, DMA TX |
| Trục Z (Focus) | Stepper motor, driver microstepping ×8 |
| Trục X / Y | DC motor với encoder quadrature (TIM2, TIM4) |
| Encoder vị trí | AS5600 (I2C2) — 12-bit magnetic, dùng cho Z |
| Endstop | ENDSTOP_MIN (PB12), ENDSTOP_X (PA10), ENDSTOP_Y (PA11) |
| PWM motor | TIM3 CH1/CH2 — 10 kHz |
| Timer điều khiển | TIM5 — 20 kHz tick interrupt |
| Encoder Y | TIM1 quadrature mode |

## Cấu trúc thư mục

```
firmware/DoAnTotNghiep/StepMotor/
├── Core/
│   ├── Inc/          # main.h, FreeRTOSConfig.h
│   ├── Src/          # main.c, freertos.c, stm32f4xx_it.c
│   └── App/
│       └── app_control/   # Logic ứng dụng chính
├── Drivers/
│   ├── CMSIS/
│   └── STM32F4xx_HAL_Driver/
└── Middlewares/
    └── Third_Party/FreeRTOS/
```

## Giao thức UART

Host (Node.js hoặc PC) gửi lệnh dạng text, firmware trả lời dạng text.

### Lệnh gửi lên firmware

| Lệnh | Mô tả |
|---|---|
| `CMD:HOME_MIN` | Tự động homing trục Z (Focus) |
| `CMD:HOME_X` | Homing trục X |
| `CMD:HOME_Y` | Homing trục Y |
| `CMD:FOCUS_IN` | Focus in một bước |
| `CMD:FOCUS_OUT` | Focus out một bước |
| `CMD:FOCUS_POS` | Truy vấn vị trí focus hiện tại |
| `CMD:FOCUS_ZERO` | Reset vị trí focus về 0 |
| `CMD:GOTO:<pos>` | Di chuyển focus đến vị trí encoder cụ thể |
| `CMD:MOVE_LEFT[:<duty%>]` | Di chuyển trục X sang trái |
| `CMD:MOVE_RIGHT[:<duty%>]` | Di chuyển trục X sang phải |
| `CMD:MOVE_UP[:<duty%>]` | Di chuyển trục Y lên |
| `CMD:MOVE_DOWN[:<duty%>]` | Di chuyển trục Y xuống |
| `CMD:ENC_RAW` | Đọc góc thô AS5600 |
| `CMD:ENC_POS` | Đọc vị trí encoder (tuyệt đối, đã hiệu chỉnh) |
| `CMD:ENC_ZERO` | Đặt vị trí hiện tại làm gốc encoder |

### Phản hồi từ firmware

| Message | Ý nghĩa |
|---|---|
| `ACK:<CMD>` | Lệnh được nhận |
| `ERR:<reason>` | Lỗi |
| `HOME_STATE:STARTED\|DONE\|FAILED` | Trạng thái homing |
| `POS:<step>/<max>` | Vị trí focus (step) |
| `ENC_POS:<val>` | Vị trí encoder tuyệt đối |
| `ENC_PCT:<0-100>` | Vị trí encoder theo % |
| `ENC_RAW:<val>` | Góc thô AS5600 |
| `XY_POS:<x>,<y>` | Vị trí X/Y encoder |
| `ENDSTOP:MIN\|X_MIN\|Y_MIN:TRIGGERED\|RELEASED` | Trạng thái endstop |
| `POS_VALID:0\|1` | Hệ thống đã homed chưa |
| `MOTOR_START:<CMD>` | Motor bắt đầu chạy |
| `MOTOR_DONE` | Motor dừng |
| `MOTOR_DONE:FOCUS_IN\|FOCUS_OUT` | Focus move hoàn tất |
| `PING` | Heartbeat mỗi 500 ms |

## Luồng khởi động

1. **FreeRTOS khởi động** → 2 task: `defaultTask` (idle) và `controlTask`
2. `controlTask` gọi `AppControl_Init()` → khởi tạo UART, timer, encoder, DC motor
3. `AppControl_Start()` → bắt đầu nhận UART, bật TIM5 interrupt
4. Host gửi `CMD:HOME_MIN` để bắt đầu chuỗi homing: **Z → X → Y**
5. Sau khi `HOME_STATE:DONE`, hệ thống sẵn sàng nhận lệnh di chuyển

## Homing sequence

```
Z Focus:  SEEK_MIN → BACKOFF → APPROACH_SLOW → set encoder zero
X:        seek X_MIN endstop → reset encoder X
Y:        seek Y_MIN endstop → reset encoder Y
```

## Build

Project được tạo bằng **STM32CubeIDE**. Mở file `.cproject` trong thư mục `StepMotor/` để build.

- Toolchain: ARM GCC (arm-none-eabi)
- Debug config: `StepMotor Debug (3).launch`
- Linker script: `STM32F401CCUX_FLASH.ld`

## Cấu hình nhanh

Các hằng số quan trọng trong `app_control.c`:

```c
#define APP_FOCUS_POS_MAX_SAFE     420       // Giới hạn max bước focus
#define APP_ENCODER_POS_MAX_CALIB  17480     // Giới hạn encoder AS5600
#define APP_HOME_FAST_STEP_HZ      220       // Tốc độ homing nhanh
#define APP_HOME_SLOW_STEP_HZ      120       // Tốc độ homing chậm
#define APP_XY_PWM_DUTY_PERCENT    32        // Duty mặc định X/Y
#define APP_XY_KICK_DUTY_PERCENT   88        // Duty kick khởi động
#define APP_X_MAX_COUNTS           (-7000)   // Giới hạn X (encoder counts)
#define APP_Y_MAX_COUNTS           10000     // Giới hạn Y (encoder counts)
```
