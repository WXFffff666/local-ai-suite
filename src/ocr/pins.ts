/**
 * pins.ts — pinned OCR engine distribution (todo37).
 *
 * Transport decision (Appendix R3 §A row 37 pre-verification, evidence
 * .omo/evidence/task-37): hiroi-sora/PaddleOCR-json v1.4.1 VERIFIED LIVE —
 * repo exists, Apache-2.0, release asset + stdin/stdout JSON-lines protocol
 * exercised end-to-end against the real exe (base64 in, {"code":100,...} out).
 * The RapidOCR/onnxruntime-node fallback stays planned-but-unneeded.
 *
 * Why self-contained pins instead of src/engines/manifest.ts PINS:
 * manifest.ts owns EngineBinary = llama|ollama|sd (resolver/engineWire churn
 * across the merged engines lane — todo37 is blocked-by-30 but must not edit
 * its union). The OCR engine is NOT bundled in the installer (92.7 MB >
 * pack-size red line, plan "绝不捆绑"): it downloads on demand into
 * <userData>/engines/ocr-cpu via the SAME primitives gpuPack exports
 * (ndhDownloader / sha256File / activatePack / quarantine flow), so
 * integrity policy stays single-sourced while the manifest union stays frozen.
 *
 * Pin provenance (all measured 2026-09-04, see evidence file):
 *   asset    PaddleOCR-json_v1.4.1_windows_x64.7z  92,736,768 bytes
 *   sha256   Get-FileHash of the downloaded asset (matches GH API size)
 *   exe sha  Get-FileHash of PaddleOCR-json.exe after tar -xf extraction
 *   protocol docs/详细使用指南.md @1beac1c: one JSON line in → exactly one
 *            JSON line out; keys image_path | image_base64; ready handshake
 *            "OCR init completed."; bare "exit" quits (code 0).
 */

export const OCR_ENGINE_KEY = 'ocr' as const
/** gpuPack packDirName(`${engine}-${variant}`) → <userData>/engines/ocr-cpu */
export const OCR_PACK_VARIANT = 'cpu' as const
export const OCR_ENGINE_VERSION = 'v1.4.1' as const
/** Release asset (7z, NOT zip — verified via GitHub API). */
export const OCR_ASSET_FILE = `PaddleOCR-json_${OCR_ENGINE_VERSION}_windows_x64.7z` as const
export const OCR_ASSET_URL =
  `https://github.com/hiroi-sora/PaddleOCR-json/releases/download/${OCR_ENGINE_VERSION}/${OCR_ASSET_FILE}` as const
/** sha256 (lowercase hex) of the .7z archive — gate BEFORE extraction. */
export const OCR_ASSET_SHA256 = 'c0912a70acb1f8f18fafe1f438a2935292a6ec7e2859156fa48a33e91358d71d' as const
/** Top-level directory inside the archive. */
export const OCR_ARCHIVE_TOPDIR = `PaddleOCR-json_${OCR_ENGINE_VERSION}` as const
/** Engine exe inside the pack (CMake DEMO_NAME "PaddleOCR-json", verified by run). */
export const OCR_EXE_FILE = 'PaddleOCR-json.exe' as const
/** sha256 of the exe as extracted from the pinned archive — pre-spawn integrity gate. */
export const OCR_EXE_SHA256 = '965e5249ba6bf883004532434e7983de41d737b70335d1d64c56788822a019b6' as const
/** The pinned pack is a Windows x64 build; other platforms report honest unavailable. */
export const OCR_SUPPORTED_PLATFORM = 'win32' as const
export const OCR_SUPPORTED_ARCH = 'x64' as const
/** Env override tier (whisper WHISPER_BIN precedent). */
export const OCR_BIN_ENV = 'OCR_BIN' as const
