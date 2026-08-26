import { describe, it, expect, vi, beforeEach } from "vitest";
import { recommendQuant, getBadge, MODEL_FILE_MAP, detectHardwareSync, downloadModel } from "./wizard";
import type { HardwareInfo } from "./wizard";

describe("hardware -> quant recommendation", () => {
  it("low ram 4GB -> Q4", () => {
    const hw: HardwareInfo = { cpuCores: 4, ramGB: 4, vramGB: null, gpuName: null, tier: "low" };
    expect(recommendQuant(hw)).toBe("Q4");
  });
  it("8GB -> Q5", () => {
    const hw: HardwareInfo = { cpuCores: 8, ramGB: 8, vramGB: null, gpuName: null, tier: "mid" };
    expect(recommendQuant(hw)).toBe("Q5");
  });
  it("16GB -> Q8", () => {
    const hw: HardwareInfo = { cpuCores: 8, ramGB: 16, vramGB: null, gpuName: null, tier: "high" };
    expect(recommendQuant(hw)).toBe("Q8");
  });
  it("prefers vram over ram", () => {
    const hw: HardwareInfo = { cpuCores: 4, ramGB: 32, vramGB: 4, gpuName: null, tier: "low" };
    expect(recommendQuant(hw)).toBe("Q4");
  });
});

describe("fits/needs badge", () => {
  it("Q4 fits on 4GB", () => {
    expect(getBadge("Q4", { cpuCores: 4, ramGB: 4, vramGB: null, gpuName: null, tier: "low" })).toBe("fits");
  });
  it("Q5 fits on 8GB, needs on 4GB", () => {
    const low: HardwareInfo = { cpuCores: 4, ramGB: 4, vramGB: null, gpuName: null, tier: "low" };
    const mid: HardwareInfo = { cpuCores: 4, ramGB: 8, vramGB: null, gpuName: null, tier: "mid" };
    expect(getBadge("Q5", low)).toBe("needs");
    expect(getBadge("Q5", mid)).toBe("fits");
  });
  it("Q8 needs on 8GB, fits on 16GB", () => {
    const mid: HardwareInfo = { cpuCores: 4, ramGB: 8, vramGB: null, gpuName: null, tier: "mid" };
    const high: HardwareInfo = { cpuCores: 4, ramGB: 16, vramGB: null, gpuName: null, tier: "high" };
    expect(getBadge("Q8", mid)).toBe("needs");
    expect(getBadge("Q8", high)).toBe("fits");
  });
});

describe("MODEL_FILE_MAP", () => {
  it("Q4 file contains q4 and gguf", () => {
    expect(MODEL_FILE_MAP.Q4).toMatch(/q4/i);
    expect(MODEL_FILE_MAP.Q4).toMatch(/\.gguf$/);
  });
  it("has Q4/Q5/Q8 entries for Qwen2.5-1.5B", () => {
    expect(MODEL_FILE_MAP.Q4).toBeTruthy();
    expect(MODEL_FILE_MAP.Q5).toBeTruthy();
    expect(MODEL_FILE_MAP.Q8).toBeTruthy();
  });
});

describe("detectHardwareSync", () => {
  it("returns expected shape", () => {
    const h = detectHardwareSync();
    expect(h).toHaveProperty("cpuCores");
    expect(h).toHaveProperty("ramGB");
    expect(h).toHaveProperty("tier");
    expect(["low", "mid", "high"]).toContain(h.tier);
  });
});

describe("downloadModel one-click Q4", () => {
  beforeEach(() => vi.restoreAllMocks());
  it("calls window.api.downloadModel when available", async () => {
    const dl = vi.fn().mockResolvedValue("ok");
    (globalThis as unknown as Record<string, unknown>).window = { api: { downloadModel: dl } } as unknown as Window & typeof globalThis;
    await downloadModel("Q4");
    expect(dl).toHaveBeenCalled();
    const [, file] = dl.mock.calls[0] as [string, string];
    expect(file).toMatch(/q4/i);
    delete (globalThis as unknown as Record<string, unknown>).window;
  });
  it("fallback opens huggingface url for Qwen2.5-1.5B-Q4", async () => {
    const openSpy = vi.fn();
    (globalThis as unknown as Record<string, unknown>).window = { open: openSpy } as unknown as Window & typeof globalThis;
    const url = await downloadModel("Q4");
    expect(url).toMatch(/huggingface\.co/);
    expect(url).toMatch(/q4/i);
    delete (globalThis as unknown as Record<string, unknown>).window;
  });
});

describe("wizard component import", () => {
  it("Wizard is importable", async () => {
    const mod = await import("./wizard");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });
});
