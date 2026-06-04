# Pion WHIP Publisher (Pi 4, low-latency)

This publisher keeps WebRTC end-to-end **without `whipclientsink`**.

Pipeline:
- GStreamer captures USB camera and encodes H264 to RTP/UDP (localhost)
- Go (`pion/webrtc`) reads RTP and publishes to MediaMTX WHIP
- Frontend receives via WHEP as before

## 1) Install dependencies on Raspberry Pi

```bash
sudo apt update
sudo apt install -y \
  golang-go \
  gstreamer1.0-tools \
  gstreamer1.0-plugins-base \
  gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad \
  gstreamer1.0-libav \
  v4l-utils
```

## 2) Prepare project

```bash
cd ~/Project/local_env
cp -r /path/to/deploy/pi/pion-whip-publisher ./pion-whip-publisher
cd pion-whip-publisher
chmod +x run_pion_whip.sh
```

## 3) Run publisher (default)

```bash
WHIP_URL="http://103.124.94.194:8889/cam1/whip" ./run_pion_whip.sh
```

## 4) Tuned launch for microscope camera (MU100-WU)

```bash
WHIP_URL="http://103.124.94.194:8889/cam1/whip" \
WIDTH=1280 HEIGHT=720 FPS=15 BITRATE_KBPS=1800 PRESET_CAMERA=1 \
./run_pion_whip.sh
```

## 4.1) If image is a bit dark (recommended first profile)

```bash
WHIP_URL="http://103.124.94.194:8889/cam1/whip" \
WIDTH=1280 HEIGHT=720 FPS=15 BITRATE_KBPS=1800 PRESET_CAMERA=1 \
AUTO_EXPOSURE=3 BRIGHTNESS=0.10 CONTRAST=1.02 SATURATION=1.05 \
./run_pion_whip.sh
```

Notes:
- `AUTO_EXPOSURE=3` keeps camera auto-exposure active (usually brighter than manual mode).
- `BRIGHTNESS/CONTRAST/SATURATION` are `videobalance` post-process controls.
- If still dark, add sensor gain/exposure manually:
  - `GAIN=120`
  - `EXPOSURE_ABSOLUTE=250`
- Increase these gradually to avoid noise/motion blur.

## 4.3) Microscope contrast profile (white pop, dark background, sharp red)

For microscope / wafer inspection where you want bright white structures, darker background, and sharper red details:

```bash
WHIP_URL="http://103.124.94.194:8889/cam1/whip" \
WIDTH=1280 HEIGHT=720 FPS=15 BITRATE_KBPS=4500 PRESET_CAMERA=1 \
IMAGE_ENHANCE=1 \
BRIGHTNESS=0.14 CONTRAST=1.22 SATURATION=1.18 HUE=0.03 GAMMA=0.90 \
SHARPEN=0.65 SHARPEN_SIGMA=0.5 SHARPNESS=8 GAIN=100 \
./run_pion_whip.sh
```

What each control does:
- `IMAGE_ENHANCE=1` forces `reencode` pipeline so software filters apply (direct H264 bypasses them).
- `GAMMA=0.90` darkens deep shadows (background) before tone mapping.
- `BRIGHTNESS/CONTRAST` lift white chip structures and increase overall separation.
- `SATURATION/HUE` make red annotation marks more vivid.
- `SHARPEN/SHARPEN_SIGMA` sharpen fine edges (lower sigma = finer detail).
- `GAIN` boosts sensor exposure if the scene is still too dark.

Tune gradually:
- Still too dark: raise `GAIN` (120-160) or `BRIGHTNESS` (0.16).
- Whites blown out: lower `BRIGHTNESS` or raise `GAMMA` toward 0.95.
- Background not dark enough: lower `GAMMA` (0.85) or raise `CONTRAST` (1.28).
- Red too strong: lower `SATURATION` (1.10) or set `HUE=0`.
- Too much noise after sharpen: lower `SHARPEN` (0.45) or `SHARPNESS` (6).

PM2 users: restart after updating `ecosystem.pi.config.cjs`:

```bash
pm2 restart pion-whip-publisher
pm2 logs pion-whip-publisher --lines 50
```

## 4.2) Direct H264 from camera (lower CPU + lower latency)

If your USB camera supports H264 output, use:

```bash
WHIP_URL="http://103.124.94.194:8889/cam1/whip" \
VIDEO_PIPELINE=direct WIDTH=1280 HEIGHT=720 FPS=15 BITRATE_KBPS=1800 \
PRESET_CAMERA=1 AUTO_EXPOSURE=3 H264_I_FRAME_PERIOD=15 \
./run_pion_whip.sh
```

Or keep automatic selection:

```bash
VIDEO_PIPELINE=auto ./run_pion_whip.sh
```

`auto` behavior:
- If camera advertises H264 -> use `direct`
- Otherwise -> fallback to `reencode` (MJPEG decode + x264)

Impact of `direct` mode:
- Pros: lower CPU and usually lower end-to-end latency.
- Pros: no software re-encode loss (quality can be very good if camera encoder is decent).
- Cons: software `videobalance` brightness/contrast/saturation is bypassed.
- Cons: final quality depends on camera hardware encoder and V4L2 controls support.

To keep quality while staying low-latency in `direct` mode:
- Keep `BITRATE_KBPS` high enough (`1800-3000` for 720p15).
- Keep short GOP with `H264_I_FRAME_PERIOD=FPS`.
- Prefer camera-side exposure/gain tuning (`AUTO_EXPOSURE`, `GAIN`, `EXPOSURE_ABSOLUTE`).
- Current script already forces periodic codec config (`h264parse/rtph264pay config-interval=1`) to reduce WebRTC "waiting tracks" timeout risk on MediaMTX.

## 5) Optional auth token

```bash
WHIP_URL="http://103.124.94.194:8889/cam1/whip" \
WHIP_AUTH_TOKEN="your_token" \
./run_pion_whip.sh
```

## 6) Verify on frontend

Check your `WEBRTC LIVE` overlay:
- `Jitter Buffer` should stay much lower than Python `aiortc` path
- `FPS` should approach sender FPS (15)
- `Dropped/Freeze` should rise slower

## 7) Troubleshooting

- `go run .` fails with missing modules:
  - run `go mod tidy`
- Camera busy (`/dev/video0`):
  - stop other apps using camera
- WHIP non-201 response:
  - check `WHIP_URL`, MediaMTX path, and firewall
- Still high jitter buffer:
  - lower bitrate: `BITRATE_KBPS=1400`
  - keep `FPS=15`
  - ensure stable network path between viewer and server

- MediaMTX closes WHIP with `deadline exceeded while waiting tracks`:
  - increase `webrtcTrackGatherTimeout` in `mediamtx.yml` (recommended `8s` to `15s`, not `2s`)
  - keep `webrtcHandshakeTimeout` at least `10s` (recommended `15s`)
  - the publisher now waits for first RTP packet before creating WHIP session (`FIRST_RTP_TIMEOUT`, default `12s`)

## 8) Run with PM2 on Raspberry Pi

Install PM2 (if missing):

```bash
sudo npm install -g pm2
```

Start service using the included PM2 config:

```bash
cd ~/Project/local_env/pion-whip-publisher
pm2 start ecosystem.pi.config.cjs
pm2 status
```

The runner now supports optimized defaults for PM2:
- `PION_RUN_MODE=binary` (default): build then run local binary (faster restarts vs `go run`)
- `GO_MOD_DOWNLOAD=0` (default): skip module download on each start
- `KEYINT_FRAMES=FPS` (default): shorter GOP for realtime recovery
- `x264enc` low-latency options: `rc-lookahead=0`, `sync-lookahead=0`, `sliced-threads=true`

Save process list and enable auto-start after reboot:

```bash
pm2 save
pm2 startup
```

Then run the command printed by `pm2 startup` (with sudo), and save again:

```bash
pm2 save
```

Useful operations:

```bash
pm2 logs pion-whip-publisher --lines 100
pm2 restart pion-whip-publisher
pm2 stop pion-whip-publisher
pm2 delete pion-whip-publisher
```
