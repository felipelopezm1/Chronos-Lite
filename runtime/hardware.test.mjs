import { test } from "node:test";
import assert from "node:assert/strict";
import { readHardware, readHeat, fits, watchHardware, HOT_C, WINDOWS_PROBE, clearRunCache, parseDisplays, parseLspci, parseNvidiaSmi, parseVmStat, parseWindowsProbe, runCached, unifiedShareMiB } from "./hardware.mjs";

test("readHardware reads real numbers off this box", () => {
  const hw = readHardware();
  const win = process.platform === "win32";
  assert.ok(hw.ram.totalMiB > 0, "RAM total");
  assert.ok(hw.ram.availableMiB > 0 && hw.ram.availableMiB <= hw.ram.totalMiB, "RAM available");
  assert.ok(hw.cpu.threads > 0, "threads");
  // Windows has no load average: null there, a number everywhere else
  if (win) assert.equal(hw.cpu.load1, null, "no load on Windows");
  else assert.ok(Number.isFinite(hw.cpu.load1), "load");
  // a Windows card whose size CIM cannot say has a null total; anything else is a number
  assert.ok((Number.isFinite(hw.vram.totalMiB) && hw.vram.totalMiB >= 0) || (win && hw.vram.totalMiB === null), "VRAM total");
  // how much of the card is used is read on Linux (sysfs), Apple silicon (the RAM) and NVIDIA; CIM does not say it
  if (Number.isFinite(hw.vram.usedMiB)) assert.equal(hw.vram.freeMiB, Math.max(0, hw.vram.totalMiB - hw.vram.usedMiB));
  else assert.ok(win && hw.vram.freeMiB === null, "only Windows without nvidia-smi leaves used and free unknown");
  assert.ok(typeof hw.at === "number");
  // the card is named as sysfs names it on Linux; macOS and Windows name it as the system does
  if (process.platform === "linux" && hw.vram.totalMiB > 0) assert.match(hw.vram.card, /^card\d+$/);
  else if (hw.vram.totalMiB > 0) assert.equal(typeof hw.vram.card, "string");
});

test("fits rejects a 100000 MiB ask with a sentence", () => {
  const out = fits({ vramMiB: 100000 });
  assert.equal(out.ok, false);
  assert.match(out.why, /100000 MiB of VRAM/);
  const ram = fits({ ramMiB: 100000 });
  assert.equal(ram.ok, false);
  assert.match(ram.why, /100000 MiB of RAM/);
});

test("fits accepts a small ask against a known reading", () => {
  const hw = { vram: { totalMiB: 12000, usedMiB: 1000, freeMiB: 11000, card: "card1" }, ram: { totalMiB: 30000, availableMiB: 8000 }, cpu: { threads: 16, load1: 1 }, at: 0 };
  assert.deepEqual(fits({ vramMiB: 6200, ramMiB: 1000 }, hw), { ok: true, why: "" });
  assert.equal(fits({ vramMiB: 10600 }, hw).ok, false, "the 512 MiB reserve counts");
  assert.equal(fits({ vramMiB: 10600 }, hw, { reserveVramMiB: 0 }).ok, true);
});

test("watchHardware emits hardware.read and stops", async () => {
  const seen = [];
  const bus = { emit: (type, data) => seen.push({ type, data }) };
  const stop = watchHardware(bus, 20);
  await new Promise((r) => setTimeout(r, 70));
  stop();
  const count = seen.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(count >= 2, `expected at least two readings, got ${count}`);
  assert.equal(seen.length, count, "nothing after stop");
  assert.equal(seen[0].type, "hardware.read");
  assert.ok(seen[0].data.ram.totalMiB > 0);
});

test("readHeat reads the GPU junction and the CPU, or nulls, never throws", () => {
  const heat = readHeat();
  for (const k of ["junctionC", "edgeC", "critC", "cpuC"]) {
    assert.ok(heat[k] === null || (Number.isFinite(heat[k]) && heat[k] > -50 && heat[k] < 150), k);
  }
  assert.equal(typeof heat.hot, "boolean");
  assert.ok("heat" in readHardware(), "readHardware carries heat");
});

test("fits refuses any GPU ask while the junction is hot, and lets a RAM-only ask through", () => {
  const hw = { vram: { totalMiB: 12000, usedMiB: 0, freeMiB: 12000, card: "card1" }, ram: { totalMiB: 30000, availableMiB: 16000 }, cpu: { threads: 16, load1: 1 }, heat: { junctionC: HOT_C + 2, edgeC: 70, critC: 100, cpuC: 80, hot: true }, at: 0 };
  const out = fits({ vramMiB: 1000 }, hw);
  assert.equal(out.ok, false);
  assert.match(out.why, /junction is at 92 C/);
  assert.equal(fits({ ramMiB: 1000 }, hw).ok, true, "the CPU is not gated by the GPU's heat");
  hw.heat.junctionC = HOT_C - 10;
  assert.equal(fits({ vramMiB: 1000 }, hw).ok, true);
});

test("fits keeps 20% of the VRAM and RAM for the owner by default", () => {
  const hw = { vram: { totalMiB: 12000, usedMiB: 0, freeMiB: 12000, card: "card1" }, ram: { totalMiB: 30000, availableMiB: 20000 }, cpu: { threads: 16, load1: 0 }, heat: { junctionC: 60, hot: false }, at: 0 };
  assert.equal(fits({ vramMiB: 9600 }, hw).ok, true, "9600 of 12000 leaves exactly 20%");
  assert.equal(fits({ vramMiB: 9700 }, hw).ok, false);
  assert.match(fits({ vramMiB: 9700 }, hw).why, /2400 MiB kept for the owner/);
  assert.equal(fits({ ramMiB: 14000 }, hw).ok, true, "20000 available less 6000 kept");
  assert.equal(fits({ ramMiB: 14100 }, hw).ok, false);
});

// ---- the other systems. Every text below is a FIXTURE written to the documented output of the tool it names
// (nvidia-smi's csv, vm_stat, system_profiler -json, PowerShell's ConvertTo-Json), not a capture from a real
// machine; the one capture is the lspci line, which is this laptop's own.

const LSPCI_HERE = '03:00.0 "Display controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 22 [Radeon RX 6700/6700 XT/6750 XT / 6800M/6850M XT]" -rc3 -p00 "ASUSTeK Computer Inc." "Radeon RX 6800M"';
const NVIDIA_SMI = "NVIDIA GeForce RTX 4070 Laptop GPU, 8188, 1203, 6985, 54\r\n";
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               51234.
Pages active:                            402817.
Pages inactive:                          380112.
Pages speculative:                         9120.
Pages throttled:                              0.
Pages wired down:                        148233.
Pages purgeable:                          10231.
"Translation faults":                 912837465.
Pages copy-on-write:                   21873645.
`;
const DISPLAYS_M2 = JSON.stringify({
  SPDisplaysDataType: [
    { _name: "Apple M2 Pro", spdisplays_mtlgpufamilysupport: "spdisplays_metal3", spdisplays_vendor: "sppci_vendor_Apple", sppci_bus: "spdisplays_builtin", sppci_cores: "19", sppci_device_type: "spdisplays_gpu", sppci_model: "Apple M2 Pro", spdisplays_ndrvs: [{ _name: "Color LCD", spdisplays_main: "spdisplays_yes" }] },
  ],
});
const DISPLAYS_INTEL_MAC = JSON.stringify({
  SPDisplaysDataType: [
    { _name: "kHW_IntelUHDGraphics630Item", spdisplays_vendor: "Intel", spdisplays_vram_shared: "1536 MB", sppci_bus: "spdisplays_builtin", sppci_model: "Intel UHD Graphics 630", spdisplays_metalfamily: "spdisplays_metal3" },
    { _name: "kHW_AMDRadeonPro5500MItem", spdisplays_vendor: "sppci_vendor_amd", spdisplays_vram: "8 GB", sppci_bus: "spdisplays_pcie_device", sppci_model: "AMD Radeon Pro 5500M", spdisplays_metalfamily: "spdisplays_metal3" },
  ],
});
// what the one PowerShell call prints (WINDOWS_PROBE): a laptop with a 12 GiB Radeon beside the processor's own graphics
const WIN_AMD = JSON.stringify({
  os: { TotalVisibleMemorySize: 33340244, FreePhysicalMemory: 21875432 },
  video: [
    { Name: "AMD Radeon RX 6800M", AdapterRAM: 4293918720, DriverVersion: "32.0.12033.1030" },
    { Name: "AMD Radeon(TM) Graphics", AdapterRAM: 536870912, DriverVersion: "32.0.12033.1030" },
    { Name: "Microsoft Remote Display Adapter", AdapterRAM: null, DriverVersion: "10.0.26100.1" },
  ],
  adapters: [
    { DriverDesc: "AMD Radeon RX 6800M", "HardwareInformation.qwMemorySize": 12868124672 },
    { DriverDesc: "AMD Radeon(TM) Graphics", "HardwareInformation.qwMemorySize": [0, 0, 0, 32, 0, 0, 0, 0] },
  ],
});
// one video controller comes back as an object when @() is lost, and a card at CIM's 4 GiB ceiling with no registry size
const WIN_ONE = JSON.stringify({ os: { TotalVisibleMemorySize: 16621568, FreePhysicalMemory: 9000000 }, video: { Name: "Intel(R) Arc(TM) A770 Graphics", AdapterRAM: 4293918720 }, adapters: [] });

/** a stand-in for node:os */
const sysOf = ({ totalGiB = 32, freeGiB = 20, threads = 12, load = [1.5, 1, 1] } = {}) => ({ totalmem: () => totalGiB * 1024 ** 3, freemem: () => freeGiB * 1024 ** 3, cpus: () => Array.from({ length: threads }, () => ({})), loadavg: () => load });
/** a stand-in for the command runner: answers by the command's name, null for anything else (missing) */
const runOf = (answers) => (cmd, args = []) => {
  const a = answers[cmd.replace(/\.exe$/, "")];
  return typeof a === "function" ? a(args) : (a ?? null);
};
const SHAPE = (hw) => {
  assert.deepEqual(Object.keys(hw).sort(), ["at", "cpu", "gpu", "heat", "ram", "vram"]);
  assert.deepEqual(Object.keys(hw.vram).sort(), ["card", "freeMiB", "totalMiB", "usedMiB"]);
  assert.deepEqual(Object.keys(hw.ram).sort(), ["availableMiB", "totalMiB"]);
  assert.deepEqual(Object.keys(hw.cpu).sort(), ["load1", "threads"]);
  assert.deepEqual(Object.keys(hw.heat).sort(), ["cpuC", "critC", "edgeC", "hot", "junctionC"]);
  for (const k of ["name", "vramMiB", "backend"]) assert.ok(k in hw.gpu, `gpu.${k}`);
};

test("this box's reading carries gpu {name, vramMiB, backend} beside the shape of before", () => {
  const hw = readHardware();
  SHAPE(hw);
  assert.equal(hw.gpu.vramMiB, hw.vram.totalMiB);
  assert.ok(["vulkan", "metal", "cuda", "none"].includes(hw.gpu.backend));
  assert.equal(hw.gpu.backend === "none", hw.vram.totalMiB === 0);
  assert.ok(hw.gpu.name === null || typeof hw.gpu.name === "string");
});

test("parsers: nvidia-smi's csv, an lspci line, vm_stat", () => {
  assert.deepEqual(parseNvidiaSmi(NVIDIA_SMI), [{ name: "NVIDIA GeForce RTX 4070 Laptop GPU", totalMiB: 8188, usedMiB: 1203, freeMiB: 6985, tempC: 54 }]);
  assert.equal(parseNvidiaSmi("NVIDIA GeForce GTX 1050, 4096, 512, 3584, [N/A]\n")[0].tempC, null, "a field the driver does not give is null");
  assert.deepEqual(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.\n"), []);
  assert.deepEqual(parseNvidiaSmi(null), []);
  assert.equal(parseLspci(LSPCI_HERE), "AMD Radeon RX 6800M");
  assert.equal(parseLspci('00:02.0 "VGA compatible controller" "Intel Corporation" "UHD Graphics 620" -rc07 "Lenovo" "Device 2258"'), "Intel UHD Graphics 620", "a subdevice that is only a number falls back to the device");
  assert.equal(parseLspci('01:00.0 "VGA compatible controller" "NVIDIA Corporation" "GA104M [GeForce RTX 3070 Mobile / Max-Q]" -rca1 "Dell" "Device 0a6f"'), "NVIDIA GeForce RTX 3070 Mobile / Max-Q");
  assert.equal(parseLspci(""), null);
  // (51234 + 380112 + 9120) pages of 16384 bytes
  assert.deepEqual(parseVmStat(VM_STAT), { availableMiB: Math.round(((51234 + 380112 + 9120) * 16384) / 1048576) });
  assert.equal(parseVmStat("vm_stat: command not found"), null);
  assert.equal(parseVmStat(null), null);
});

test("parsers: system_profiler's displays, and the share of unified memory a Mac's GPU may hold", () => {
  assert.deepEqual(parseDisplays(DISPLAYS_M2), [{ name: "Apple M2 Pro", vramMiB: null, apple: true, metal: "spdisplays_metal3" }]);
  const intel = parseDisplays(DISPLAYS_INTEL_MAC);
  assert.equal(intel[0].vramMiB, null, "shared memory is not a card's own");
  assert.deepEqual({ name: intel[1].name, vramMiB: intel[1].vramMiB, apple: intel[1].apple }, { name: "AMD Radeon Pro 5500M", vramMiB: 8192, apple: false });
  assert.deepEqual(parseDisplays("not json"), []);
  assert.deepEqual(parseDisplays(null), []);
  assert.equal(unifiedShareMiB(16384), 10923, "two thirds under 36 GiB");
  assert.equal(unifiedShareMiB(65536), 49152, "three quarters from 36 GiB up");
  assert.equal(unifiedShareMiB(16384, 14000), 14000, "the owner's iogpu.wired_limit_mb wins");
  assert.equal(unifiedShareMiB(16384, 99999), 16384, "never more than the RAM");
  assert.equal(unifiedShareMiB(NaN), null);
});

test("parsers: the PowerShell CIM reading: the registry's 64-bit size beats CIM's 4 GiB ceiling", () => {
  assert.match(WINDOWS_PROBE, /Win32_OperatingSystem/);
  assert.match(WINDOWS_PROBE, /Win32_VideoController/);
  const p = parseWindowsProbe(WIN_AMD);
  assert.deepEqual(p.ram, { totalMiB: Math.round(33340244 / 1024), availableMiB: Math.round(21875432 / 1024) });
  assert.deepEqual(p.gpus, [
    { name: "AMD Radeon RX 6800M", vramMiB: 12272 },
    { name: "AMD Radeon(TM) Graphics", vramMiB: 512 },
  ], "the remote display adapter is not a GPU; a size given as bytes is read little-endian");
  const one = parseWindowsProbe("﻿" + WIN_ONE);
  assert.deepEqual(one.gpus, [{ name: "Intel(R) Arc(TM) A770 Graphics", vramMiB: null }], "at the ceiling with no registry size the memory is unknown, not 4 GiB");
  // a cloud VM's adapters (a GitHub Windows runner is a Hyper-V guest) are no card to run a model on
  const vm = parseWindowsProbe(JSON.stringify({ video: [
    { Name: "Microsoft Hyper-V Video", AdapterRAM: 0 },
    { Name: "Microsoft Basic Render Driver", AdapterRAM: null },
    { Name: "VMware SVGA 3D", AdapterRAM: 134217728 },
    { Name: "VirtualBox Graphics Adapter (WDDM)", AdapterRAM: 134217728 },
    { Name: "Red Hat QXL controller", AdapterRAM: 67108864 },
  ] }));
  assert.deepEqual(vm.gpus, []);
  assert.equal(parseWindowsProbe(""), null);
  assert.deepEqual(parseWindowsProbe("{}"), { ram: null, gpus: [] });
});

test("macOS on Apple silicon: unified memory, a share of the RAM as the GPU's, backend metal, no temperature", () => {
  const run = runOf({ vm_stat: VM_STAT, system_profiler: DISPLAYS_M2, sysctl: (args) => (args.includes("iogpu.wired_limit_mb") ? "0\n" : "Apple M2 Pro\n") });
  const hw = readHardware({ platform: "darwin", arch: "arm64", run, sys: sysOf({ totalGiB: 32 }) });
  SHAPE(hw);
  assert.deepEqual(hw.gpu, { name: "Apple M2 Pro", vramMiB: 21845, backend: "metal", unified: true });
  assert.equal(hw.vram.totalMiB, 21845);
  assert.equal(hw.vram.card, "Apple M2 Pro");
  assert.equal(hw.ram.totalMiB, 32768);
  assert.equal(hw.ram.availableMiB, parseVmStat(VM_STAT).availableMiB);
  assert.equal(hw.vram.freeMiB, Math.min(21845, hw.ram.availableMiB), "what the GPU may take now is what the RAM has free, up to its share");
  assert.equal(hw.vram.usedMiB, 21845 - hw.vram.freeMiB);
  assert.deepEqual(hw.heat, { junctionC: null, edgeC: null, critC: null, cpuC: null, hot: false });
  assert.equal(hw.cpu.threads, 12);
  // every tool missing: the numbers Node itself has, the rest null, no throw
  const bare = readHardware({ platform: "darwin", arch: "arm64", run: () => null, sys: sysOf({ totalGiB: 16, freeGiB: 4 }) });
  SHAPE(bare);
  assert.equal(bare.gpu.name, null);
  assert.equal(bare.gpu.backend, "metal");
  assert.equal(bare.ram.availableMiB, 4096);
});

test("macOS on Intel: the release engine has no Metal, so no card is one to fill", () => {
  const hw = readHardware({ platform: "darwin", arch: "x64", run: runOf({ vm_stat: VM_STAT, system_profiler: DISPLAYS_INTEL_MAC }), sys: sysOf({ totalGiB: 16 }) });
  SHAPE(hw);
  assert.deepEqual(hw.gpu, { name: "AMD Radeon Pro 5500M", vramMiB: 8192, backend: "none" });
  assert.deepEqual(hw.vram, { totalMiB: 0, usedMiB: 0, freeMiB: 0, card: null });
});

test("Windows: nvidia-smi when it is there, else the CIM reading with the card's use unknown; no load average, no junction", () => {
  const nv = readHardware({ platform: "win32", arch: "x64", run: runOf({ "nvidia-smi": NVIDIA_SMI, powershell: WIN_AMD }), sys: sysOf({ totalGiB: 32, freeGiB: 20 }) });
  SHAPE(nv);
  assert.deepEqual(nv.vram, { totalMiB: 8188, usedMiB: 1203, freeMiB: 6985, card: "NVIDIA GeForce RTX 4070 Laptop GPU" });
  assert.deepEqual(nv.gpu, { name: "NVIDIA GeForce RTX 4070 Laptop GPU", vramMiB: 8188, backend: "vulkan" });
  assert.equal(nv.heat.junctionC, null, "NVIDIA's one temperature is not a junction: the governor has nothing to steer by");
  assert.equal(nv.heat.edgeC, 54);
  assert.equal(nv.cpu.load1, null, "Windows has no load average");

  let asked = null;
  const cim = readHardware({ platform: "win32", arch: "x64", run: runOf({ powershell: (args) => ((asked = args), WIN_AMD) }), sys: sysOf({ totalGiB: 32, freeGiB: 20 }) });
  SHAPE(cim);
  assert.deepEqual(cim.vram, { totalMiB: 12272, usedMiB: null, freeMiB: null, card: "AMD Radeon RX 6800M" });
  assert.deepEqual(cim.gpu, { name: "AMD Radeon RX 6800M", vramMiB: 12272, backend: "vulkan" });
  assert.deepEqual(cim.ram, { totalMiB: 32768, availableMiB: 20480 });
  assert.deepEqual(asked.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(Buffer.from(asked[3], "base64").toString("utf16le"), WINDOWS_PROBE);
  // a card whose use cannot be read is judged against its whole memory, and the sentence says so
  assert.equal(fits({ vramMiB: 6200 }, cim).ok, true);
  assert.match(fits({ vramMiB: 11000 }, cim).why, /12272 MiB in all \(its use cannot be read here\)/);

  // a card that will not say its size: null, never a guess; and nothing at all when PowerShell fails
  const unknown = readHardware({ platform: "win32", arch: "x64", run: runOf({ powershell: WIN_ONE }), sys: sysOf() });
  assert.deepEqual(unknown.gpu, { name: "Intel(R) Arc(TM) A770 Graphics", vramMiB: null, backend: "vulkan" });
  assert.match(fits({ vramMiB: 1000 }, unknown).why, /does not say how much memory its GPU has/);
  const none = readHardware({ platform: "win32", arch: "x64", run: () => null, sys: sysOf({ totalGiB: 8, freeGiB: 3 }) });
  SHAPE(none);
  assert.deepEqual(none.gpu, { name: null, vramMiB: 0, backend: "none" });
  assert.deepEqual(none.ram, { totalMiB: 8192, availableMiB: 3072 });
});

test("a sense that breaks reads nothing rather than throwing", () => {
  const boom = () => {
    throw new Error("the tool blew up");
  };
  for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"]]) {
    const hw = readHardware({ platform, arch, run: boom, sys: sysOf({ totalGiB: 8, freeGiB: 2 }) });
    SHAPE(hw);
    assert.deepEqual(hw.gpu, { name: null, vramMiB: 0, backend: "none" });
    assert.equal(hw.ram.totalMiB, 8192);
  }
  assert.deepEqual(readHeat({ platform: "win32" }), { junctionC: null, edgeC: null, critC: null, cpuC: null, hot: false });
});

test("an outside command is run once, kept for its time, and a missing one is null without a throw", () => {
  clearRunCache();
  const script = "process.stdout.write(String(process.hrtime.bigint()))";
  const a = runCached(process.execPath, ["-e", script], { ttlMs: 60_000, timeoutMs: 5000 });
  const b = runCached(process.execPath, ["-e", script], { ttlMs: 60_000, timeoutMs: 5000 });
  assert.match(a, /^\d+$/);
  assert.equal(a, b, "the second ask is the kept answer, not a second run");
  assert.equal(runCached("chronos-no-such-tool-xyz", ["--version"]), null);
  assert.equal(runCached(process.execPath, ["-e", "setTimeout(()=>{}, 5000)"], { timeoutMs: 200 }), null, "a command over its timeout is null");
  clearRunCache();
});
