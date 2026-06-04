# Endstop + Homing Software Contract (P1)

This document defines the stable contract between firmware, backend, and frontend for MIN/MAX endstop safety and automatic homing.

## 1) Electrical assumptions
- Endstops: `KW11-B` (3-pin, `COM/NO/NC`), wired as **NC fail-safe**.
- Logic level on MCU input: **active-low trigger**.
- Recommended hardware debounce: `10k` pull-up + `100nF` to GND per line.

## 2) Runtime state model
Backend/frontend use these normalized states:
- `UNKNOWN`: no valid homing status yet.
- `AUTO_HOMING`: firmware is currently running auto-homing sequence.
- `READY`: homing complete, safe for normal focus control.
- `FAULT`: endstop/homing fault; normal focus control blocked.

## 3) UART messages from firmware
Firmware emits these lines on UART:
- `ENDSTOP:MIN:TRIGGERED|RELEASED`
- `ENDSTOP:MAX:TRIGGERED|RELEASED`
- `HOME_STATE:STARTED|DONE|FAILED`
- `POS_VALID:0|1`
- `ERR:ENDSTOP_FAULT`

## 4) Backend normalize rules
- `HOME_STATE:STARTED` => homing state `AUTO_HOMING`.
- `HOME_STATE:DONE` => homing state `READY` and positioning `homed=true`.
- `HOME_STATE:FAILED` => homing state `FAULT`.
- `ERR:ENDSTOP_FAULT` => homing state `FAULT`, reject reason `endstop_fault`.
- `POS_VALID:0` does not auto-trigger homing by itself; used as quality signal.

## 5) Control reject reasons (stable API)
When blocking focus commands, backend uses:
- `auto_homing_in_progress`
- `endstop_fault`
- `min_limit`
- `max_limit`

## 6) UX policy
- User-facing operation remains: `SYNC POS` refreshes displayed position only.
- User does not perform normal homing manually.
- Optional `RECOVERY HOME` appears only when fault states are active (phase after P1/P2).
