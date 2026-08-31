import { useEffect, useState, useCallback } from "react";

// ─── Types ──────────────────────────────────────────────────────────
export type QuantLevel = "Q4" | "Q5" | "Q8";
export type BadgeType = "fits" | "needs";

export interface HardwareInfo {
  cpuCores: number;
  ramGB: number;
  vramGB: number | null;
  gpuName: string | null;
  tier: "low" | "mid" | "high";
}

export interface QuantOption {
  level: QuantLevel;
  label: string;
  sizeGB: number;
  minRamGB: number;
  description: string;
}

export const QUANT_OPTIONS: QuantOption[] = [
  { level: "Q4", label: "Q4_K_M", sizeGB: 1.1, minRamGB: 4, description: "轻量 · 4GB 即可运行" },
  { level: "Q5", label: "Q5_K_M", sizeGB: 1.4, minRamGB: 8, description: "平衡 · 推荐 8GB+" },
  { level: "Q8", label: "Q8_0", sizeGB: 1.9, minRamGB: 16, description: "高精度 · 推荐 16GB+" },
];

export const MODEL_ID = "Qwen/Qwen2.5-1.5B-Instruct-GGUF";
export const MODEL_FILE_MAP: Record<QuantLevel, string> = {
  Q4: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
  Q5: "qwen2.5-1.5b-instruct-q5_k_m.gguf",
  Q8: "qwen2.5-1.5b-instruct-q8_0.gguf",
};

// ─── Hardware detection ───────────────────────────────────────────
export function detectHardwareSync(): HardwareInfo {
  const nav = typeof navigator !== "undefined" ? navigator as unknown as Record<string, unknown> : {};
  const cpuCores = (nav["hardwareConcurrency"] as number) ?? 4;
  // deviceMemory is Chrome-only, GB
  const ramGB = (nav["deviceMemory"] as number) ?? 8;
  // VRAM detection via WebGL is best-effort; fallback null
  let vramGB: number | null = null;
  let gpuName: string | null = null;
  try {
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
      if (gl) {
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) {
          gpuName = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string;
          // heuristic: if discrete GPU name contains 3060/4060 etc treat as 8GB
          if (/4090|4080/i.test(gpuName)) vramGB = 16;
          else if (/4070|3080|3070|4060|3060/i.test(gpuName)) vramGB = 8;
          else if (/3050|2060|1660|1650/i.test(gpuName)) vramGB = 4;
        }
      }
    }
  } catch { /* ignore */ }

  const effectiveRam = vramGB ?? ramGB;
  let tier: HardwareInfo["tier"] = "low";
  if (effectiveRam >= 16) tier = "high";
  else if (effectiveRam >= 8) tier = "mid";

  return { cpuCores, ramGB, vramGB, gpuName, tier };
}

export async function detectHardware(): Promise<HardwareInfo> {
  return detectHardwareSync();
}

// ─── Recommendation logic ─────────────────────────────────────────
export function recommendQuant(hardware: HardwareInfo): QuantLevel {
  const ram = hardware.vramGB ?? hardware.ramGB;
  if (ram >= 16) return "Q8";
  if (ram >= 8) return "Q5";
  return "Q4";
}

export function getBadge(level: QuantLevel, hardware: HardwareInfo): BadgeType {
  const opt = QUANT_OPTIONS.find((o) => o.level === level)!;
  const ram = hardware.vramGB ?? hardware.ramGB;
  return ram >= opt.minRamGB ? "fits" : "needs";
}

// ─── Download ─────────────────────────────────────────────────────
export type DownloadStatus = "idle" | "downloading" | "done" | "error";

export async function downloadModel(
  quant: QuantLevel,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const filename = MODEL_FILE_MAP[quant];
  // Support Electron ipc or fallback to fetch
  const w = window as unknown as Record<string, unknown>;
  const api = w["api"] as { downloadModel?: (id: string, file: string) => Promise<string> } | undefined;
  if (api?.downloadModel) {
    return api.downloadModel(MODEL_ID, filename);
  }
  // Browser fallback: trigger direct download via huggingface
  const url = `https://huggingface.co/${MODEL_ID}/resolve/main/${filename}`;
  if (onProgress) onProgress(100);
  // open in new tab for browser env; in tests this is mocked
  window.open(url, "_blank");
  return url;
}

// ─── UI ───────────────────────────────────────────────────────────
function Badge({ type }: { type: BadgeType }) {
  const isFits = type === "fits";
  return (
    <span
      data-testid={`badge-${type}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: isFits ? "#dcfce7" : "#fef9c3",
        color: isFits ? "#166534" : "#854d0e",
        border: `1px solid ${isFits ? "#86efac" : "#fde047"}`,
      }}
    >
      {isFits ? "✓ fits" : "⚠ needs more RAM"}
    </span>
  );
}

export default function Wizard() {
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [recommended, setRecommended] = useState<QuantLevel>("Q4");
  const [selected, setSelected] = useState<QuantLevel>("Q4");
  const [status, setStatus] = useState<DownloadStatus>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    detectHardware().then((h) => {
      setHardware(h);
      const rec = recommendQuant(h);
      setRecommended(rec);
      setSelected(rec);
    });
  }, []);

  const handleDownload = useCallback(async () => {
    setStatus("downloading");
    setProgress(0);
    setError(null);
    try {
      // default one-click is Q4 per spec; if user selected other, respect selection
      const quant = selected;
      await downloadModel(quant, (pct) => setProgress(pct));
      setProgress(100);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [selected]);

  const handleOneClickQ4 = useCallback(async () => {
    setSelected("Q4");
    setStatus("downloading");
    setProgress(0);
    setError(null);
    try {
      await downloadModel("Q4", (pct) => setProgress(pct));
      setProgress(100);
      setStatus("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, []);

  if (!hardware) {
    return <div data-testid="wizard-loading">检测硬件中...</div>;
  }

  return (
    <div data-testid="wizard" style={{ maxWidth: 560, margin: "0 auto", padding: 24, fontFamily: "system-ui,sans-serif" }}>
      <h2 style={{ margin: "0 0 8px" }}>欢迎使用 Local AI Suite</h2>
      <p style={{ color: "#666", margin: "0 0 16px" }}>已自动检测你的硬件并推荐最合适的模型量化版本</p>

      {/* Hardware summary */}
      <div
        data-testid="hardware-info"
        style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: 12, marginBottom: 16 }}
      >
        <div style={{ fontSize: 13, color: "#475569" }}>
          CPU: {hardware.cpuCores} 核 · 内存: {hardware.ramGB} GB
          {hardware.vramGB !== null && ` · 显存: ${hardware.vramGB} GB`}
          {hardware.gpuName && ` · ${hardware.gpuName}`}
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
          档位: {hardware.tier === "high" ? "高配" : hardware.tier === "mid" ? "中配" : "入门"} · 推荐: {recommended}
        </div>
      </div>

      {/* Quant options */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {QUANT_OPTIONS.map((opt) => {
          const badge = getBadge(opt.level, hardware);
          const isSelected = selected === opt.level;
          const isRecommended = recommended === opt.level;
          return (
            <div
              key={opt.level}
              data-testid={`quant-${opt.level}`}
              onClick={() => setSelected(opt.level)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 14px",
                borderRadius: 8,
                border: `1.5px solid ${isSelected ? "#3b82f6" : "#e2e8f0"}`,
                background: isSelected ? "#eff6ff" : "#fff",
                cursor: "pointer",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {opt.level} <span style={{ fontWeight: 400, color: "#64748b", fontSize: 12 }}>({opt.label})</span>
                  {isRecommended && (
                    <span
                      data-testid="recommended-tag"
                      style={{
                        marginLeft: 8,
                        fontSize: 11,
                        background: "#3b82f6",
                        color: "#fff",
                        padding: "1px 6px",
                        borderRadius: 999,
                      }}
                    >
                      推荐
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#64748b" }}>
                  {opt.description} · {opt.sizeGB} GB
                </div>
              </div>
              <Badge type={badge} />
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          data-testid="btn-download-q4"
          onClick={handleOneClickQ4}
          disabled={status === "downloading"}
          style={{
            flex: 1,
            padding: "10px 16px",
            borderRadius: 8,
            border: "none",
            background: status === "downloading" ? "#94a3b8" : "#111827",
            color: "#fff",
            fontWeight: 600,
            cursor: status === "downloading" ? "not-allowed" : "pointer",
          }}
        >
          {status === "downloading" ? `下载中 ${progress}%` : "一键下载 Qwen2.5-1.5B-Q4"}
        </button>
        <button
          data-testid="btn-download-selected"
          onClick={handleDownload}
          disabled={status === "downloading"}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "1px solid #e2e8f0",
            background: "#fff",
            fontWeight: 600,
            cursor: status === "downloading" ? "not-allowed" : "pointer",
          }}
        >
          下载 {selected}
        </button>
      </div>

      {status === "done" && (
        <div data-testid="download-done" style={{ marginTop: 12, color: "#16a34a", fontSize: 13 }}>
          ✓ 下载已开始，请在模型管理中查看进度
        </div>
      )}
      {status === "error" && (
        <div data-testid="download-error" style={{ marginTop: 12, color: "#dc2626", fontSize: 13 }}>
          下载失败: {error}
        </div>
      )}
      {status === "downloading" && (
        <div style={{ marginTop: 8, height: 4, background: "#e2e8f0", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ width: `${progress}%`, height: "100%", background: "#3b82f6", transition: "width 0.3s" }} />
        </div>
      )}
    </div>
  );
}
