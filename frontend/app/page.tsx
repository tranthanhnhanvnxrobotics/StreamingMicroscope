"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

type GalleryItem = {
  id: string;
  src: string;
  label: string;
  blob: Blob;
};

type DownloadChoiceTarget = {
  id: string;
  src: string;
  fileName: string;
};

type ConnectionStatus = "online" | "offline" | "reconnecting" | "disabled";
type ControlCommand = "up" | "down" | "left" | "right" | "focus_in" | "focus_out" | "stop";
type MotorVisualState = "idle" | "moving" | "done";
type FocusPositionState = {
  min: number;
  max: number;
  current: number | null;
  updatedAt?: number | null;
};

type FocusEncoderState = {
  min: number;
  max: number;
  safeMax: number;
  current: number | null;
  pct: number | null;
  updatedAt?: number | null;
};

type XyPositionState = {
  x: number | null;
  y: number | null;
  endstopYMin?: boolean;
  updatedAt?: number | null;
};

type HomingModeState = "UNKNOWN" | "AUTO_HOMING" | "READY" | "FAULT";

type HomingStatusState = {
  state: HomingModeState;
  endstopMin: boolean;
  endstopMax: boolean;
  posValid: boolean;
  fault: boolean;
  lastFaultReason: string | null;
  updatedAt?: number | null;
};

type RecoveryHomeState = {
  inProgress: boolean;
  lastRequestedAt: number;
  lastResult: string | null;
  lastReason: string | null;
  updatedAt?: number | null;
};

type AutofocusProgressState = {
  phase: "idle" | "starting" | "moving" | "done" | "error";
  direction?: "focus_in" | "focus_out";
  current?: number | null;
  target?: number | null;
  pct?: number;
  result?: string;
  reason?: string;
};

type StreamMetricsState = {
  rttMs: number | null;
  jitterBufferMs: number | null;
  decodeMs: number | null;
  fps: number | null;
  droppedFrames: number | null;
  freezeCount: number | null;
  updatedAt: number | null;
};

type ExtendedDocument = Document & {
  webkitFullscreenElement?: Element | null;
  mozFullScreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type ExtendedHTMLElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

const SCREENSHOT_QUOTA = 40;
const EMPTY_OVERLAY_MARKER = "";
const MOTOR_DONE_FALLBACK_MS = Number(process.env.NEXT_PUBLIC_MOTOR_DONE_FALLBACK_MS || 260);
const MOTOR_DONE_HOLD_MS = Number(process.env.NEXT_PUBLIC_MOTOR_DONE_HOLD_MS || 420);
const MOTOR_VISUAL_MIN_MOVING_MS = Number(process.env.NEXT_PUBLIC_MOTOR_VISUAL_MIN_MOVING_MS || 150);
/** Failsafe if MOTOR_DONE never arrives — must exceed moving + done hold. */
const CONTROL_DISPATCH_SAFETY_MS = Number(process.env.NEXT_PUBLIC_CONTROL_DISPATCH_SAFETY_MS || 1800);
const endstopHomingEnforced = true;


export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const modalImgRef = useRef<HTMLImageElement | null>(null);
  const modalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [gallery, setGallery] = useState<GalleryItem[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalSrc, setModalSrc] = useState<string | null>(null);
  const [modalItemId, setModalItemId] = useState<string | null>(null);
  const [isIOS, setIsIOS] = useState(false);
  const [isFakeFullscreen, setIsFakeFullscreen] = useState(false);
  const [isNativeFullscreenActive, setIsNativeFullscreenActive] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const [introLeaving, setIntroLeaving] = useState(false);
  const [drawMode, setDrawMode] = useState<"off" | "pen" | "highlight" | "eraser">("off");
  const [penColor, setPenColor] = useState("#ff5c5c");
  const [highlightColor, setHighlightColor] = useState("#ffea00");
  const [penStrokeWidth, setPenStrokeWidth] = useState(3);
  const [highlightStrokeWidth, setHighlightStrokeWidth] = useState(14);
  const [eraserStrokeWidth, setEraserStrokeWidth] = useState(18);
  const [annotationByItemId, setAnnotationByItemId] = useState<Record<string, string>>({});
  const [downloadChoiceTarget, setDownloadChoiceTarget] = useState<DownloadChoiceTarget | null>(null);
  const [undoStack, setUndoStack] = useState<string[]>([]);
  const [redoStack, setRedoStack] = useState<string[]>([]);
  const [controlStatus, setControlStatus] = useState<ConnectionStatus>("offline");
  const [streamStatus, setStreamStatus] = useState<ConnectionStatus>("offline");
  const [activeWhepIndex] = useState(0);
  const [isControlLocked, setIsControlLocked] = useState(false);
  const [motorVisualState, setMotorVisualState] = useState<MotorVisualState>("idle");
  const [focusPosition, setFocusPosition] = useState<FocusPositionState>({
    min: 0,
    max: 420,
    current: null,
    updatedAt: null,
  });
  const [focusEncoder, setFocusEncoder] = useState<FocusEncoderState>({
    min: 0,
    max: 17480,
    safeMax: 17450,
    current: null,
    pct: null,
    updatedAt: null,
  });
  const [xyPosition, setXyPosition] = useState<XyPositionState>({
    x: null,
    y: null,
    updatedAt: null,
  });
  const [focusSyncArmed, setFocusSyncArmed] = useState(false);
  const [, setFocusStatusReason] = useState<string | null>(null);
  const [lastSyncedEncoderPos, setLastSyncedEncoderPos] = useState<number | null>(null);
  const [homingStatus, setHomingStatus] = useState<HomingStatusState>({
    state: "UNKNOWN",
    endstopMin: false,
    endstopMax: false,
    posValid: false,
    fault: false,
    lastFaultReason: null,
    updatedAt: null,
  });
  const [recoveryHomeStatus, setRecoveryHomeStatus] = useState<RecoveryHomeState>({
    inProgress: false,
    lastRequestedAt: 0,
    lastResult: null,
    lastReason: null,
    updatedAt: null,
  });
  const [autofocusLoading, setAutofocusLoading] = useState(false);
  const [autofocusProgress, setAutofocusProgress] = useState<AutofocusProgressState>({ phase: "idle" });
  const [streamMetrics, setStreamMetrics] = useState<StreamMetricsState>({
    rttMs: null,
    jitterBufferMs: null,
    decodeMs: null,
    fps: null,
    droppedFrames: null,
    freezeCount: null,
    updatedAt: null,
  });

  const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:5000";
  const socketToken = process.env.NEXT_PUBLIC_SOCKET_TOKEN || "";
  const whepOptions = useMemo(() => {
    const raw =
      process.env.NEXT_PUBLIC_WHEP_URLS ||
      process.env.NEXT_PUBLIC_WHEP_URL ||
      "http://103.124.94.194:8889/cam1/whep";
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }, []);
  const currentWhepUrl =
    whepOptions[Math.min(activeWhepIndex, Math.max(0, whepOptions.length - 1))] ||
    "http://103.124.94.194:8889/cam1/whep";

  const snapshotBeforeDrawRef = useRef<string>(EMPTY_OVERLAY_MARKER);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const galleryRef = useRef<GalleryItem[]>([]);
  const imgScaleRef = useRef(1);
  const imgXRef = useRef(0);
  const imgYRef = useRef(0);
  const draggingRef = useRef(false);
  const drawingRef = useRef(false);
  const startImgXRef = useRef(0);
  const startImgYRef = useRef(0);
  const pinchStartDistanceRef = useRef<number | null>(null);
  const pinchStartScaleRef = useRef(1);
  const activeModalPointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const lastDrawPointRef = useRef<{ x: number; y: number } | null>(null);
  const commandDispatchLockedRef = useRef(false);
  const commandDispatchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPointerCommandRef = useRef<ControlCommand | null>(null);
  const motorDoneFallbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const motorDoneHoldTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const motorVisualMovingStartedAtRef = useRef<number>(0);
  const motorVisualMovingRef = useRef(false);
  const motorVisualStateRef = useRef<MotorVisualState>("idle");
  const streamReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamStartInFlightRef = useRef(false);
  const streamStatsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autofocusDoneTimerRef = useRef<number | null>(null);
  const streamInboundSampleRef = useRef<{
    framesDecoded: number;
    totalDecodeTime: number;
    measuredAt: number;
  } | null>(null);

  const clampStrokeWidth = (value: number, mode: "pen" | "highlight" | "eraser") => {
    if (mode === "highlight") {
      return Math.max(6, Math.min(value, 42));
    }
    if (mode === "eraser") {
      return Math.max(6, Math.min(value, 54));
    }
    return Math.max(1, Math.min(value, 18));
  };

  const activeStrokeWidth =
    drawMode === "highlight"
      ? highlightStrokeWidth
      : drawMode === "eraser"
        ? eraserStrokeWidth
        : penStrokeWidth;

  const activeColor = drawMode === "highlight" ? highlightColor : penColor;
  const canControl = controlStatus === "online";
  const homingBusy = homingStatus.state === "AUTO_HOMING";
  const isAutofocusActive =
    autofocusLoading ||
    autofocusProgress.phase === "moving" ||
    autofocusProgress.phase === "starting";
  /* Bỏ lock UI — firmware/backend tự reject motor_busy nếu còn bận. */
  const canUseControlButtons = canControl;
  const canUseXYButtons = canControl && !homingBusy && !isAutofocusActive;

  useEffect(() => {
    motorVisualStateRef.current = motorVisualState;
  }, [motorVisualState]);
  const xyMinGuardX = Number(process.env.NEXT_PUBLIC_X_MIN_GUARD || -10);
  const xyMaxGuardX = Number(process.env.NEXT_PUBLIC_X_MAX_GUARD || -7000);
  const xyMaxGuardY = Number(process.env.NEXT_PUBLIC_Y_MAX_GUARD || 10000);
  const xyXValue =
    typeof xyPosition.x === "number" && Number.isFinite(xyPosition.x)
      ? Number(xyPosition.x)
      : null;
  const xyYValue =
    typeof xyPosition.y === "number" && Number.isFinite(xyPosition.y)
      ? Number(xyPosition.y)
      : null;
  const encoderCurrentValue =
    typeof focusEncoder.current === "number" && Number.isFinite(focusEncoder.current)
      ? Number(focusEncoder.current)
      : null;
  // Home = X=0 (left endstop). Pressing RIGHT decreases X (negative). Pressing LEFT increases X.
  // Disable LEFT when X >= xyMinGuardX (within guard buffer of home, e.g. X >= -10).
  // Disable RIGHT when X <= xyMaxGuardX (reached right travel limit, e.g. X <= -7000).
  // When position is null (unknown), block dangerous directions (away from home) as a safety measure.
  const xAtHome = xyXValue !== null && xyXValue >= xyMinGuardX;
  // null → treat as at max (RIGHT blocked until position is known)
  const xNearMax = xyXValue === null || xyXValue <= xyMaxGuardX;
  // Disable DOWN when Y >= xyMaxGuardY (reached max Y travel, e.g. Y >= 10000).
  // null → treat as at max (DOWN blocked until position is known)
  const yAtMax = xyYValue === null || xyYValue >= xyMaxGuardY;
  const focusYRestrictEncoder = Number(process.env.NEXT_PUBLIC_FOCUS_Y_RESTRICT_ENC || 9000);
  const focusYMaxCount = Number(process.env.NEXT_PUBLIC_FOCUS_Y_MAX_COUNT || 1000);
  // Block DOWN chỉ khi focus >= 9000 VÀ Y >= 1000 (bảo vệ phần cứng khi cả 2 trục đều xa).
  const yRestrictedByFocus =
    encoderCurrentValue !== null &&
    encoderCurrentValue >= focusYRestrictEncoder &&
    xyYValue !== null &&
    xyYValue >= focusYMaxCount;
  // Block autofocus when Y >= 1000 (needs stable Y position for sharpness measurement).
  const yNearMax = xyYValue !== null && xyYValue >= focusYMaxCount;
  const canMoveLeft = canUseXYButtons && !xAtHome;
  const canMoveRight = canUseXYButtons && !xNearMax;
  // UP disabled khi firmware báo endstop Y_MIN thật sự triggered.
  // Không dùng encoder value (có thể âm do drift) — chỉ dùng signal endstop từ firmware.
  const yAtEndstop = xyPosition.endstopYMin === true;
  const canMoveUp = canUseXYButtons && !yAtEndstop;
  const canMoveDown = canUseXYButtons && !yRestrictedByFocus && !yAtMax;
  const focusOutEncoderGuard = Number(process.env.NEXT_PUBLIC_FOCUS_OUT_ENCODER_GUARD || 50);
  const syncDriftWarnThreshold = Number(process.env.NEXT_PUBLIC_SYNC_DRIFT_WARN_THRESHOLD || 180);
  const encoderDriftFromLastSync =
    encoderCurrentValue !== null && lastSyncedEncoderPos !== null
      ? Math.abs(encoderCurrentValue - lastSyncedEncoderPos)
      : 0;
  const isLargeEncoderDrift =
    encoderCurrentValue !== null &&
    lastSyncedEncoderPos !== null &&
    encoderDriftFromLastSync > Math.max(1, Number.isFinite(syncDriftWarnThreshold) ? syncDriftWarnThreshold : 180);
  const canUseFocusInByEncoder =
    focusEncoder.current === null || focusEncoder.current < focusEncoder.safeMax;
  const canUseFocusOutByEncoder =
    focusEncoder.current === null ||
    focusEncoder.current > Math.max(focusEncoder.min, Number.isFinite(focusOutEncoderGuard) ? focusOutEncoderGuard : 50);
  const homingReady =
    homingStatus.state === "READY" && homingStatus.posValid && !homingStatus.fault;
  const homingFault = homingStatus.fault || homingStatus.state === "FAULT";
  const focusReady = endstopHomingEnforced ? homingReady : focusSyncArmed;
  const canUseFocusIn =
    canUseControlButtons &&
    focusReady &&
    !homingBusy &&
    !homingFault &&
    !homingStatus.endstopMax &&
    (focusEncoder.current !== null
      ? canUseFocusInByEncoder
      : focusPosition.current === null || focusPosition.current < focusPosition.max);
  const canUseFocusOut =
    canUseControlButtons &&
    focusReady &&
    !homingBusy &&
    !homingFault &&
    !homingStatus.endstopMin &&
    (focusEncoder.current !== null
      ? canUseFocusOutByEncoder
      : focusPosition.current === null || focusPosition.current > focusPosition.min);

  const canUseAutofocus =
    !(autofocusProgress.phase === "starting" || autofocusProgress.phase === "moving") &&
    canControl &&
    !isControlLocked &&
    homingReady &&
    !homingBusy &&
    !homingFault &&
    !autofocusLoading &&
    !yNearMax;

  const focusStatusText = useMemo(() => {
    if (!canControl) {
      return "CONTROL OFFLINE";
    }

    if (endstopHomingEnforced) {
      if (homingBusy || recoveryHomeStatus.inProgress) {
        return "AUTO HOMING...";
      }

      if (homingFault) {
        return "ENDSTOP FAULT - RUN RECOVERY";
      }

      if (!homingReady) {
        return "WAITING HOME READY";
      }

      if (autofocusLoading) {
        return "AUTO FOCUSING...";
      }

      if (motorVisualState === "moving" || isControlLocked) {
        return "EXECUTING COMMAND...";
      }

      if (!canUseFocusInByEncoder || homingStatus.endstopMax) {
        return "MAX LIMIT REACHED";
      }

      if (!canUseFocusOutByEncoder || homingStatus.endstopMin) {
        return "MIN LIMIT REACHED";
      }

      return "HOME READY";
    }

    if (!focusSyncArmed) {
      return isLargeEncoderDrift ? "HARDWARE CHANGED? SYNC AGAIN" : "SYNC REQUIRED";
    }

    if (autofocusLoading) {
      return "AUTO FOCUSING...";
    }

    if (motorVisualState === "moving" || isControlLocked) {
      return "EXECUTING COMMAND...";
    }

    if (!canUseFocusInByEncoder) {
      return "MAX LIMIT REACHED";
    }

    if (!canUseFocusOutByEncoder) {
      return "MIN LIMIT REACHED";
    }

    return "SYNC READY";
  }, [
    canControl,
    focusSyncArmed,
    motorVisualState,
    isControlLocked,
    canUseFocusInByEncoder,
    canUseFocusOutByEncoder,
    isLargeEncoderDrift,
    homingBusy,
    homingFault,
    homingReady,
    homingStatus.endstopMax,
    homingStatus.endstopMin,
    recoveryHomeStatus.inProgress,
    autofocusLoading,
  ]);
  const encoderProgressPercent = (() => {
    const min = Number.isFinite(focusEncoder.min) ? Number(focusEncoder.min) : 0;
    const max = Number.isFinite(focusEncoder.max) ? Number(focusEncoder.max) : 0;
    const current = Number.isFinite(focusEncoder.current) ? Number(focusEncoder.current) : null;
    const span = max - min;

    if (current !== null && span > 0) {
      return Math.max(0, Math.min(100, ((current - min) / span) * 100));
    }

    if (typeof focusEncoder.pct === "number" && Number.isFinite(focusEncoder.pct)) {
      return Math.max(0, Math.min(100, focusEncoder.pct));
    }

    return 0;
  })();
  const encoderPositionLabel =
    typeof focusEncoder.current === "number" && Number.isFinite(focusEncoder.current)
      ? `${Math.round(focusEncoder.current)}`
      : "--";
  const xyPositionLabel = {
    x:
      typeof xyPosition.x === "number" && Number.isFinite(xyPosition.x)
        ? `${Math.round(xyPosition.x)}`
        : "--",
    y:
      typeof xyPosition.y === "number" && Number.isFinite(xyPosition.y)
        ? `${Math.round(xyPosition.y)}`
        : "--",
  };
  const xyBlockReason =
    !canControl ? "OFFLINE" :
    homingBusy ? "HOMING..." :
    (isControlLocked || motorVisualState === "moving") ? "EXECUTING..." :
    isAutofocusActive ? "AUTOFOCUS..." :
    null;

  const formatMetricMs = (value: number | null) =>
    typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} ms` : "--";
  const formatMetricFps = (value: number | null) =>
    typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)} fps` : "--";
  const formatMetricCount = (value: number | null) =>
    typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}` : "--";

  const clearMotorVisualTimers = useCallback(() => {
    if (motorDoneFallbackTimeoutRef.current) {
      clearTimeout(motorDoneFallbackTimeoutRef.current);
      motorDoneFallbackTimeoutRef.current = null;
    }
    if (motorDoneHoldTimeoutRef.current) {
      clearTimeout(motorDoneHoldTimeoutRef.current);
      motorDoneHoldTimeoutRef.current = null;
    }
  }, []);

  const clearCommandDispatchLock = useCallback(() => {
    commandDispatchLockedRef.current = false;
    setIsControlLocked(false);
    if (!commandDispatchTimeoutRef.current) return;
    clearTimeout(commandDispatchTimeoutRef.current);
    commandDispatchTimeoutRef.current = null;
  }, []);

  const setMotorVisualIdle = useCallback(() => {
    clearMotorVisualTimers();
    motorVisualMovingStartedAtRef.current = 0;
    motorVisualMovingRef.current = false;
    motorVisualStateRef.current = "idle";
    setMotorVisualState("idle");
    // Không gọi clearCommandDispatchLock ở đây nữa —
    // lock được clear bởi ack callback hoặc 400ms safety timeout.
    // Tránh motor_state events từ autofocus cancel nhầm dispatch lock của user.
  }, [clearMotorVisualTimers]);

  const setMotorVisualDone = useCallback(() => {
    clearMotorVisualTimers();
    const elapsed =
      motorVisualMovingStartedAtRef.current > 0
        ? Date.now() - motorVisualMovingStartedAtRef.current
        : Math.max(0, MOTOR_VISUAL_MIN_MOVING_MS);
    const waitBeforeDone = Math.max(0, Math.max(0, MOTOR_VISUAL_MIN_MOVING_MS) - elapsed);

    const applyDone = () => {
      motorVisualMovingRef.current = false;
      motorVisualStateRef.current = "done";
      setMotorVisualState("done");
      motorDoneHoldTimeoutRef.current = setTimeout(() => {
        setMotorVisualIdle();
        motorDoneHoldTimeoutRef.current = null;
      }, Math.max(180, MOTOR_DONE_HOLD_MS));
    };

    if (waitBeforeDone > 0) {
      motorDoneFallbackTimeoutRef.current = setTimeout(() => {
        applyDone();
        motorDoneFallbackTimeoutRef.current = null;
      }, waitBeforeDone);
      return;
    }

    applyDone();
  }, [clearMotorVisualTimers, setMotorVisualIdle]);

  const setMotorVisualMoving = useCallback(() => {
    if (motorVisualMovingRef.current) return;
    clearMotorVisualTimers();
    motorVisualMovingStartedAtRef.current = Date.now();
    motorVisualMovingRef.current = true;
    motorVisualStateRef.current = "moving";
    setMotorVisualState("moving");
    motorDoneFallbackTimeoutRef.current = setTimeout(() => {
      setMotorVisualDone();
      motorDoneFallbackTimeoutRef.current = null;
    }, Math.max(80, MOTOR_DONE_FALLBACK_MS));
  }, [clearMotorVisualTimers, setMotorVisualDone]);

  const requestFocusPosition = useCallback(() => {
    if (!socketRef.current) return;
    socketRef.current.emit("focus_position_query", (ackPayload?: { status?: string }) => {
      if (ackPayload?.status !== "accepted") {
        console.debug("[FOCUS] query rejected", ackPayload);
      }
    });
  }, []);

  const requestEncoderPosition = useCallback((options?: { armOnSuccess?: boolean }) => {
    if (!socketRef.current) return;
    const armOnSuccess = options?.armOnSuccess === true;
    socketRef.current.emit(
      "encoder_position_query",
      (ackPayload?: {
        status?: string;
        focusSyncArmed?: boolean;
        snapshot?: {
          min?: number;
          max?: number;
          safeMax?: number;
          current?: number | null;
          pct?: number | null;
          updatedAt?: number | null;
        };
      }) => {
        if (ackPayload?.status === "accepted") {
          const payload = ackPayload.snapshot;
          if (payload) {
            setFocusEncoder((prev) => ({
              min: Number.isFinite(payload?.min) ? Number(payload.min) : prev.min,
              max: Number.isFinite(payload?.max) ? Number(payload.max) : prev.max,
              safeMax: Number.isFinite(payload?.safeMax) ? Number(payload.safeMax) : prev.safeMax,
              current:
                typeof payload?.current === "number" && Number.isFinite(payload.current)
                  ? Number(payload.current)
                  : payload?.current === null
                    ? null
                    : prev.current,
              pct:
                typeof payload?.pct === "number" && Number.isFinite(payload.pct)
                  ? Number(payload.pct)
                  : payload?.pct === null
                    ? null
                    : prev.pct,
              updatedAt:
                typeof payload?.updatedAt === "number" && Number.isFinite(payload.updatedAt)
                  ? Number(payload.updatedAt)
                  : prev.updatedAt ?? null,
            }));
          }

          if (ackPayload?.focusSyncArmed === true) {
            setFocusSyncArmed(true);
            setFocusStatusReason(null);
            if (typeof payload?.current === "number" && Number.isFinite(payload.current)) {
              setLastSyncedEncoderPos(Number(payload.current));
            }
          }

          if (armOnSuccess) {
            setFocusSyncArmed(true);
            setFocusStatusReason(null);
            if (typeof payload?.current === "number" && Number.isFinite(payload.current)) {
              setLastSyncedEncoderPos(Number(payload.current));
            }
          }
        }

        if (ackPayload?.status !== "accepted") {
          if (!armOnSuccess) {
            setFocusStatusReason("sync_required");
          }
          console.debug("[ENC] query rejected", ackPayload);
        }
      }
    );
  }, []);

  const requestXyPosition = useCallback(() => {
    if (!socketRef.current) return;
    socketRef.current.emit("xy_position_query", (ackPayload?: { status?: string }) => {
      if (ackPayload?.status !== "accepted") {
        console.debug("[XY] query rejected", ackPayload);
      }
    });
  }, []);

  const sendControlCommand = useCallback((command: ControlCommand) => {
    if (!socketRef.current || !canControl) return;
    const isXyCommand = command === "up" || command === "down" || command === "left" || command === "right";
    if (isXyCommand) {
      if (homingBusy) return;
      if (
        (command === "left" && !canMoveLeft) ||
        (command === "right" && !canMoveRight) ||
        (command === "up" && !canMoveUp) ||
        (command === "down" && !canMoveDown)
      ) {
        return;
      }
    }

    setAutofocusProgress((prev) => {
      if (prev.phase === "done" || prev.phase === "error") {
        return { phase: "idle" };
      }
      return prev;
    });
    console.debug("[CONTROL] dispatch", { command, at: Date.now() });
    socketRef.current.emit(
      "control_motor",
      { command },
      (ackPayload?: { status?: string; reason?: string; command?: string }) => {
        console.debug("[CONTROL] ack", {
          command,
          status: ackPayload?.status || "unknown",
          reason: ackPayload?.reason,
          at: Date.now(),
        });
        if (ackPayload?.status === "accepted") {
          if (command === "stop") {
            setMotorVisualDone();
          } else {
            setMotorVisualMoving();
          }
          setFocusStatusReason(null);
          // Encoder query đã được backend thực hiện sau MOTOR_DONE:FOCUS_IN
          // để tránh ENC_POS traffic đè lên MOTOR_DONE → STM32 TX overflow.
        }
        const ackReason = String(ackPayload?.reason || "").toUpperCase();
        if (ackPayload?.status === "rejected" && command === "focus_in" && ackReason === "LIMIT_MAX") {
          setFocusPosition((prev) => ({ ...prev, current: prev.max, updatedAt: Date.now() }));
        }
        if (ackPayload?.status === "rejected" && command === "focus_out" && ackReason === "LIMIT_MIN") {
          setFocusPosition((prev) => ({ ...prev, current: prev.min, updatedAt: Date.now() }));
        }
        if (ackPayload?.status === "rejected") {
          setFocusStatusReason(ackPayload?.reason || "control_rejected");
        }
      }
    );
  }, [canControl, canMoveDown, canMoveLeft, canMoveRight, canMoveUp, homingBusy, setMotorVisualDone, setMotorVisualMoving]);

  const requestAutofocus = useCallback(() => {
    if (!socketRef.current || !canControl) return;
    const autofocusInProgress =
      autofocusLoading ||
      autofocusProgress.phase === "starting" ||
      autofocusProgress.phase === "moving";
    if (!homingReady || homingBusy || homingFault || autofocusInProgress) return;

    setAutofocusLoading(true);
    setAutofocusProgress({ phase: "starting" });

    const safetyClear = window.setTimeout(() => {
      setAutofocusLoading(false);
      setAutofocusProgress({ phase: "idle" });
    }, 60000);

    socketRef.current.emit(
      "autofocus_run",
      {},
      (ack?: { status?: string; reason?: string }) => {
        window.clearTimeout(safetyClear);
        
        // Bug #7 fix: Only stop loading immediately if rejected. 
        // If accepted, let `autofocus_progress` event handle the transition.
        if (ack?.status !== "accepted") {
            setAutofocusLoading(false);
        }

        if (ack?.status === "accepted") {
          setFocusStatusReason(null);

          window.setTimeout(() => {
            requestEncoderPosition({ armOnSuccess: false });
          }, 350);
          return;
        }

        setAutofocusProgress({ phase: "error", reason: ack?.reason || "autofocus_rejected" });
        setFocusStatusReason(ack?.reason || "autofocus_rejected");

        if (autofocusDoneTimerRef.current) clearTimeout(autofocusDoneTimerRef.current);
        autofocusDoneTimerRef.current = window.setTimeout(() => {
          setAutofocusProgress({ phase: "idle" });
          autofocusDoneTimerRef.current = null;
        }, 2500);
      }
    );
  }, [autofocusLoading, autofocusProgress.phase, canControl, homingBusy, homingFault, homingReady, requestEncoderPosition]);

  const cancelAutofocus = useCallback(() => {
    if (!socketRef.current) return;
    socketRef.current.emit("autofocus_cancel", {}, (ack?: { status?: string }) => {
      console.debug("[AUTOFOCUS] cancel ack", ack);
      setAutofocusLoading(false);
      setAutofocusProgress({ phase: "idle" });
    });
  }, []);

  const focusCommands = useMemo(
    () => [
      { label: "＋", cmd: "focus_in" },
      { label: "－", cmd: "focus_out" },
    ],
    []
  );

  const onControlPointerDown = (command: ControlCommand) => {
    lastPointerCommandRef.current = command;
    sendControlCommand(command);
  };

  const onControlClick = (command: ControlCommand) => {
    if (lastPointerCommandRef.current === command) {
      lastPointerCommandRef.current = null;
      return;
    }
    lastPointerCommandRef.current = null;
    sendControlCommand(command);
  };

  const onXyControlPointerDown =
    (command: "up" | "down" | "left" | "right") =>
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onControlPointerDown(command);
    };

  const onXyControlClick =
    (command: "up" | "down" | "left" | "right") =>
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onControlClick(command);
    };

  const onFocusPointerDown = (command: "focus_in" | "focus_out") => {
    onControlPointerDown(command);
  };

  const onFocusClick = (command: "focus_in" | "focus_out") => {
    onControlClick(command);
  };

  const onFocusControlPointerDown =
    (command: "focus_in" | "focus_out") =>
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onFocusPointerDown(command);
    };

  const onFocusControlClick =
    (command: "focus_in" | "focus_out") =>
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onFocusClick(command);
    };

  const getOverlaySnapshot = (itemId: string | null) => {
    if (!itemId) return EMPTY_OVERLAY_MARKER;
    return annotationByItemId[itemId] || EMPTY_OVERLAY_MARKER;
  };

  const updateOverlayForItem = (itemId: string, overlay: string) => {
    setAnnotationByItemId((prev) => {
      if (!overlay) {
        if (!prev[itemId]) return prev;
        const next = { ...prev };
        delete next[itemId];
        return next;
      }

      return {
        ...prev,
        ...{[itemId]: overlay},
      };
    });
  };

  const releaseGalleryItemResources = (item: GalleryItem) => {
    URL.revokeObjectURL(item.src);
  };

  const changeStrokeWidth = (delta: number) => {
    if (drawMode === "off") return;

    if (drawMode === "highlight") {
      setHighlightStrokeWidth((prev) => clampStrokeWidth(prev + delta, "highlight"));
      return;
    }

    if (drawMode === "eraser") {
      setEraserStrokeWidth((prev) => clampStrokeWidth(prev + delta, "eraser"));
      return;
    }

    setPenStrokeWidth((prev) => clampStrokeWidth(prev + delta, "pen"));
  };

  const updateImageTransform = () => {
    const transform = `translate(${imgXRef.current}px, ${imgYRef.current}px) scale(${imgScaleRef.current})`;
    if (modalImgRef.current) {
      modalImgRef.current.style.transform = transform;
    }
    if (modalCanvasRef.current) {
      modalCanvasRef.current.style.transform = transform;
    }
  };

  const getCanvasContext = () => {
    const canvas = modalCanvasRef.current;
    if (!canvas) return null;
    return canvas.getContext("2d");
  };

  const hexToRgba = (hex: string, alpha: number) => {
    const normalized = hex.replace("#", "");
    const value =
      normalized.length === 3
        ? normalized
            .split("")
            .map((char) => char + char)
            .join("")
        : normalized;

    const red = Number.parseInt(value.slice(0, 2), 16);
    const green = Number.parseInt(value.slice(2, 4), 16);
    const blue = Number.parseInt(value.slice(4, 6), 16);

    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  };

  const canvasHasDrawing = (context: CanvasRenderingContext2D, width: number, height: number) => {
    const pixels = context.getImageData(0, 0, width, height).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0) return true;
    }
    return false;
  };

  const persistAnnotationsForCurrentItem = () => {
    const canvas = modalCanvasRef.current;
    const context = getCanvasContext();
    if (!canvas || !context || !modalItemId) return;

    const width = canvas.width / (window.devicePixelRatio || 1);
    const height = canvas.height / (window.devicePixelRatio || 1);
    const hasDrawing = canvasHasDrawing(context, canvas.width, canvas.height); // Bug 10 fix: Use physical pixels

    if (!hasDrawing) {
      updateOverlayForItem(modalItemId, EMPTY_OVERLAY_MARKER);
      return;
    }

    const dataUrl = canvas.toDataURL("image/png");
    updateOverlayForItem(modalItemId, dataUrl);
  };

  const setupAnnotationCanvas = () => {
    const image = modalImgRef.current;
    const canvas = modalCanvasRef.current;
    if (!image || !canvas) return;

    const width = image.clientWidth;
    const height = image.clientHeight;
    if (!width || !height) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.lineJoin = "round";
    context.lineCap = "round";
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height); // Bug 11 fix
    context.restore();

    if (!modalItemId) return;
    const savedOverlay = annotationByItemId[modalItemId];
    if (!savedOverlay) return;

    const overlay = new window.Image();
    overlay.onload = () => {
      context.drawImage(overlay, 0, 0, width, height);
    };
    overlay.src = savedOverlay;
  };

  const applyOverlayToCanvas = (overlaySrc: string) => {
    const canvas = modalCanvasRef.current;
    const context = getCanvasContext();
    if (!canvas || !context) return;

    const width = canvas.width / (window.devicePixelRatio || 1);
    const height = canvas.height / (window.devicePixelRatio || 1);
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height); // Bug 11 fix
    context.restore();

    if (!overlaySrc) return;

    const image = new window.Image();
    image.onload = () => {
      context.drawImage(image, 0, 0, width, height);
    };
    image.src = overlaySrc;
  };

  const pushUndoSnapshot = (snapshot: string) => {
    setUndoStack((prev) => [...prev.slice(-19), snapshot]);
    setRedoStack([]);
  };

  const handleUndoAnnotation = () => {
    if (!modalItemId || undoStack.length === 0) return;

    const current = getOverlaySnapshot(modalItemId);
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    setRedoStack((prev) => [...prev, current]);
    updateOverlayForItem(modalItemId, previous);
    applyOverlayToCanvas(previous);
  };

  const handleRedoAnnotation = () => {
    if (!modalItemId || redoStack.length === 0) return;

    const current = getOverlaySnapshot(modalItemId);
    const next = redoStack[redoStack.length - 1];
    setRedoStack((prev) => prev.slice(0, -1));
    setUndoStack((prev) => [...prev.slice(-19), current]);
    updateOverlayForItem(modalItemId, next);
    applyOverlayToCanvas(next);
  };

  const clearAnnotations = () => {
    const canvas = modalCanvasRef.current;
    const context = getCanvasContext();
    if (!canvas || !context) return;

    pushUndoSnapshot(getOverlaySnapshot(modalItemId));
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height); // Bug 11 fix
    context.restore();
    persistAnnotationsForCurrentItem();
  };

  const resetImageState = () => {
    imgScaleRef.current = 1;
    imgXRef.current = 0;
    imgYRef.current = 0;
    updateImageTransform();
  };

  const openModal = (itemId: string, src: string) => {
    setModalItemId(itemId);
    setModalSrc(src);
    setIsModalOpen(true);
    setDrawMode("off");
    setUndoStack([]);
    setRedoStack([]);
    resetImageState();
  };

  const closeModal = () => {
    persistAnnotationsForCurrentItem();
    setIsModalOpen(false);
    setDrawMode("off");
    setModalItemId(null);
    setUndoStack([]);
    setRedoStack([]);
    draggingRef.current = false;
    pinchStartDistanceRef.current = null;
    activeModalPointersRef.current.clear();
  };

  const handleScreenshot = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const objectUrl = URL.createObjectURL(blob);

      setGallery((prev) => {
        const next = [
          { id: `${Date.now()}-${prev.length}`, src: objectUrl, label: "untitled", blob },
          ...prev,
        ];

        if (next.length <= SCREENSHOT_QUOTA) {
          return next;
        }

        const trimmed = next.slice(0, SCREENSHOT_QUOTA);
        const removed = next.slice(SCREENSHOT_QUOTA);
        removed.forEach((item) => releaseGalleryItemResources(item));

        // Bug 12 fix: Move state update out of current set-state macro tick
        setTimeout(() => {
          setAnnotationByItemId((annotationPrev) => {
            const updated = { ...annotationPrev };
            removed.forEach((item) => {
              delete updated[item.id];
            });
            return updated;
          });
        }, 0);

        return trimmed;
      });
    }, "image/png");
  };

  const getDisplayName = (item: GalleryItem, index: number) => {
    return `${index + 1} - ${item.label}`;
  };

  const handleRename = (id: string, currentLabel: string) => {
    const next = window.prompt("Nhập tên ảnh", currentLabel);
    if (!next) return;

    const trimmed = next.trim();
    if (!trimmed) return;

    setGallery((prev) =>
      prev.map((item) => (item.id === id ? { ...item, label: trimmed } : item))
    );
  };

  const downloadDataUrl = (src: string, fileName: string) => {
    const safeName = fileName.replace(/[^a-zA-Z0-9-_\s]/g, "").trim().replace(/\s+/g, "-");
    const link = document.createElement("a");
    link.href = src;
    link.download = `${safeName || "screenshot"}.png`;
    link.click();
  };

  const mergeImageWithOverlay = (baseSrc: string, overlaySrc: string) => {
    return new Promise<string>((resolve, reject) => {
      const baseImg = new window.Image();
      const overlayImg = new window.Image();
      let loadedCount = 0;

      const tryCompose = () => {
        loadedCount += 1;
        if (loadedCount < 2) return;

        const canvas = document.createElement("canvas");
        canvas.width = baseImg.naturalWidth || baseImg.width;
        canvas.height = baseImg.naturalHeight || baseImg.height;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("Canvas context unavailable"));
          return;
        }

        context.drawImage(baseImg, 0, 0, canvas.width, canvas.height);
        context.drawImage(overlayImg, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };

      baseImg.onload = tryCompose;
      overlayImg.onload = tryCompose;
      baseImg.onerror = () => reject(new Error("Failed to load base image"));
      overlayImg.onerror = () => reject(new Error("Failed to load overlay image"));

      baseImg.src = baseSrc;
      overlayImg.src = overlaySrc;
    });
  };

  const handleDownload = (item: GalleryItem, index: number) => {
    setDownloadChoiceTarget({
      id: item.id,
      src: item.src,
      fileName: getDisplayName(item, index),
    });
  };

  const closeDownloadChoice = () => {
    setDownloadChoiceTarget(null);
  };

  const handleSaveOriginalImage = () => {
    if (!downloadChoiceTarget) return;
    downloadDataUrl(downloadChoiceTarget.src, downloadChoiceTarget.fileName);
    closeDownloadChoice();
  };

  const handleSaveEditedImage = async () => {
    if (!downloadChoiceTarget) return;
    const overlaySrc = annotationByItemId[downloadChoiceTarget.id];
    if (!overlaySrc) return;

    try {
      const mergedSrc = await mergeImageWithOverlay(downloadChoiceTarget.src, overlaySrc);
      downloadDataUrl(mergedSrc, `${downloadChoiceTarget.fileName}-with-annotation`);
    } catch {
      downloadDataUrl(downloadChoiceTarget.src, downloadChoiceTarget.fileName);
    } finally {
      closeDownloadChoice();
    }
  };

  const handleDelete = (id: string) => {
    setGallery((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) {
        releaseGalleryItemResources(target);
      }
      return prev.filter((item) => item.id !== id);
    });
    setDownloadChoiceTarget((prev) => (prev?.id === id ? null : prev));
    setAnnotationByItemId((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const enterFakeFullscreen = () => {
    setIsFakeFullscreen(true);
    document.body.style.overflow = "hidden";
  };

  const exitFakeFullscreen = () => {
    setIsFakeFullscreen(false);
    document.body.style.overflow = "";
  };

  const handleFullscreenToggle = async () => {
    const wrapper = wrapperRef.current as ExtendedHTMLElement | null;
    const doc = document as ExtendedDocument;
    const isNativeFullscreen =
      document.fullscreenElement ||
      doc.webkitFullscreenElement ||
      doc.mozFullScreenElement ||
      doc.msFullscreenElement;

    if (isIOS) {
      if (isFakeFullscreen) exitFakeFullscreen();
      else enterFakeFullscreen();
      return;
    }

    if (!isNativeFullscreen) {
      if (wrapper?.requestFullscreen) {
        try {
          await wrapper.requestFullscreen();
        } catch {
          enterFakeFullscreen();
        }
      } else if (wrapper?.webkitRequestFullscreen) {
        wrapper.webkitRequestFullscreen();
      } else if (wrapper?.msRequestFullscreen) {
        wrapper.msRequestFullscreen();
      } else {
        enterFakeFullscreen();
      }
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (doc.webkitExitFullscreen) doc.webkitExitFullscreen();
    }
  };

  useEffect(() => {
    setIsIOS(/iPad|iPhone|iPod/.test(navigator.userAgent));
  }, []);

  useEffect(() => {
    if (!isModalOpen) return;
    const previousOverflow = document.body.style.overflow;
    const previousTouchAction = document.body.style.touchAction;
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";

    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.touchAction = previousTouchAction;
    };
  }, [isModalOpen]);

  useEffect(() => {
    return () => {
      clearCommandDispatchLock();
      clearMotorVisualTimers();
      if (autofocusDoneTimerRef.current) clearTimeout(autofocusDoneTimerRef.current);
    };
  }, [clearCommandDispatchLock, clearMotorVisualTimers]);

  // After homing completes the firmware resets XY to (0, 0) but doesn't push an xy_position event.
  // Query immediately so the left/up guards reflect the new position.
  useEffect(() => {
    if (homingStatus.state === "READY") {
      requestXyPosition();
    }
  }, [homingStatus.state, requestXyPosition]);

  useEffect(() => {
    if (socketRef.current) {
      return;
    }

    setControlStatus("reconnecting");
    const socket = io(socketUrl, {
      transports: ["websocket"],
      auth: socketToken ? { token: socketToken } : undefined,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setControlStatus("online");
      setFocusSyncArmed(false);
      setFocusStatusReason("sync_required");
      setLastSyncedEncoderPos(null);
      requestFocusPosition();
      requestXyPosition();
    });

    socket.on("connect_error", () => {
      setControlStatus("reconnecting");
    });

    socket.on("control_status", (payload: { status?: string; command?: string; reason?: string }) => {
      if (payload?.status === "disabled") {
        setControlStatus("disabled");
        return;
      }

      if (payload?.status === "online") {
        setControlStatus("online");
        return;
      }

      if (payload?.status === "rejected") {
        if (
          payload?.reason === "sync_required" ||
          payload?.reason === "encoder_stale" ||
          payload?.reason === "encoder_stale_sync_required"
        ) {
          setFocusSyncArmed(false);
        }
        setFocusStatusReason(payload?.reason || "control_rejected");
        if (payload?.reason === "LIMIT_MAX" || payload?.reason === "max_limit") {
          setFocusPosition((prev) => ({ ...prev, current: prev.max, updatedAt: Date.now() }));
        }
        if (payload?.reason === "LIMIT_MIN" || payload?.reason === "min_limit") {
          setFocusPosition((prev) => ({ ...prev, current: prev.min, updatedAt: Date.now() }));
        }
        setMotorVisualIdle();
      }
    });

    socket.on(
      "homing_status",
      (payload: {
        state?: HomingModeState;
        endstopMin?: boolean;
        endstopMax?: boolean;
        posValid?: boolean;
        fault?: boolean;
        lastFaultReason?: string | null;
        updatedAt?: number | null;
      }) => {
        setHomingStatus((prev) => ({
          state:
            payload?.state === "UNKNOWN" ||
            payload?.state === "AUTO_HOMING" ||
            payload?.state === "READY" ||
            payload?.state === "FAULT"
              ? payload.state
              : prev.state,
          endstopMin: typeof payload?.endstopMin === "boolean" ? payload.endstopMin : prev.endstopMin,
          endstopMax: typeof payload?.endstopMax === "boolean" ? payload.endstopMax : prev.endstopMax,
          posValid: typeof payload?.posValid === "boolean" ? payload.posValid : prev.posValid,
          fault: typeof payload?.fault === "boolean" ? payload.fault : prev.fault,
          lastFaultReason:
            typeof payload?.lastFaultReason === "string" || payload?.lastFaultReason === null
              ? payload.lastFaultReason
              : prev.lastFaultReason,
          updatedAt:
            typeof payload?.updatedAt === "number" && Number.isFinite(payload.updatedAt)
              ? Number(payload.updatedAt)
              : prev.updatedAt ?? null,
        }));
      }
    );

    socket.on(
      "recovery_home_status",
      (payload: {
        inProgress?: boolean;
        lastRequestedAt?: number;
        lastResult?: string | null;
        lastReason?: string | null;
        updatedAt?: number | null;
      }) => {
        setRecoveryHomeStatus((prev) => ({
          inProgress: typeof payload?.inProgress === "boolean" ? payload.inProgress : prev.inProgress,
          lastRequestedAt:
            typeof payload?.lastRequestedAt === "number" && Number.isFinite(payload.lastRequestedAt)
              ? Number(payload.lastRequestedAt)
              : prev.lastRequestedAt,
          lastResult:
            typeof payload?.lastResult === "string" || payload?.lastResult === null
              ? payload.lastResult
              : prev.lastResult,
          lastReason:
            typeof payload?.lastReason === "string" || payload?.lastReason === null
              ? payload.lastReason
              : prev.lastReason,
          updatedAt:
            typeof payload?.updatedAt === "number" && Number.isFinite(payload.updatedAt)
              ? Number(payload.updatedAt)
              : prev.updatedAt ?? null,
        }));
      }
    );

    socket.on(
      "focus_position",
      (payload: { min?: number; max?: number; current?: number | null; updatedAt?: number | null }) => {
        setFocusPosition((prev) => ({
          min: Number.isFinite(payload?.min) ? Number(payload.min) : prev.min,
          max: Number.isFinite(payload?.max) ? Number(payload.max) : prev.max,
          current:
            typeof payload?.current === "number" && Number.isFinite(payload.current)
              ? Number(payload.current)
              : payload?.current === null
                ? null
                : prev.current,
          updatedAt:
            typeof payload?.updatedAt === "number" && Number.isFinite(payload.updatedAt)
              ? Number(payload.updatedAt)
              : prev.updatedAt ?? null,
        }));
      }
    );

    socket.on(
      "focus_encoder",
      (payload: {
        min?: number;
        max?: number;
        safeMax?: number;
        current?: number | null;
        pct?: number | null;
        updatedAt?: number | null;
      }) => {
        setFocusEncoder((prev) => ({
          min: Number.isFinite(payload?.min) ? Number(payload.min) : prev.min,
          max: Number.isFinite(payload?.max) ? Number(payload.max) : prev.max,
          safeMax: Number.isFinite(payload?.safeMax) ? Number(payload.safeMax) : prev.safeMax,
          current:
            typeof payload?.current === "number" && Number.isFinite(payload.current)
              ? Number(payload.current)
              : payload?.current === null
                ? null
                : prev.current,
          pct:
            typeof payload?.pct === "number" && Number.isFinite(payload.pct)
              ? Number(payload.pct)
              : payload?.pct === null
                ? null
                : prev.pct,
          updatedAt:
            typeof payload?.updatedAt === "number" && Number.isFinite(payload.updatedAt)
              ? Number(payload.updatedAt)
              : prev.updatedAt ?? null,
        }));
      }
    );

    socket.on(
      "xy_position",
      (payload: {
        x?: number | null;
        y?: number | null;
        endstopYMin?: boolean;
        updatedAt?: number | null;
      }) => {
        setXyPosition((prev) => ({
          x:
            typeof payload?.x === "number" && Number.isFinite(payload.x)
              ? Number(payload.x)
              : payload?.x === null
                ? null
                : prev.x,
          y:
            typeof payload?.y === "number" && Number.isFinite(payload.y)
              ? Number(payload.y)
              : payload?.y === null
                ? null
                : prev.y,
          endstopYMin:
            typeof payload?.endstopYMin === "boolean" ? payload.endstopYMin : prev.endstopYMin,
          updatedAt:
            typeof payload?.updatedAt === "number" && Number.isFinite(payload.updatedAt)
              ? Number(payload.updatedAt)
              : prev.updatedAt ?? null,
        }));
      }
    );

    socket.on("motor_state", (payload: { status?: string; command?: string }) => {
      if (payload?.status === "started" && payload?.command !== "stop") {
        setMotorVisualMoving();
        return;
      }

      if (payload?.status === "done") {
        // Chỉ xử lý "done" khi đang ở trạng thái "moving".
        // Nếu đã về "idle" (do rejected ack hoặc fallback timer), bỏ qua sự kiện muộn
        // để tránh kéo UI trở lại "EXECUTING..." không cần thiết.
        if (motorVisualStateRef.current === "moving") {
          setMotorVisualDone();
        }
        // XY_POS được query bởi backend ngay sau MOTOR_DONE → tránh double-query.
        return;
      }

      if (payload?.status === "timeout" || payload?.status === "idle") {
        setMotorVisualIdle();
      }
    });

    socket.on(
      "autofocus_progress",
      (payload: {
        phase?: string;
        direction?: string;
        current?: number | null;
        target?: number | null;
        pct?: number;
        result?: string;
        reason?: string;
      }) => {
        const phase = payload?.phase as AutofocusProgressState["phase"] || "idle";
        setAutofocusProgress({
          phase,
          direction: payload?.direction as "focus_in" | "focus_out" | undefined,
          current: typeof payload?.current === "number" ? payload.current : null,
          target: typeof payload?.target === "number" ? payload.target : null,
          pct: typeof payload?.pct === "number" ? Math.max(0, Math.min(100, payload.pct)) : undefined,
          result: payload?.result,
          reason: payload?.reason,
        });

        if (phase === "starting" || phase === "moving") {
          setAutofocusLoading(true);
          // Hủy timer clear nếu có lệnh auto focus mới đang chạy
          if (autofocusDoneTimerRef.current) {
            clearTimeout(autofocusDoneTimerRef.current);
            autofocusDoneTimerRef.current = null;
          }
        }
        
        if (phase === "done" || phase === "error" || phase === "idle") {
          setAutofocusLoading(false);
        }

        // FIX 2: Tự động trả giao diện nút bấm về chữ "AUTO" sau 3 giây
        if (phase === "done" || phase === "error") {
          if (autofocusDoneTimerRef.current) clearTimeout(autofocusDoneTimerRef.current);
          autofocusDoneTimerRef.current = window.setTimeout(() => {
            setAutofocusProgress((prev) => (prev.phase === phase ? { phase: "idle" } : prev));
            autofocusDoneTimerRef.current = null;
          }, 3000);
        }
      }
    );


    socket.on("disconnect", (reason) => {
      console.debug("[SOCKET] disconnect", reason);
      setControlStatus("offline");
      setFocusSyncArmed(false);
      setFocusStatusReason("disconnected");
      setLastSyncedEncoderPos(null);
      clearCommandDispatchLock();
      setMotorVisualIdle();
      setAutofocusLoading(false);
      setAutofocusProgress({ phase: "idle" });
    });

    return () => {
      socketRef.current = null;
      socket.disconnect();
    };
  }, [
    clearCommandDispatchLock,
    requestEncoderPosition,
    requestFocusPosition,
    requestXyPosition,
    setMotorVisualDone,
    setMotorVisualIdle,
    setMotorVisualMoving,
    socketToken,
    socketUrl,
  ]);

  useEffect(() => {
    galleryRef.current = gallery;
  }, [gallery]);

  useEffect(() => {
    const resetStats = () => {
      if (streamStatsIntervalRef.current) {
        clearInterval(streamStatsIntervalRef.current);
        streamStatsIntervalRef.current = null;
      }
      streamInboundSampleRef.current = null;
      setStreamMetrics({
        rttMs: null,
        jitterBufferMs: null,
        decodeMs: null,
        fps: null,
        droppedFrames: null,
        freezeCount: null,
        updatedAt: null,
      });
    };

    if (streamStatus !== "online") {
      resetStats();
      return;
    }

    const collectStats = async () => {
      const pc = pcRef.current;
      if (!pc) return;

      try {
        const report = await pc.getStats();
        let rttMs: number | null = null;
        let jitterBufferMs: number | null = null;
        let decodeMs: number | null = null;
        let fps: number | null = null;
        let droppedFrames: number | null = null;
        let freezeCount: number | null = null;

        report.forEach((entry) => {
          const candidatePair = entry as RTCStats & {
            selected?: boolean;
            nominated?: boolean;
            state?: string;
            currentRoundTripTime?: number;
          };
          if (
            entry.type === "candidate-pair" &&
            (candidatePair.selected === true || candidatePair.nominated === true || candidatePair.state === "succeeded") &&
            typeof candidatePair.currentRoundTripTime === "number"
          ) {
            rttMs = Math.max(0, candidatePair.currentRoundTripTime * 1000);
          }

          const inbound = entry as RTCInboundRtpStreamStats & {
            kind?: string;
            mediaType?: string;
            framesDropped?: number;
            freezeCount?: number;
            jitterBufferDelay?: number;
            jitterBufferEmittedCount?: number;
            totalDecodeTime?: number;
            framesDecoded?: number;
            framesPerSecond?: number;
          };

          if (entry.type !== "inbound-rtp") return;
          if (inbound.kind !== "video" && inbound.mediaType !== "video") return;

          if (
            typeof inbound.jitterBufferDelay === "number" &&
            typeof inbound.jitterBufferEmittedCount === "number" &&
            inbound.jitterBufferEmittedCount > 0
          ) {
            jitterBufferMs = (inbound.jitterBufferDelay / inbound.jitterBufferEmittedCount) * 1000;
          }

          if (typeof inbound.framesDropped === "number") {
            droppedFrames = inbound.framesDropped;
          }

          if (typeof inbound.freezeCount === "number") {
            freezeCount = inbound.freezeCount;
          }

          if (typeof inbound.framesPerSecond === "number" && Number.isFinite(inbound.framesPerSecond)) {
            fps = inbound.framesPerSecond;
          }

          const now = performance.now();
          if (
            typeof inbound.framesDecoded === "number" &&
            typeof inbound.totalDecodeTime === "number" &&
            Number.isFinite(inbound.framesDecoded) &&
            Number.isFinite(inbound.totalDecodeTime)
          ) {
            const prev = streamInboundSampleRef.current;
            if (
              prev &&
              inbound.framesDecoded >= prev.framesDecoded &&
              inbound.totalDecodeTime >= prev.totalDecodeTime
            ) {
              const frameDelta = inbound.framesDecoded - prev.framesDecoded;
              const decodeDeltaMs = (inbound.totalDecodeTime - prev.totalDecodeTime) * 1000;
              const elapsedMs = now - prev.measuredAt;

              if (frameDelta > 0) {
                decodeMs = decodeDeltaMs / frameDelta;
                if (!(typeof fps === "number" && Number.isFinite(fps)) && elapsedMs > 0) {
                  fps = (frameDelta * 1000) / elapsedMs;
                }
              }
            }

            streamInboundSampleRef.current = {
              framesDecoded: inbound.framesDecoded,
              totalDecodeTime: inbound.totalDecodeTime,
              measuredAt: now,
            };
          }
        });

        setStreamMetrics({
          rttMs,
          jitterBufferMs,
          decodeMs,
          fps,
          droppedFrames,
          freezeCount,
          updatedAt: Date.now(),
        });
      } catch {
        // ignore intermittent getStats failures while reconnecting
      }
    };

    void collectStats();
    streamStatsIntervalRef.current = setInterval(() => {
      void collectStats();
    }, 1000);

    return () => {
      resetStats();
    };
  }, [streamStatus]);

  useEffect(() => {
    return () => {
      galleryRef.current.forEach((item) => {
        releaseGalleryItemResources(item);
      });
    };
  }, []);

  useEffect(() => {
    const startWebRTCStream = async () => {
      if (!videoRef.current) return;
      if (streamStartInFlightRef.current) return;
      streamStartInFlightRef.current = true;

      if (streamReconnectTimerRef.current) {
        clearTimeout(streamReconnectTimerRef.current);
        streamReconnectTimerRef.current = null;
      }

      if (pcRef.current) {
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
        pcRef.current = null;
      }

      setStreamStatus("reconnecting");

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.addTransceiver("video", { direction: "recvonly" });

      pc.ontrack = (event) => {
        if (!videoRef.current) return;
        videoRef.current.srcObject = event.streams[0];
        videoRef.current.play().catch(() => undefined);
        setStreamStatus("online");
      };

      pc.onconnectionstatechange = () => {
        if (pc !== pcRef.current) return;

        if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
          setStreamStatus("reconnecting");
          pc.ontrack = null;
          pc.onconnectionstatechange = null;
          pc.close();
          if (pcRef.current === pc) {
            pcRef.current = null;
          }
          if (!streamReconnectTimerRef.current) {
            streamReconnectTimerRef.current = setTimeout(() => {
              streamReconnectTimerRef.current = null;
              void startWebRTCStream();
            }, 2000);
          }
        }
        if (pc.connectionState === "connected") {
          setStreamStatus("online");
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      try {
        const response = await fetch(currentWhepUrl, {
          method: "POST",
          body: pc.localDescription?.sdp,
          headers: { "Content-Type": "application/sdp" },
        });

        if (!response.ok) {
          throw new Error(`WHEP failed: ${response.status}`);
        }

        const answer = await response.text();
        if (pc !== pcRef.current) {
          pc.close();
          return;
        }
        await pc.setRemoteDescription({ type: "answer", sdp: answer });
      } catch {
        setStreamStatus("reconnecting");
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.close();
        if (pcRef.current === pc) {
          pcRef.current = null;
        }
        if (!streamReconnectTimerRef.current) {
          streamReconnectTimerRef.current = setTimeout(() => {
            streamReconnectTimerRef.current = null;
            void startWebRTCStream();
          }, 3000);
        }
      } finally {
        streamStartInFlightRef.current = false;
      }
    };

    void startWebRTCStream();

    return () => {
      if (streamReconnectTimerRef.current) {
        clearTimeout(streamReconnectTimerRef.current);
        streamReconnectTimerRef.current = null;
      }
      pcRef.current?.close();
      pcRef.current = null;
      streamStartInFlightRef.current = false;
      setStreamStatus("offline");
    };
  }, [currentWhepUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPause = () => {
      video.play().catch(() => undefined);
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        video.play().catch(() => undefined);
      }
    };

    video.addEventListener("pause", onPause);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      video.removeEventListener("pause", onPause);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    const doc = document as ExtendedDocument;

    const updateFullscreen = () => {
      const isFull = !!(
        document.fullscreenElement ||
        doc.webkitFullscreenElement ||
        doc.mozFullScreenElement ||
        doc.msFullscreenElement
      );
      setIsNativeFullscreenActive(isFull);
    };

    document.addEventListener("fullscreenchange", updateFullscreen);
    document.addEventListener("webkitfullscreenchange", updateFullscreen);
    document.addEventListener("mozfullscreenchange", updateFullscreen);
    document.addEventListener("MSFullscreenChange", updateFullscreen);

    return () => {
      document.removeEventListener("fullscreenchange", updateFullscreen);
      document.removeEventListener("webkitfullscreenchange", updateFullscreen);
      document.removeEventListener("mozfullscreenchange", updateFullscreen);
      document.removeEventListener("MSFullscreenChange", updateFullscreen);
    };
  }, []);

  const handleModalWheel = (event: React.WheelEvent) => {
    if (!isModalOpen) return;
    event.preventDefault();
    const zoomSensitivity = 0.1;
    if (event.deltaY < 0) imgScaleRef.current += zoomSensitivity;
    else imgScaleRef.current -= zoomSensitivity;
    imgScaleRef.current = Math.max(0.5, Math.min(imgScaleRef.current, 5));
    updateImageTransform();
  };

  const handleModalPointerDown = (event: React.PointerEvent) => {
    if (drawMode !== "off") return;
    event.preventDefault();
    activeModalPointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    const pointerCount = activeModalPointersRef.current.size;

    if (pointerCount >= 2) {
      draggingRef.current = false;
      const pointers = Array.from(activeModalPointersRef.current.values());
      const first = pointers[0];
      const second = pointers[1];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      pinchStartDistanceRef.current = Math.max(distance, 1);
      pinchStartScaleRef.current = imgScaleRef.current;
    } else {
      draggingRef.current = true;
      startImgXRef.current = event.clientX - imgXRef.current;
      startImgYRef.current = event.clientY - imgYRef.current;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleModalPointerMove = (event: React.PointerEvent) => {
    if (drawMode !== "off") return;
    event.preventDefault();

    if (activeModalPointersRef.current.has(event.pointerId)) {
      activeModalPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
    }

    if (activeModalPointersRef.current.size >= 2) {
      const pointers = Array.from(activeModalPointersRef.current.values());
      const first = pointers[0];
      const second = pointers[1];
      const currentDistance = Math.hypot(second.x - first.x, second.y - first.y);
      const startDistance = pinchStartDistanceRef.current || currentDistance;
      const nextScale = pinchStartScaleRef.current * (currentDistance / Math.max(startDistance, 1));
      imgScaleRef.current = Math.max(0.5, Math.min(nextScale, 5));
      updateImageTransform();
      return;
    }

    if (!draggingRef.current) return;
    imgXRef.current = event.clientX - startImgXRef.current;
    imgYRef.current = event.clientY - startImgYRef.current;
    updateImageTransform();
  };

  const handleModalPointerUp = (event: React.PointerEvent) => {
    if (drawMode !== "off") return;
    activeModalPointersRef.current.delete(event.pointerId);
    pinchStartDistanceRef.current = null;
    draggingRef.current = false;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // noop
    }
  };

  const getCanvasPoint = (event: React.PointerEvent) => {
    const canvas = modalCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const applyDrawStyle = (context: CanvasRenderingContext2D) => {
    if (drawMode === "eraser") {
      context.strokeStyle = "rgba(0, 0, 0, 1)";
      context.lineWidth = eraserStrokeWidth;
      context.globalCompositeOperation = "destination-out";
      return;
    }

    if (drawMode === "highlight") {
      context.strokeStyle = hexToRgba(highlightColor, 0.45);
      context.lineWidth = highlightStrokeWidth;
      context.globalCompositeOperation = "source-over";
      return;
    }

    context.strokeStyle = hexToRgba(penColor, 0.95);
    context.lineWidth = penStrokeWidth;
    context.globalCompositeOperation = "source-over";
  };

  const handleCanvasPointerDown = (event: React.PointerEvent) => {
    if (drawMode === "off") return;
    event.preventDefault();

    const context = getCanvasContext();
    const point = getCanvasPoint(event);
    if (!context || !point) return;

    snapshotBeforeDrawRef.current = getOverlaySnapshot(modalItemId);
    pushUndoSnapshot(snapshotBeforeDrawRef.current);

    drawingRef.current = true;
    lastDrawPointRef.current = point;
    applyDrawStyle(context);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleCanvasPointerMove = (event: React.PointerEvent) => {
    if (drawMode === "off") return;
    if (!drawingRef.current) return;

    const context = getCanvasContext();
    const point = getCanvasPoint(event);
    if (!context || !point || !lastDrawPointRef.current) return;

    applyDrawStyle(context);
    context.beginPath();
    context.moveTo(lastDrawPointRef.current.x, lastDrawPointRef.current.y);
    context.lineTo(point.x, point.y);
    context.stroke();

    lastDrawPointRef.current = point;
  };

  const stopDrawing = (event: React.PointerEvent) => {
    if (drawMode === "off") return;
    drawingRef.current = false;
    lastDrawPointRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      return;
    }

    persistAnnotationsForCurrentItem();
  };

  const handleStartExperience = () => {
    setIntroLeaving(true);
    window.setTimeout(() => {
      setShowIntro(false);
    }, 700);
  };

  const autofocusPct = autofocusProgress.pct ?? 0;
  const autofocusPhase = autofocusProgress.phase;
  const isAutofocusRunning = isAutofocusActive;
  const isAutofocusDone = autofocusPhase === "done";
  const isAutofocusError = autofocusPhase === "error";

  const autofocusBtnLabel = (() => {
    if (isAutofocusRunning) return "■ STOP";
    if (isAutofocusDone) return "✓ DONE";
    if (isAutofocusError) return "✕ RETRY";
    return "AUTO";
  })();

  const autofocusBtnClass = [
    "btn-autofocus",
    isAutofocusRunning ? "is-running" : "",
    isAutofocusDone ? "is-done" : "",
    isAutofocusError ? "is-error" : "",
    !canUseAutofocus && !isAutofocusRunning ? "is-disabled" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const isMotorControlBusy = motorVisualState !== "idle" || isControlLocked;

  const buildArrowBtnClass = (canUse: boolean) => {
    const blocked = !canUse || isMotorControlBusy;
    return ["btn-arrow", blocked ? "is-disabled" : "", isMotorControlBusy ? "is-motor-busy" : ""]
      .filter(Boolean)
      .join(" ");
  };

  const buildFsBtnClass = (canUse: boolean) => {
    const blocked = !canUse || isMotorControlBusy;
    return ["fs-btn", blocked ? "is-disabled" : "", isMotorControlBusy ? "is-motor-busy" : ""]
      .filter(Boolean)
      .join(" ");
  };

  const isArrowDisabled = (canUse: boolean) => !canUse || isMotorControlBusy;

  const autofocusDirectionArrow =
    autofocusProgress.direction === "focus_in" ? "▲" :
    autofocusProgress.direction === "focus_out" ? "▼" : "";

  return (
    <>
      {showIntro && (
        <section className={`intro-screen ${introLeaving ? "is-leaving" : ""}`}>
          <div className="intro-grid" />
          <div className="intro-vignette" />
          <div className="intro-noise" />

          <div className="intro-glow intro-glow-a" />
          <div className="intro-glow intro-glow-b" />
          <div className="intro-light-beam" />

          <div className="intro-microscope" aria-hidden="true">
            <div className="microscope-ring microscope-ring-a" />
            <div className="microscope-ring microscope-ring-b" />
            <div className="microscope-scope" />
            <div className="microscope-arm" />
            <div className="microscope-lens" />
            <div className="microscope-base" />
            <div className="microscope-stand" />
          </div>

          <div className="intro-card">
            <div className="intro-logo-wrap" aria-hidden="true">
              <Image
                src="/microscope-logo.svg"
                alt="Microscope logo"
                width={38}
                height={38}
                className="intro-logo"
                priority
              />
            </div>
            <p className="intro-chip">Virtual Lab Interface</p>
            <h1 className="intro-title">Microscope Dashboard</h1>
            <p className="intro-subtitle">
              Launch a virtual laboratory environment, monitor real-time video streams, and control equipment with a cinematic experience.
            </p>

            <button className="intro-btn" onClick={handleStartExperience}>
              Get Started
            </button>
          </div>
        </section>
      )}

      <div className="app-container">
        <aside className="sidebar">
          <div className="title">
            <h2>DASHBOARD</h2>
            <div className="status-badges">
              <span className={`status-pill status-${controlStatus}`}>
                Control: {controlStatus}
              </span>
              <span className={`status-pill status-${streamStatus}`}>
                Stream: {streamStatus}
              </span>
              <span className={`status-pill status-${motorVisualState}`}>
                Motor: {motorVisualState}
              </span>
            </div>
          </div>

          <section className="gallery-section">
            <h3>LIST PHOTOS</h3>
            <div id="screenshot-gallery" className="gallery">
              {gallery.map((item, index) => (
                <div key={item.id} className="gallery-item">
                  <div className="gallery-caption">
                    <button
                      className="gallery-name-btn"
                      onClick={() => handleRename(item.id, item.label)}
                      title="Đổi tên ảnh"
                    >
                      {getDisplayName(item, index)}
                    </button>
                  </div>
                  <Image
                    src={item.src}
                    alt="Screenshot"
                    width={640}
                    height={360}
                    unoptimized
                  />
                  <div className="gallery-overlay">
                    <button
                      className="icon-btn"
                      onClick={() => openModal(item.id, item.src)}
                      title="Phóng to ảnh"
                    >
                      🔍
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => handleDownload(item, index)}
                      title="Tải ảnh về máy"
                    >
                      ⬇️
                    </button>
                    <button
                      className="icon-btn delete-btn"
                      onClick={() => handleDelete(item.id)}
                      title="Xóa hình ảnh"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="control-section">
            <div className={`control-box${isMotorControlBusy ? " is-motor-busy" : ""}`}>
              <div className={`d-pad-grid${isMotorControlBusy ? " is-motor-busy" : ""}`}>
                <div className="d-pad-empty" />
                <button
                  className={buildArrowBtnClass(canMoveUp)}
                  disabled={isArrowDisabled(canMoveUp)}
                  onPointerDown={onXyControlPointerDown("up")}
                  onClick={onXyControlClick("up")}
                >
                  ↑
                </button>
                <div className="d-pad-empty" />

                <button
                  className={buildArrowBtnClass(canMoveLeft)}
                  disabled={isArrowDisabled(canMoveLeft)}
                  onPointerDown={onXyControlPointerDown("left")}
                  onClick={onXyControlClick("left")}
                >
                  ←
                </button>
                <div className="d-pad-empty" />
                <button
                  className={buildArrowBtnClass(canMoveRight)}
                  disabled={isArrowDisabled(canMoveRight)}
                  onPointerDown={onXyControlPointerDown("right")}
                  onClick={onXyControlClick("right")}
                >
                  →
                </button>

                <div className="d-pad-empty" />
                <button
                  className={buildArrowBtnClass(canMoveDown)}
                  disabled={isArrowDisabled(canMoveDown)}
                  onPointerDown={onXyControlPointerDown("down")}
                  onClick={onXyControlClick("down")}
                >
                  ↓
                </button>
                <div className="d-pad-empty" />
              </div>
              <div className="xy-pos">
                <div className="xy-pos-label">POS</div>
                <div className="xy-pos-values">
                  X: {xyPositionLabel.x} · Y: {xyPositionLabel.y}
                </div>
                {xyBlockReason && (
                  <div className="xy-block-reason">{xyBlockReason}</div>
                )}
              </div>
            </div>

            <div className={`control-box focus-container${isMotorControlBusy ? " is-motor-busy" : ""}`}>
              <div className={`focus-col${isMotorControlBusy ? " is-motor-busy" : ""}`}>
                <div className="focus-label">FOCUS</div>
                <div className="focus-rail-wrap">
                  <div className="focus-rail-track">
                    <div className="focus-rail-fill" style={{ width: `${encoderProgressPercent}%` }} />
                    <div className="focus-rail-marker" style={{ left: `${encoderProgressPercent}%` }}>
                      <span className="focus-rail-marker-arrow">▼</span>
                      <span className="focus-rail-marker-dot" />
                    </div>
                  </div>
                  <div className="focus-rail-labels">
                    <span>MIN</span>
                    <span>MAX</span>
                  </div>
                  <div className="focus-rail-value">POS: {encoderPositionLabel}</div>
                </div>
                <div className="focus-pos-readout">{focusStatusText}</div>

                {focusCommands.map((focus) => {
                  const canUseFocus =
                    focus.cmd === "focus_in" ? canUseFocusIn : canUseFocusOut;
                  return (
                  <button
                    key={focus.cmd}
                    className={buildArrowBtnClass(canUseFocus)}
                    disabled={isArrowDisabled(canUseFocus)}
                    onPointerDown={onFocusControlPointerDown(focus.cmd as "focus_in" | "focus_out")}
                    onClick={onFocusControlClick(focus.cmd as "focus_in" | "focus_out")}
                  >
                    {focus.label}
                  </button>
                  );
                })}

                <div className="autofocus-wrap">
                  <button
                    className={autofocusBtnClass}
                    disabled={!isAutofocusRunning && !canUseAutofocus}
                    onClick={isAutofocusRunning ? cancelAutofocus : requestAutofocus}
                    title={isAutofocusRunning ? "Nhấn để dừng autofocus" : "Tự động lấy nét về vùng rõ nét"}
                    aria-label={isAutofocusRunning ? "Cancel autofocus" : "Run autofocus"}
                  >
                    {isAutofocusRunning && (
                      <span
                        className="autofocus-progress-fill"
                        style={{ width: `${autofocusPct}%` }}
                        aria-hidden="true"
                      />
                    )}

                    {isAutofocusRunning && (
                      <span className="autofocus-scan-line" aria-hidden="true" />
                    )}

                    <span className="autofocus-btn-inner">
                      <span className="autofocus-icon" aria-hidden="true">
                        {isAutofocusRunning ? (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" className="autofocus-spin-ring" />
                            <circle cx="7" cy="7" r="2" fill="currentColor" />
                          </svg>
                        ) : isAutofocusDone ? (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M3 7l3 3 5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : isAutofocusError ? (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M4 4l6 6M10 4l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                          </svg>
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <circle cx="7" cy="7" r="2" fill="currentColor" />
                            <path d="M7 1v2M7 11v2M1 7h2M11 7h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1" opacity="0.5" />
                          </svg>
                        )}
                      </span>

                      <span className="autofocus-label">{autofocusBtnLabel}</span>

                      {isAutofocusRunning && autofocusDirectionArrow && (
                        <span className="autofocus-direction" aria-hidden="true">
                          {autofocusDirectionArrow}
                        </span>
                      )}
                    </span>

                    {isAutofocusRunning && autofocusPct > 0 && (
                      <span className="autofocus-pct-badge" aria-live="polite">
                        {autofocusPct}%
                      </span>
                    )}
                  </button>

                  <div className="autofocus-sublabel" aria-live="polite">
                    {isAutofocusRunning && (
                      <>
                        <span className="autofocus-sublabel-dot" />
                        {autofocusProgress.current !== null && autofocusProgress.target !== null
                          ? `${Math.round(autofocusProgress.current ?? 0)} → ${autofocusProgress.target}`
                          : "Đang di chuyển..."}
                      </>
                    )}
                    {isAutofocusDone && "✓ Đã lấy nét"}
                    {isAutofocusError && `✕ ${autofocusProgress.reason ?? "Lỗi"}`}
                    {!isAutofocusRunning && !isAutofocusDone && !isAutofocusError && "Tự động lấy nét"}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </aside>

        <main className="main-content">
          <div
            id="video-wrapper"
            ref={wrapperRef}
            className={`video-container motor-${motorVisualState} ${isFakeFullscreen ? "fake-fullscreen" : ""} ${isFakeFullscreen || isNativeFullscreenActive ? "show-osd" : ""}`}
          >
            <video
              id="stream-player"
              ref={videoRef}
              playsInline
              muted
            />

            <div className="video-actions-overlay">
              <button
                className="video-action-btn video-action-center"
                id="btn-screenshot"
                onClick={handleScreenshot}
                title="Screenshot"
              >
                📸
              </button>
              <button
                className="video-action-btn video-action-right"
                id="btn-fullscreen"
                onClick={handleFullscreenToggle}
                title={isFakeFullscreen || isNativeFullscreenActive ? "Exit fullscreen" : "Fullscreen"}
              >
                {isFakeFullscreen || isNativeFullscreenActive ? "⤡" : "⤢"}
              </button>
            </div>

            <div className="stream-metrics-overlay" aria-live="polite">
              <div className="stream-metrics-title">WEBRTC LIVE</div>
              <div className="stream-metrics-line">RTT: {formatMetricMs(streamMetrics.rttMs)}</div>
              <div className="stream-metrics-line">Jitter Buffer: {formatMetricMs(streamMetrics.jitterBufferMs)}</div>
              <div className="stream-metrics-line">Decode/frame: {formatMetricMs(streamMetrics.decodeMs)}</div>
              <div className="stream-metrics-line">FPS: {formatMetricFps(streamMetrics.fps)}</div>
              <div className="stream-metrics-line">Dropped: {formatMetricCount(streamMetrics.droppedFrames)}</div>
              <div className="stream-metrics-line">Freeze: {formatMetricCount(streamMetrics.freezeCount)}</div>
            </div>

            <div className="fullscreen-overlay">
              <div className="fs-group-left">
                <div className={`fs-col${isMotorControlBusy ? " is-motor-busy" : ""}`}>
                  <div className="fs-label">MOVE</div>
                  <div className={`fs-d-pad-grid${isMotorControlBusy ? " is-motor-busy" : ""}`}>
                    <div className="fs-d-pad-empty" />
                    <button
                      className={buildFsBtnClass(canMoveUp)}
                      disabled={isArrowDisabled(canMoveUp)}
                      onPointerDown={onXyControlPointerDown("up")}
                      onClick={onXyControlClick("up")}
                    >
                      ↑
                    </button>
                    <div className="fs-d-pad-empty" />

                    <button
                      className={buildFsBtnClass(canMoveLeft)}
                      disabled={isArrowDisabled(canMoveLeft)}
                      onPointerDown={onXyControlPointerDown("left")}
                      onClick={onXyControlClick("left")}
                    >
                      ←
                    </button>
                    <div className="fs-d-pad-empty" />
                    <button
                      className={buildFsBtnClass(canMoveRight)}
                      disabled={isArrowDisabled(canMoveRight)}
                      onPointerDown={onXyControlPointerDown("right")}
                      onClick={onXyControlClick("right")}
                    >
                      →
                    </button>

                    <div className="fs-d-pad-empty" />
                    <button
                      className={buildFsBtnClass(canMoveDown)}
                      disabled={isArrowDisabled(canMoveDown)}
                      onPointerDown={onXyControlPointerDown("down")}
                      onClick={onXyControlClick("down")}
                    >
                      ↓
                    </button>
                    <div className="fs-d-pad-empty" />
                  </div>
                </div>
              </div>

              <div className="fs-group-right">
                <div className="fs-col">
                  <div className="fs-label">FOCUS</div>
                  {focusCommands.map((focus) => {
                    const canUseFocus =
                      focus.cmd === "focus_in" ? canUseFocusIn : canUseFocusOut;
                    return (
                    <button
                      key={`fs-${focus.cmd}`}
                      className={buildFsBtnClass(canUseFocus)}
                      disabled={isArrowDisabled(canUseFocus)}
                      onPointerDown={onFocusControlPointerDown(focus.cmd as "focus_in" | "focus_out")}
                      onClick={onFocusControlClick(focus.cmd as "focus_in" | "focus_out")}
                    >
                      {focus.label}
                    </button>
                    );
                  })}
                  <button
                    className={`fs-btn fs-autofocus-btn ${isAutofocusRunning ? "is-running" : ""} ${isAutofocusDone ? "is-done" : ""}`}
                    disabled={!isAutofocusRunning && !canUseAutofocus}
                    onClick={isAutofocusRunning ? cancelAutofocus : requestAutofocus}
                    title={isAutofocusRunning ? "Dừng autofocus" : "Auto focus"}
                  >
                    {isAutofocusRunning ? `■ ${autofocusPct > 0 ? `${autofocusPct}%` : "STOP"}` : isAutofocusDone ? "✓" : "AUTO"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </main>

        <div
          id="image-modal"
          ref={modalRef}
          className={`modal ${isModalOpen ? "" : "hidden"}`}
          onClick={(event) => {
            if (event.target === modalRef.current) closeModal();
          }}
          onWheel={handleModalWheel}
        >
          {modalSrc && (
            <div className="modal-toolbar">
              <button
                className={`modal-tool-btn ${drawMode === "pen" ? "is-active" : ""}`}
                onClick={() => setDrawMode((prev) => (prev === "pen" ? "off" : "pen"))}
                title="Vẽ nét"
              >
                ✏️ Vẽ
              </button>
              <button
                className={`modal-tool-btn ${drawMode === "highlight" ? "is-active" : ""}`}
                onClick={() =>
                  setDrawMode((prev) => (prev === "highlight" ? "off" : "highlight"))
                }
                title="Highlight"
              >
                🖍️ Highlight
              </button>
              <button
                className={`modal-tool-btn ${drawMode === "eraser" ? "is-active" : ""}`}
                onClick={() => setDrawMode((prev) => (prev === "eraser" ? "off" : "eraser"))}
                title="Tẩy từng phần"
              >
                🩹 Tẩy
              </button>

              <label className="color-picker-control" title="Chọn màu nét vẽ/highlight">
                🎨
                <input
                  type="color"
                  className="color-picker-input"
                  value={activeColor}
                  onChange={(event) => {
                    const color = event.target.value;
                    if (drawMode === "highlight") {
                      setHighlightColor(color);
                      return;
                    }
                    setPenColor(color);
                  }}
                  disabled={drawMode === "off" || drawMode === "eraser"}
                />
              </label>
              <button
                className="modal-tool-btn"
                onClick={handleUndoAnnotation}
                disabled={undoStack.length === 0}
                title="Undo nét vẽ"
              >
                ↶ Undo
              </button>

              <button
                className="modal-tool-btn"
                onClick={handleRedoAnnotation}
                disabled={redoStack.length === 0}
                title="Redo nét vẽ"
              >
                ↷ Redo
              </button>

              <button
                className="modal-tool-btn"
                onClick={clearAnnotations}
                title="Xóa toàn bộ nét vẽ"
              >
                🧽 Xóa hết
              </button>

              <div className="stroke-size-control" aria-label="Điều chỉnh độ dày nét">
                <button
                  className="modal-tool-btn stroke-size-btn"
                  onClick={() => changeStrokeWidth(-1)}
                  disabled={drawMode === "off"}
                  title="Giảm độ dày nét"
                >
                  －
                </button>
                <span className="stroke-size-value">
                  {activeStrokeWidth}px
                </span>
                <button
                  className="modal-tool-btn stroke-size-btn"
                  onClick={() => changeStrokeWidth(1)}
                  disabled={drawMode === "off"}
                  title="Tăng độ dày nét"
                >
                  ＋
                </button>
              </div>
            </div>
          )}

          <span className="close-modal" onClick={closeModal}>
            ×
          </span>
          {modalSrc && (
            <div className="modal-stage">
              <Image
                id="expanded-img"
                ref={modalImgRef}
                src={modalSrc}
                alt="Expanded"
                width={1280}
                height={720}
                unoptimized
                className={`modal-content ${drawMode !== "off" ? "is-drawing-mode" : ""}`}
                onLoad={setupAnnotationCanvas}
                onPointerDown={handleModalPointerDown}
                onPointerMove={handleModalPointerMove}
                onPointerUp={handleModalPointerUp}
                onPointerCancel={handleModalPointerUp}
              />
              <canvas
                ref={modalCanvasRef}
                className={`modal-draw-canvas ${drawMode !== "off" ? "is-active" : ""} ${drawMode === "eraser" ? "mode-eraser" : ""}`}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={stopDrawing}
                onPointerCancel={stopDrawing}
              />
            </div>
          )}
        </div>
      </div>

      {downloadChoiceTarget && (
        <div
          className="download-choice-backdrop"
          onClick={closeDownloadChoice}
        >
          <div
            className="download-choice-card"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Chọn kiểu lưu ảnh</h3>
            <p>
              {annotationByItemId[downloadChoiceTarget.id]
                ? "Ảnh này có nét vẽ. Bạn muốn lưu bản nào?"
                : "Ảnh này chưa có nét vẽ, bạn có thể lưu ảnh gốc hoặc hủy."}
            </p>
            <div className="download-choice-actions">
              <button
                className="download-choice-btn is-primary"
                onClick={handleSaveEditedImage}
                disabled={!annotationByItemId[downloadChoiceTarget.id]}
              >
                Lưu ảnh chỉnh sửa
              </button>
              <button
                className="download-choice-btn"
                onClick={handleSaveOriginalImage}
              >
                Lưu ảnh gốc
              </button>
              <button
                className="download-choice-btn is-ghost"
                onClick={closeDownloadChoice}
              >
                Hủy
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}