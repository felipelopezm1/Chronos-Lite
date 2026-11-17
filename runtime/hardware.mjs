// The hardware sense: how much VRAM, RAM and CPU the box has right now.
// On Linux every number is read live from sysfs and /proc, so the brains
// decide against the machine as it is and not as it was. On macOS and
// Windows the numbers come from the systems' own tools (vm_stat, sysctl,
// system_profiler; PowerShell CIM and nvidia-smi), each run with a short
// timeout and kept for a few seconds so the 2-second tick stays cheap.
// A number that cannot be read is null, never a guess, and nothing throws.

import { execFile, execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import os from "node:os";

const MiB = 1024 * 1024;

// A small discrete GPU reports its VRAM in sysfs; the integrated one is tiny.
// The card with more than 2 GiB is the one we may fill.
const MIN_REAL_VRAM_MIB = 2048;

function readNumber(path) {
  try {
    return Number(readFileSync(path, "utf8").trim());
  } catch {
    return NaN;
  }
}

// ---- outside commands: short, cached, and quiet when missing

const runs = new Map();
/** a command missing on this system is not asked again for this long */
const MISSING_TTL_MS = 60_000;
/** a command that failed or timed out is asked again after this long at most, however long its answer would be kept */
const FAILED_TTL_MS = 30_000;
const keepFor = (err, ttlMs) => (err?.code === "ENOENT" ? MISSING_TTL_MS : err ? Math.min(ttlMs, FAILED_TTL_MS) : ttlMs);

/**
 * The stdout of a command, or null when it is missing, fails or times out.
 * The first ask runs it once, synchronously, with a short timeout; after that
 * the answer is kept for ttlMs, and a stale answer is returned at once while
 * a fresh one is fetched in the background.
 */
export function runCached(cmd, args = [], { timeoutMs = 2000, ttlMs = 5000 } = {}) {
  const key = [cmd, ...args].join("\0");
  const now = Date.now();
  const hit = runs.get(key);
  if (hit && now < hit.until) return hit.out;
  const opts = { timeout: timeoutMs, encoding: "utf8", windowsHide: true, maxBuffer: 4 * MiB };
  if (hit) {
    if (!hit.pending) {
      hit.pending = true;
      try {
        const child = execFile(cmd, args, opts, (err, stdout) => {
          hit.out = err ? null : String(stdout);
          hit.until = Date.now() + keepFor(err, ttlMs);
          hit.pending = false;
        });
        child.unref?.();
      } catch {
        hit.pending = false;
        hit.until = now + ttlMs;
      }
    }
    return hit.out;
  }
  let out = null;
  let failed = null;
  try {
    out = String(execFileSync(cmd, args, { ...opts, stdio: ["ignore", "pipe", "ignore"] }));
  } catch (err) {
    failed = err ?? new Error("failed");
  }
  runs.set(key, { out, until: Date.now() + keepFor(failed, ttlMs), pending: false });
  return out;
}

/** forget every kept answer (tests) */
export function clearRunCache() {
  runs.clear();
}

// ---- parsers: plain text in, numbers out, null where the text does not say

/** `nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,temperature.gpu --format=csv,noheader,nounits` */
export function parseNvidiaSmi(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const f = line.split(",").map((s) => s.trim());
    if (f.length < 4 || !f[0]) continue;
    const n = (s) => (s && /^\d+(\.\d+)?$/.test(s) ? Math.round(Number(s)) : null);
    out.push({ name: f[0], totalMiB: n(f[1]), usedMiB: n(f[2]), freeMiB: n(f[3]), tempC: n(f[4]) });
  }
  return out;
}

/** one `lspci -mm -s <slot>` line -> a name a person would say ("AMD Radeon RX 6800M"), or null */
export function parseLspci(line) {
  const q = [...String(line ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (q.length < 3) return null;
  const [, vendor, device, , subdevice] = q;
  const short = /\[AMD|Advanced Micro Devices|\bATI\b/i.test(vendor) ? "AMD" : /NVIDIA/i.test(vendor) ? "NVIDIA" : /Intel/i.test(vendor) ? "Intel" : vendor.split(/[ ,]/)[0];
  const bracket = device.match(/\[([^\]]+)\]/)?.[1];
  let model = subdevice && !/^Device [0-9a-f]{4}$/i.test(subdevice) ? subdevice : bracket ?? device;
  if (!model) return null;
  return model.toLowerCase().startsWith(short.toLowerCase()) ? model : `${short} ${model}`;
}

/** `vm_stat` -> { availableMiB } from the free, inactive and speculative pages (what macOS gives back without swapping) */
export function parseVmStat(text) {
  const t = String(text ?? "");
  const page = Number(t.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isFinite(page)) return null;
  const pages = (label) => {
    const m = t.match(new RegExp(`^${label}:\\s+(\\d+)\\.`, "m"));
    return m ? Number(m[1]) : null;
  };
  const free = pages("Pages free");
  const inactive = pages("Pages inactive");
  const speculative = pages("Pages speculative") ?? 0;
  if (free === null || inactive === null) return null;
  return { availableMiB: Math.round(((free + inactive + speculative) * page) / MiB) };
}

/** "8 GB", "1536 MB" -> MiB, or null */
function sizeMiB(s) {
  const m = String(s ?? "").match(/([\d.]+)\s*(GB|MB|TB)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(m[2].toUpperCase() === "TB" ? n * 1024 * 1024 : m[2].toUpperCase() === "GB" ? n * 1024 : n);
}

/** `system_profiler SPDisplaysDataType -json` -> [{ name, vramMiB (dedicated, null when shared), apple, metal }] */
export function parseDisplays(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch {
    return [];
  }
  return (data?.SPDisplaysDataType ?? []).map((d) => ({
    name: d.sppci_model ?? d._name ?? null,
    vramMiB: sizeMiB(d.spdisplays_vram ?? d.spdisplays_vram_dedicated),
    apple: /apple/i.test(String(d.spdisplays_vendor ?? "")) || /^Apple M/.test(String(d.sppci_model ?? "")),
    metal: d.spdisplays_mtlgpufamilysupport ?? d.spdisplays_metalfamily ?? d.spdisplays_metal ?? null,
  }));
}

/**
 * How much of an Apple silicon Mac's unified memory its GPU may hold: the
 * owner's iogpu.wired_limit_mb when set, else the share Metal recommends by
 * default (about two thirds of the RAM, three quarters from 36 GiB up).
 */
export function unifiedShareMiB(ramTotalMiB, wiredLimitMiB = 0) {
  if (!Number.isFinite(ramTotalMiB) || ramTotalMiB <= 0) return null;
  if (Number.isFinite(wiredLimitMiB) && wiredLimitMiB > 0) return Math.min(ramTotalMiB, Math.round(wiredLimitMiB));
  return Math.round(ramTotalMiB * (ramTotalMiB >= 36 * 1024 ? 0.75 : 2 / 3));
}

/** a 64-bit size the registry may give as a number or as little-endian bytes */
function qword(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v) && v.length) return v.reduce((sum, byte, i) => sum + Number(byte) * 2 ** (8 * i), 0);
  return null;
}

/** what CIM's 32-bit AdapterRAM reads on any card with 4 GiB or more */
const ADAPTER_RAM_CAP = 4095 * MiB;
/** display adapters that are not a card a model can run on: remote and virtual displays, and the virtual machines' own (a cloud VM's Hyper-V adapter among them) */
const NOT_A_GPU = /Microsoft Basic Display|Microsoft Basic Render|Microsoft Remote Display|Remote Desktop|Virtual Display|Parsec|Citrix|Hyper-V Video|VMware SVGA|VirtualBox Graphics|QXL|Virtio GPU/i;

/**
 * The PowerShell CIM reading (WINDOWS_PROBE) -> { ram: {totalMiB, availableMiB} | null, gpus: [{ name, vramMiB }] }.
 * A card's memory is the registry's 64-bit HardwareInformation.qwMemorySize; CIM's AdapterRAM only when it is under
 * its 4 GiB ceiling (a card at the ceiling has an unknown size: null).
 */
export function parseWindowsProbe(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? "").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const kb = (v) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.round(Number(v) / 1024) : null);
  const os_ = data?.os ?? null;
  const ram = os_ && kb(os_.TotalVisibleMemorySize) !== null ? { totalMiB: kb(os_.TotalVisibleMemorySize), availableMiB: kb(os_.FreePhysicalMemory) } : null;
  const reg = new Map(list(data?.adapters).map((a) => [String(a?.DriverDesc ?? "").trim(), qword(a?.["HardwareInformation.qwMemorySize"])]));
  const gpus = list(data?.video)
    .filter((v) => v?.Name && !NOT_A_GPU.test(v.Name))
    .map((v) => {
      const name = String(v.Name).trim();
      const fromReg = reg.get(name);
      const adapter = Number(v.AdapterRAM);
      const bytes = Number.isFinite(fromReg) && fromReg > 0 ? fromReg : Number.isFinite(adapter) && adapter > 0 && adapter < ADAPTER_RAM_CAP ? adapter : null;
      return { name, vramMiB: bytes === null ? null : Math.round(bytes / MiB) };
    });
  return { ram, gpus };
}

/** the one PowerShell call the Windows sense makes: the OS's memory, the video controllers and their 64-bit sizes, as JSON */
export const WINDOWS_PROBE = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$o=Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory",
  "$v=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion)",
  "$r=@(Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | Select-Object DriverDesc,'HardwareInformation.qwMemorySize')",
  "[pscustomobject]@{os=$o;video=$v;adapters=$r} | ConvertTo-Json -Compress -Depth 4",
].join("; ");

const NVIDIA_QUERY = ["--query-gpu=name,memory.total,memory.used,memory.free,temperature.gpu", "--format=csv,noheader,nounits"];

// ---- Linux

// Find the GPU card whose VRAM is big enough to be the real one.
function readVram() {
  let cards = [];
  try {
    cards = readdirSync("/sys/class/drm").filter((n) => /^card\d+$/.test(n));
  } catch {
    cards = [];
  }
  let best = null;
  for (const card of cards) {
    const base = `/sys/class/drm/${card}/device`;
    const total = readNumber(`${base}/mem_info_vram_total`);
    if (!Number.isFinite(total)) continue;
    const totalMiB = Math.round(total / MiB);
    if (totalMiB <= MIN_REAL_VRAM_MIB) continue;
    if (best && best.totalMiB >= totalMiB) continue;
    const used = readNumber(`${base}/mem_info_vram_used`);
    const usedMiB = Number.isFinite(used) ? Math.round(used / MiB) : 0;
    best = { totalMiB, usedMiB, freeMiB: Math.max(0, totalMiB - usedMiB), card };
  }
  // No real GPU: say so with zeros rather than failing the whole read.
  return best ?? { totalMiB: 0, usedMiB: 0, freeMiB: 0, card: null };
}

/** an NVIDIA card's reading from nvidia-smi, the biggest one, or null */
function readNvidia(run) {
  const gpus = parseNvidiaSmi(run("nvidia-smi", NVIDIA_QUERY, { ttlMs: 3000, timeoutMs: 2000 }));
  const best = gpus.filter((g) => (g.totalMiB ?? 0) > MIN_REAL_VRAM_MIB).sort((a, b) => b.totalMiB - a.totalMiB)[0];
  return best ?? null;
}

const cardNames = new Map();
/** the name of a DRM card, from lspci by its PCI slot, asked once */
function cardName(card, run) {
  if (!card) return null;
  if (cardNames.has(card)) return cardNames.get(card);
  let name = null;
  try {
    const slot = readFileSync(`/sys/class/drm/${card}/device/uevent`, "utf8").match(/^PCI_SLOT_NAME=(.+)$/m)?.[1]?.trim();
    if (slot) name = parseLspci(run("lspci", ["-mm", "-s", slot], { ttlMs: Infinity, timeoutMs: 2000 }));
  } catch {
    name = null;
  }
  cardNames.set(card, name);
  return name;
}

/** the first DRM card there is (card0, card1, ...), or null */
function firstCard() {
  try {
    return readdirSync("/sys/class/drm").filter((n) => /^card\d+$/.test(n)).sort()[0] ?? null;
  } catch {
    return null;
  }
}

// /proc/meminfo reports kB; MemAvailable is what the kernel would give
// without swapping, which is the honest "free" number.
function readRam() {
  const out = { totalMiB: 0, availableMiB: 0 };
  try {
    const text = readFileSync("/proc/meminfo", "utf8");
    const pick = (key) => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
      return m ? Math.round(Number(m[1]) / 1024) : 0;
    };
    out.totalMiB = pick("MemTotal");
    out.availableMiB = pick("MemAvailable");
  } catch {
    out.totalMiB = Math.round(os.totalmem() / MiB);
    out.availableMiB = Math.round(os.freemem() / MiB);
  }
  return out;
}

function readCpu() {
  return { threads: os.cpus().length, load1: os.loadavg()[0] };
}


// The heat sense. On 2026-10-20 this laptop powered itself off from the GPU's
// software thermal cutoff (amdgpu "SW CTF") during a third back-to-back
// benchmark: its fans follow the edge sensor while the cutoff follows the
// junction sensor. So the junction temperature is read on every tick and
// nothing new starts on the GPU while it is hot.
export const HOT_C = 90;
/** the share of VRAM, RAM and CPU threads always kept for the owner's own work (CHRONOS_RESERVE) */
export const RESERVE = Number(process.env.CHRONOS_RESERVE) || 0.2; // no new GPU work above this
export const COOL_C = 85; // ...until it falls under this

function readHwmon() {
  let names = [];
  try {
    names = readdirSync("/sys/class/hwmon").filter((n) => /^hwmon\d+$/.test(n));
  } catch {
    names = [];
  }
  return names.map((n) => {
    const base = `/sys/class/hwmon/${n}`;
    let name = "";
    try {
      name = readFileSync(`${base}/name`, "utf8").trim();
    } catch {
      name = "";
    }
    return { base, name };
  });
}

function milliC(path) {
  const v = readNumber(path);
  return Number.isFinite(v) ? Math.round(v / 1000) : null;
}

// Junction, edge and critical temperatures of the discrete GPU (the amdgpu
// hwmon that has a second sensor), and the CPU's Tctl (AMD) or package
// temperature (Intel). Nulls where a sensor is missing, never a throw. Only
// Linux exposes these to a user without root; elsewhere every field is null.
export function readHeat({ platform = process.platform } = {}) {
  const out = { junctionC: null, edgeC: null, critC: null, cpuC: null };
  if (platform !== "linux") {
    out.hot = false;
    return out;
  }
  for (const { base, name } of readHwmon()) {
    if (name === "amdgpu" && milliC(`${base}/temp2_input`) !== null && out.junctionC === null) {
      out.junctionC = milliC(`${base}/temp2_input`);
      out.edgeC = milliC(`${base}/temp1_input`);
      out.critC = milliC(`${base}/temp2_crit`) ?? 100;
    } else if ((name === "k10temp" || name === "coretemp") && out.cpuC === null) {
      out.cpuC = milliC(`${base}/temp1_input`);
    }
  }
  out.hot = out.junctionC !== null && out.junctionC >= HOT_C;
  return out;
}

function readLinux(run) {
  let vram = readVram();
  const heat = readHeat({ platform: "linux" });
  let name = vram.card ? cardName(vram.card, run) : null;
  if (!vram.card) {
    // no amdgpu card with its VRAM in sysfs: an NVIDIA card says its own through nvidia-smi
    const nv = readNvidia(run);
    if (nv) {
      vram = { totalMiB: nv.totalMiB, usedMiB: nv.usedMiB, freeMiB: nv.freeMiB, card: nv.name };
      name = nv.name;
      // NVIDIA reports one core temperature, not a junction (hotspot): it is the edge here
      if (heat.edgeC === null) heat.edgeC = nv.tempC;
    }
  }
  // no card to fill: the graphics that are there (built into the processor) still have a name
  if (!vram.card) name = cardName(firstCard(), run);
  const gpu = { name, vramMiB: vram.totalMiB, backend: vram.totalMiB > 0 ? "vulkan" : "none" };
  return { vram, ram: readRam(), cpu: readCpu(), heat, gpu, at: Date.now() };
}

// ---- macOS

function readDarwin(run, arch, sys) {
  const totalMiB = Math.round(sys.totalmem() / MiB);
  const vm = parseVmStat(run("vm_stat", [], { ttlMs: 3000, timeoutMs: 1500 }));
  const ram = { totalMiB, availableMiB: vm ? Math.min(totalMiB, vm.availableMiB) : Math.round(sys.freemem() / MiB) };
  const cpu = { threads: sys.cpus().length, load1: sys.loadavg()[0] };
  const heat = readHeat({ platform: "darwin" });
  const displays = parseDisplays(run("system_profiler", ["SPDisplaysDataType", "-json"], { ttlMs: 10 * 60_000, timeoutMs: 4000 }));
  if (arch === "arm64") {
    // Apple silicon: one pool of memory; the GPU may hold a share of it, and what it may take now is what the RAM has free
    const wired = Number(String(run("sysctl", ["-n", "iogpu.wired_limit_mb"], { ttlMs: 60_000, timeoutMs: 1500 }) ?? "").trim());
    const share = unifiedShareMiB(totalMiB, wired);
    const name = displays.find((d) => d.apple)?.name ?? displays[0]?.name ?? (String(run("sysctl", ["-n", "machdep.cpu.brand_string"], { ttlMs: Infinity, timeoutMs: 1500 }) ?? "").trim() || null);
    const freeMiB = share === null ? null : Math.max(0, Math.min(share, ram.availableMiB));
    const vram = { totalMiB: share ?? 0, usedMiB: share === null ? null : share - freeMiB, freeMiB, card: name };
    return { vram, ram, cpu, heat, gpu: { name, vramMiB: share ?? 0, backend: "metal", unified: true }, at: Date.now() };
  }
  // an Intel Mac: the release engine for it is built without Metal, so no card is one Chronos can fill
  const card = [...displays].sort((a, b) => (b.vramMiB ?? 0) - (a.vramMiB ?? 0))[0] ?? null;
  return { vram: { totalMiB: 0, usedMiB: 0, freeMiB: 0, card: null }, ram, cpu, heat, gpu: { name: card?.name ?? null, vramMiB: card?.vramMiB ?? null, backend: "none" }, at: Date.now() };
}

// ---- Windows

function readWindows(run, sys) {
  const encoded = Buffer.from(WINDOWS_PROBE, "utf16le").toString("base64");
  const probe = parseWindowsProbe(run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { ttlMs: 10_000, timeoutMs: 5000 }));
  // Node's own numbers are Windows' GlobalMemoryStatusEx (available physical memory), live and free to read; CIM's stand in when they fail
  const totalMiB = Math.round(sys.totalmem() / MiB) || probe?.ram?.totalMiB || 0;
  const availableMiB = Math.round(sys.freemem() / MiB) || probe?.ram?.availableMiB || 0;
  // os.loadavg() is always zeros on Windows: there is no load average to read
  const cpu = { threads: sys.cpus().length, load1: null };
  const heat = readHeat({ platform: "win32" });
  const nv = readNvidia(run);
  let vram;
  let name;
  if (nv) {
    vram = { totalMiB: nv.totalMiB, usedMiB: nv.usedMiB, freeMiB: nv.freeMiB, card: nv.name };
    name = nv.name;
    heat.edgeC = nv.tempC;
  } else {
    const gpus = (probe?.gpus ?? []).filter((g) => g.vramMiB === null || g.vramMiB > MIN_REAL_VRAM_MIB);
    const best = [...gpus].sort((a, b) => (b.vramMiB ?? 0) - (a.vramMiB ?? 0))[0] ?? null;
    // how much of a card's memory is in use is not something CIM says: used and free stay null
    vram = best ? { totalMiB: best.vramMiB, usedMiB: null, freeMiB: null, card: best.name } : { totalMiB: 0, usedMiB: 0, freeMiB: 0, card: null };
    name = best?.name ?? null;
  }
  return { vram, ram: { totalMiB, availableMiB }, cpu, heat, gpu: { name, vramMiB: vram.totalMiB, backend: vram.card ? "vulkan" : "none" }, at: Date.now() };
}

// One reading of the whole box.
export function readHardware({ platform = process.platform, arch = process.arch, run = runCached, sys = os } = {}) {
  try {
    if (platform === "darwin") return readDarwin(run, arch, sys);
    if (platform === "win32") return readWindows(run, sys);
    return readLinux(run);
  } catch {
    // a reading that went wrong is a reading of nothing, never a throw
    return { vram: { totalMiB: 0, usedMiB: 0, freeMiB: 0, card: null }, ram: { totalMiB: Math.round(sys.totalmem() / MiB), availableMiB: Math.round(sys.freemem() / MiB) }, cpu: { threads: sys.cpus().length, load1: null }, heat: { junctionC: null, edgeC: null, critC: null, cpuC: null, hot: false }, gpu: { name: null, vramMiB: 0, backend: "none" }, at: Date.now() };
  }
}

// Does a brain that needs this much VRAM and RAM fit right now, keeping a
// reserve for the desktop? Returns { ok, why }; why is a plain sentence.
// Where the card's use cannot be read (Windows without nvidia-smi) the ask is
// judged against the card's whole memory, and the sentence says so.
export function fits(
  { vramMiB = 0, ramMiB = 0 } = {},
  hw = readHardware(),
  {
    reserve = RESERVE,
    reserveVramMiB = Math.max(512, Math.round((hw?.vram?.totalMiB ?? 0) * reserve)),
    reserveRamMiB = Math.max(2048, Math.round((hw?.ram?.totalMiB ?? 0) * reserve)),
    hotC = HOT_C,
  } = {},
) {
  // Heat first: a hot junction refuses every GPU ask, whatever the VRAM says.
  const j = hw.heat?.junctionC;
  if (vramMiB > 0 && Number.isFinite(j) && j >= hotC) {
    return {
      ok: false,
      why:
        `The GPU junction is at ${j} C; nothing new starts on it above ${hotC} C ` +
        `(the cutoff at ${hw.heat.critC ?? 100} C powers the machine off). Wait until it is under ${COOL_C} C.`,
    };
  }
  if (vramMiB > 0 && !Number.isFinite(hw.vram.freeMiB) && !Number.isFinite(hw.vram.totalMiB)) {
    return { ok: false, why: `Needs ${vramMiB} MiB of VRAM but this system does not say how much memory its GPU has.` };
  }
  const unread = !Number.isFinite(hw.vram.freeMiB);
  const free = unread ? hw.vram.totalMiB : hw.vram.freeMiB;
  const vramRoom = free - reserveVramMiB;
  if (vramMiB > 0 && vramMiB > vramRoom) {
    return {
      ok: false,
      why: unread
        ? `Needs ${vramMiB} MiB of VRAM but the card has ${hw.vram.totalMiB} MiB in all (its use cannot be read here), ${reserveVramMiB} MiB kept for the owner.`
        : `Needs ${vramMiB} MiB of VRAM but only ${hw.vram.freeMiB} MiB is free ` +
          `(${hw.vram.usedMiB} of ${hw.vram.totalMiB} MiB used, ${reserveVramMiB} MiB kept for the owner).`,
    };
  }
  const ramRoom = hw.ram.availableMiB - reserveRamMiB;
  if (ramMiB > 0 && ramMiB > ramRoom) {
    return {
      ok: false,
      why:
        `Needs ${ramMiB} MiB of RAM but only ${hw.ram.availableMiB} MiB is available ` +
        `(${reserveRamMiB} MiB kept free).`,
    };
  }
  return { ok: true, why: "" };
}

// Read the hardware on an interval and tell the bus. Returns a stop function.
// The first reading goes out at once so listeners never wait a whole interval.
export function watchHardware(bus, intervalMs = 5000) {
  const tick = () => {
    try {
      bus.emit("hardware.read", readHardware());
    } catch {
      // A listener that throws must not stop the sense.
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
