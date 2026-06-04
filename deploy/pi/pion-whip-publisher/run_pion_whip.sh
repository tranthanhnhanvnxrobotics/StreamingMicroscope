#!/usr/bin/env bash
set -euo pipefail

# One-command runner:
# 1) Starts Pion WHIP publisher (Go)
# 2) Feeds RTP/H264 from USB camera via GStreamer into local UDP port
#
# Usage:
#   chmod +x ./run_pion_whip.sh
#   WHIP_URL="http://103.124.94.194:8889/cam1/whip" ./run_pion_whip.sh
#
# Optional env vars:
#   DEVICE=/dev/video0
#   WIDTH=1280
#   HEIGHT=720
#   FPS=15
#   BITRATE_KBPS=4500
#   WHIP_URL=http://103.124.94.194:8889/cam1/whip
#   WHIP_AUTH_TOKEN=
#   RTP_LISTEN_ADDR=127.0.0.1:5004
#   FIRST_RTP_TIMEOUT=12s
#   PRESET_CAMERA=1
#   VIDEO_PIPELINE=auto   # auto|direct|reencode
#   AUTO_EXPOSURE=3
#   EXPOSURE_ABSOLUTE=
#   GAIN=
#   H264_I_FRAME_PERIOD=
#   H264_PROFILE=
#   H264_LEVEL=
#   H264_REPEAT_SEQUENCE_HEADER=1
#   IMAGE_ENHANCE=1     # Force reencode so videobalance/gamma/sharpen apply (auto direct H264 skips them)
#   BRIGHTNESS=0.14     # Lift white structures (videobalance, -1..1)
#   CONTRAST=1.22       # Bright whites + darker background (0..2)
#   SATURATION=1.18     # Boost red annotation/details (0..2)
#   HUE=0.03            # Slight red shift (-1..1, 0=off)
#   GAMMA=0.90          # Crush dark background before balance (0=off, 0.85-0.95 recommended)
#   KEYINT_FRAMES=15
#   X264_SPEED_PRESET=veryfast
#   X264_THREADS=2
#   SHARPEN=0.65        # Software unsharp mask (0=off, 0.3-0.8 recommended)
#   SHARPEN_SIGMA=0.5   # Unsharp mask radius (lower = finer red/edge detail)
#   SHARPNESS=8         # Camera hardware sharpness via v4l2-ctl (0-10)
#   GO_MOD_DOWNLOAD=0
#   PION_RUN_MODE=binary
#   LOG_RTP=0

DEVICE="${DEVICE:-/dev/video0}"
WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-720}"
FPS="${FPS:-15}"
BITRATE_KBPS="${BITRATE_KBPS:-4500}"
WHIP_URL="${WHIP_URL:-http://103.124.94.194:8889/cam1/whip}"
WHIP_AUTH_TOKEN="${WHIP_AUTH_TOKEN:-}"
RTP_LISTEN_ADDR="${RTP_LISTEN_ADDR:-127.0.0.1:5004}"
FIRST_RTP_TIMEOUT="${FIRST_RTP_TIMEOUT:-12s}"
PRESET_CAMERA="${PRESET_CAMERA:-1}"
VIDEO_PIPELINE="${VIDEO_PIPELINE:-auto}"
AUTO_EXPOSURE="${AUTO_EXPOSURE:-3}"
EXPOSURE_ABSOLUTE="${EXPOSURE_ABSOLUTE:-}"
GAIN="${GAIN:-}"
H264_I_FRAME_PERIOD="${H264_I_FRAME_PERIOD:-${FPS}}"
H264_PROFILE="${H264_PROFILE:-}"
H264_LEVEL="${H264_LEVEL:-}"
H264_REPEAT_SEQUENCE_HEADER="${H264_REPEAT_SEQUENCE_HEADER:-1}"
IMAGE_ENHANCE="${IMAGE_ENHANCE:-1}"
BRIGHTNESS="${BRIGHTNESS:-0.14}"
CONTRAST="${CONTRAST:-1.22}"
SATURATION="${SATURATION:-1.18}"
HUE="${HUE:-0.03}"
GAMMA="${GAMMA:-0.90}"
KEYINT_FRAMES="${KEYINT_FRAMES:-${FPS}}"
X264_SPEED_PRESET="${X264_SPEED_PRESET:-veryfast}"
X264_THREADS="${X264_THREADS:-2}"
SHARPEN="${SHARPEN:-0.65}"
SHARPEN_SIGMA="${SHARPEN_SIGMA:-0.5}"
SHARPNESS="${SHARPNESS:-8}"
GO_MOD_DOWNLOAD="${GO_MOD_DOWNLOAD:-0}"
PION_RUN_MODE="${PION_RUN_MODE:-binary}"
LOG_RTP="${LOG_RTP:-0}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "${SCRIPT_DIR}"

if ! command -v go >/dev/null 2>&1; then
  echo "[ERR] go not found"
  exit 1
fi

if ! command -v gst-launch-1.0 >/dev/null 2>&1; then
  echo "[ERR] gst-launch-1.0 not found"
  exit 1
fi

if ! command -v gst-inspect-1.0 >/dev/null 2>&1; then
  echo "[ERR] gst-inspect-1.0 not found"
  exit 1
fi

if [[ ! -f "go.mod" ]]; then
  echo "[ERR] go.mod not found in ${SCRIPT_DIR}"
  exit 1
fi

if [[ ! -f "go.sum" ]]; then
  echo "[INFO] go.sum missing -> generating module lock file"
  go mod tidy
fi

if [[ "${GO_MOD_DOWNLOAD}" == "1" ]]; then
  echo "[INFO] Downloading Go modules"
  go mod download
fi

for element in v4l2src h264parse rtph264pay udpsink queue; do
  if ! gst-inspect-1.0 "${element}" >/dev/null 2>&1; then
    echo "[ERR] Missing GStreamer element: ${element}"
    exit 2
  fi
done

CAMERA_HAS_H264=0
if command -v v4l2-ctl >/dev/null 2>&1; then
  if v4l2-ctl -d "${DEVICE}" --list-formats-ext 2>/dev/null | grep -Eiq 'H264|H\.264'; then
    CAMERA_HAS_H264=1
  fi
fi

PIPELINE_MODE="${VIDEO_PIPELINE}"
case "${VIDEO_PIPELINE}" in
  auto)
    if [[ "${IMAGE_ENHANCE}" == "1" ]]; then
      PIPELINE_MODE="reencode"
    elif [[ "${CAMERA_HAS_H264}" == "1" ]]; then
      PIPELINE_MODE="direct"
    else
      PIPELINE_MODE="reencode"
    fi
    ;;
  direct|reencode)
    ;;
  *)
    echo "[ERR] Invalid VIDEO_PIPELINE=${VIDEO_PIPELINE}, expected: auto|direct|reencode"
    exit 2
    ;;
esac

if [[ "${PIPELINE_MODE}" == "direct" ]] && [[ "${CAMERA_HAS_H264}" != "1" ]]; then
  echo "[WARN] Camera does not advertise H264. Falling back to reencode pipeline."
  PIPELINE_MODE="reencode"
fi

if [[ "${PIPELINE_MODE}" == "reencode" ]]; then
  for element in jpegdec videoconvert videobalance x264enc; do
    if ! gst-inspect-1.0 "${element}" >/dev/null 2>&1; then
      echo "[ERR] Missing GStreamer element: ${element}"
      exit 2
    fi
  done
  if [[ "${GAMMA}" != "0" ]] && ! gst-inspect-1.0 gamma >/dev/null 2>&1; then
    echo "[WARN] GStreamer element 'gamma' not found; GAMMA=${GAMMA} will be ignored"
    GAMMA="0"
  fi
fi

if [[ "${PRESET_CAMERA}" == "1" ]] && command -v v4l2-ctl >/dev/null 2>&1; then
  echo "[INFO] Applying camera preset on ${DEVICE}"
  if [[ "${PIPELINE_MODE}" == "direct" ]]; then
    v4l2-ctl -d "${DEVICE}" --set-fmt-video=width="${WIDTH}",height="${HEIGHT}",pixelformat=H264 || true
  else
    v4l2-ctl -d "${DEVICE}" --set-fmt-video=width="${WIDTH}",height="${HEIGHT}",pixelformat=MJPG || true
  fi
  v4l2-ctl -d "${DEVICE}" --set-parm="${FPS}" || true
  v4l2-ctl -d "${DEVICE}" --set-ctrl=auto_exposure="${AUTO_EXPOSURE}" || true
  v4l2-ctl -d "${DEVICE}" --set-ctrl=exposure_dynamic_framerate=0 || true
  if [[ -n "${EXPOSURE_ABSOLUTE}" ]]; then
    v4l2-ctl -d "${DEVICE}" --set-ctrl=exposure_absolute="${EXPOSURE_ABSOLUTE}" || true
  fi
  if [[ -n "${GAIN}" ]]; then
    v4l2-ctl -d "${DEVICE}" --set-ctrl=gain="${GAIN}" || true
  fi
  if [[ -n "${H264_I_FRAME_PERIOD}" ]]; then
    v4l2-ctl -d "${DEVICE}" --set-ctrl=h264_i_frame_period="${H264_I_FRAME_PERIOD}" || true
  fi
  if [[ -n "${H264_PROFILE}" ]]; then
    v4l2-ctl -d "${DEVICE}" --set-ctrl=h264_profile="${H264_PROFILE}" || true
  fi
  if [[ -n "${H264_LEVEL}" ]]; then
    v4l2-ctl -d "${DEVICE}" --set-ctrl=h264_level="${H264_LEVEL}" || true
  fi
  v4l2-ctl -d "${DEVICE}" --set-ctrl=h264_repeat_seq_header="${H264_REPEAT_SEQUENCE_HEADER}" || true
  v4l2-ctl -d "${DEVICE}" --set-ctrl=video_bitrate_mode=1 || true
  v4l2-ctl -d "${DEVICE}" --set-ctrl=video_bitrate="$((BITRATE_KBPS*1000))" || true
  v4l2-ctl -d "${DEVICE}" --set-ctrl=sharpness="${SHARPNESS}" || true
fi

HOST="${RTP_LISTEN_ADDR%:*}"
PORT="${RTP_LISTEN_ADDR##*:}"

# Build optional image-enhancement elements (reencode pipeline only)
GAMMA_ELEMENT=""
if [[ "${PIPELINE_MODE}" == "reencode" ]] && [[ "${GAMMA}" != "0" ]]; then
  GAMMA_ELEMENT="gamma gamma=${GAMMA}"
  echo "[INFO] Background crush: gamma=${GAMMA}"
fi

SHARPEN_ELEMENT=""
if [[ "${PIPELINE_MODE}" == "reencode" ]] && [[ "${SHARPEN}" != "0" ]] && gst-inspect-1.0 unsharpenmask >/dev/null 2>&1; then
  SHARPEN_ELEMENT="unsharpenmask sigma=${SHARPEN_SIGMA} amount=${SHARPEN} threshold=0"
  echo "[INFO] Software sharpening: unsharpenmask sigma=${SHARPEN_SIGMA} amount=${SHARPEN}"
elif [[ "${PIPELINE_MODE}" == "reencode" ]]; then
  echo "[INFO] Software sharpening: disabled (unsharpenmask not available or SHARPEN=0)"
fi

HUE_ARG=""
if [[ "${PIPELINE_MODE}" == "reencode" ]] && [[ "${HUE}" != "0" ]]; then
  HUE_ARG=" hue=${HUE}"
fi

cleanup() {
  if [[ -n "${PION_PID:-}" ]]; then
    kill "${PION_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "[INFO] Starting Pion WHIP publisher"
if [[ "${PION_RUN_MODE}" == "binary" ]]; then
  echo "[INFO] Building publisher binary"
  go build -o ./pion_whip_publisher .
  WHIP_URL="${WHIP_URL}" \
  WHIP_AUTH_TOKEN="${WHIP_AUTH_TOKEN}" \
  RTP_LISTEN_ADDR="${RTP_LISTEN_ADDR}" \
  FIRST_RTP_TIMEOUT="${FIRST_RTP_TIMEOUT}" \
  LOG_RTP="${LOG_RTP}" \
  ./pion_whip_publisher &
else
  WHIP_URL="${WHIP_URL}" \
  WHIP_AUTH_TOKEN="${WHIP_AUTH_TOKEN}" \
  RTP_LISTEN_ADDR="${RTP_LISTEN_ADDR}" \
  FIRST_RTP_TIMEOUT="${FIRST_RTP_TIMEOUT}" \
  LOG_RTP="${LOG_RTP}" \
  go run . &
fi
PION_PID=$!

sleep 2

if ! kill -0 "${PION_PID}" >/dev/null 2>&1; then
  echo "[ERR] Pion publisher failed to start (check logs above)."
  exit 3
fi

echo "[INFO] Starting GStreamer camera feeder"
echo "[INFO] DEVICE=${DEVICE}"
echo "[INFO] PIPELINE_MODE=${PIPELINE_MODE}"
echo "[INFO] FIRST_RTP_TIMEOUT=${FIRST_RTP_TIMEOUT}"
echo "[INFO] MODE=${WIDTH}x${HEIGHT}@${FPS}"
echo "[INFO] BITRATE_KBPS=${BITRATE_KBPS}"
echo "[INFO] X264 preset=${X264_SPEED_PRESET} keyint=${KEYINT_FRAMES} threads=${X264_THREADS}"
if [[ "${PIPELINE_MODE}" == "reencode" ]]; then
  echo "[INFO] IMAGE_ENHANCE=${IMAGE_ENHANCE} gamma=${GAMMA:-off} hue=${HUE:-0}"
  echo "[INFO] BALANCE brightness=${BRIGHTNESS} contrast=${CONTRAST} saturation=${SATURATION}"
fi
echo "[INFO] WHIP_URL=${WHIP_URL}"

if [[ "${PIPELINE_MODE}" == "direct" ]]; then
  gst-launch-1.0 -e \
    v4l2src device="${DEVICE}" do-timestamp=true io-mode=2 ! \
    video/x-h264,width="${WIDTH}",height="${HEIGHT}",framerate="${FPS}"/1 ! \
    h264parse config-interval=1 disable-passthrough=true ! \
    queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! \
    rtph264pay pt=96 config-interval=1 mtu=1200 aggregate-mode=zero-latency ! \
    udpsink host="${HOST}" port="${PORT}" sync=false async=false
else
  gst-launch-1.0 -e \
    v4l2src device="${DEVICE}" do-timestamp=true io-mode=2 ! \
    image/jpeg,width="${WIDTH}",height="${HEIGHT}",framerate="${FPS}"/1 ! \
    jpegdec ! \
    videoconvert ! \
    ${GAMMA_ELEMENT:+${GAMMA_ELEMENT} !} \
    videobalance brightness="${BRIGHTNESS}" contrast="${CONTRAST}" saturation="${SATURATION}"${HUE_ARG} ! \
    ${SHARPEN_ELEMENT:+${SHARPEN_ELEMENT} !} \
    queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! \
    x264enc tune=zerolatency speed-preset="${X264_SPEED_PRESET}" bitrate="${BITRATE_KBPS}" key-int-max="${KEYINT_FRAMES}" bframes=0 byte-stream=true aud=true rc-lookahead=0 sync-lookahead=0 threads="${X264_THREADS}" ! \
    h264parse config-interval=1 ! \
    rtph264pay pt=96 config-interval=1 mtu=1200 aggregate-mode=zero-latency ! \
    udpsink host="${HOST}" port="${PORT}" sync=false async=false
fi