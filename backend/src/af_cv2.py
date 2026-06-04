#!/usr/bin/env python3
"""
Autofocus sharpness via OpenCV2 Laplacian variance.
Background thread reads RTSP frames continuously → no stale buffer issue.
Commands (stdin):
  ping           → pong
  measure        → score
  measure_quick  → score
  exit           → terminate
"""
import cv2
import sys
import os
import threading
import numpy as np


class FrameReader:
    """Background thread that reads RTSP frames continuously to stay fresh."""
    def __init__(self, cap):
        self._cap = cap
        self._frame = None
        self._lock = threading.Lock()
        self._running = True
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def _run(self):
        while self._running:
            ret, frame = self._cap.read()
            if ret and frame is not None:
                with self._lock:
                    self._frame = frame
            # If read fails, just retry immediately

    def latest(self):
        with self._lock:
            return self._frame.copy() if self._frame is not None else None

    def stop(self):
        self._running = False


def laplacian_score(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def main():
    # Suppress H264 decode error output
    os.environ['OPENCV_VIDEOIO_DEBUG'] = '0'

    rtsp_url = os.environ.get('RTSP_URL', 'rtsp://localhost:8554/cam1')

    cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    if not cap.isOpened():
        sys.stderr.write(f'[AF-CV2] Cannot open: {rtsp_url}\n')
        sys.stderr.flush()
        sys.exit(1)

    # Start background reader — keeps frame buffer always fresh
    reader = FrameReader(cap)

    # Wait for first frame
    import time
    for _ in range(50):  # up to 5s
        if reader.latest() is not None:
            break
        time.sleep(0.1)

    sys.stderr.write(f'[AF-CV2] Ready: {rtsp_url}\n')
    sys.stderr.flush()
    sys.stdout.write('ready\n')
    sys.stdout.flush()

    try:
        for line in sys.stdin:
            cmd = line.strip()

            if cmd == 'ping':
                sys.stdout.write('pong\n')
                sys.stdout.flush()

            elif cmd in ('measure', 'measure_quick'):
                frame = reader.latest()
                score = laplacian_score(frame) if frame is not None else 0.0
                sys.stdout.write(f'{score:.6f}\n')
                sys.stdout.flush()

            elif cmd == 'exit':
                break

    except (EOFError, IOError, BrokenPipeError):
        pass
    finally:
        reader.stop()
        cap.release()
        sys.stderr.write('[AF-CV2] Released\n')
        sys.stderr.flush()


if __name__ == '__main__':
    main()
