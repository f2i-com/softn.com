# Pocket — the contract

A complete 8-bit handheld console (DMG and CGB) written entirely in SoftN `.logic`, shipped in
one `.softn` bundle. Nothing Game-Boy-specific goes into the SoftN component
library: the bundle drives two **generic** primitives, `<PixelCanvas>` (a dense
bitmap sink) and `<AudioStream>` (a streaming PCM sink), and everything the
the console knows about itself lives in `logic/`.

The reference implementation is the TypeScript emulator at
`C:/Users/User/Documents/repos/gameboy/emulator/src/emulator/core`. Behaviour
should match it except where this document says otherwise. Where it says
otherwise, it says why.

This file is normative. `logic/gb_state.logic` is the other normative artefact —
it declares every byte of state, and this document says what each module may do
to it.

---

## 1. Ground rules

### 1.1 One translation unit

`import "./x.logic"` is a **textual** preprocessor directive. There is no module
scope. Every top-level name in every file shares one global namespace.

- Every declaration carries its module tag: `gbMmu_`, `gbCpu_`, `gbPpu_`,
  `gbApu_`, `gbTimer_`, `gbCart_`, `gbOps_`, `gbMachine_`, `gbState_`.
- Shared state is `SCREAMING_SNAKE` with a `GB_` prefix and is declared **only**
  in `gb_state.logic`.
- No module redeclares a name another module owns. If you need a helper that
  another module already has, call it.
- Local `let` inside a function needs no prefix and is not synced to the host.

### 1.2 Import order

```
gb_state.logic      // first, always
gb_cart.logic
gb_ppu.logic
gb_apu.logic
gb_timer.logic
gb_mmu.logic
gb_ops.logic
gb_cpu.logic
gb_machine.logic
main.logic          // imports gb_machine, owns the UI-facing entry points
```

Order matters only for readability — `function` declarations hoist — but keep
it, because a later agent reading top to bottom should meet a name after its
storage.

### 1.3 State lives in typed arrays

zipp has no dirty bits; `getDirtyGlobals` returns every index unconditionally,
so every top-level `let` holding a plain value is read out of the VM and
deep-compared on **every host call**. Measured: 1512us for a 65536-element plain
`Array`, 0.131us for the typed-array equivalent, which marshals to an opaque
slot and is skipped by the sync entirely.

**No module may add a top-level `let` holding a plain array, object or string**
except the UI scalars in §7.4. The plain-value budget is already spent on the
~230 index constants and the two 256-entry dispatch tables.

### 1.4 Dispatch is a function table

`switch` compiles to a linear scan. Measured over 1e6 dispatches on a 256-arm
switch: 57.6ms on the first arm, 1965ms on the last — a 34x spread, and real
DMG code leans on `0xC0`–`0xFF`, the expensive end. An array of 256 functions
indexed by opcode measured 6.4x faster.

Build `GB_OPS` and `GB_CBOPS` once at init and call `GB_OPS[op]()`. This applies
to the opcode tables and nothing else — a five-arm `switch` on PPU mode is fine.

### 1.5 No allocation in hot loops

No closures, no array literals, no object literals per frame, per scanline or
per pixel. Everything is preallocated in `gb_state.logic`. The **only**
per-frame allocations permitted in the whole bundle are the two result objects
returned by `gbMachine_getFrame()` and `gbMachine_getSamples()`, and the two
base64 strings inside them.

### 1.6 Missing globals

`TextEncoder`, `TextDecoder`, `btoa`, `atob`, `Blob`, `URL`, `AudioContext`,
`requestAnimationFrame`, `setInterval`, `setTimeout`, `performance`,
`ImageData`, `OffscreenCanvas` and `WebAssembly` are all **undefined** inside
`.logic`. For base64 use the ES2026 builtins zipp does have and which are
verified present on the shipping engine:

```
let s = bytes.toBase64()               // Uint8Array -> string
let b = Uint8Array.fromBase64(s)       // string -> Uint8Array
```

`.subarray(a, b)` returns a `Uint8Array` and `toBase64()` works on it, so a
partial buffer is encoded without a copy.

### 1.7 Forbidden function names

Do not name any per-frame function `tick`, `update`, `animate` or `render`.
They are silently dropped at queue depth 32. The prefixing convention makes
this a non-issue — `gbPpu_renderLine` is fine, bare `render` is not.

### 1.8 The host boundary

Typed arrays cannot cross it — `null` in both directions. Anything the host
sees is a string, a number, a boolean, or a plain object of those. Strings are
cheap: a 92KB string measured 0.05ms.

---

## 2. State reference

Everything below is declared in `logic/gb_state.logic`. Names and shapes are
exact. Read that file's header comment for the reasoning; this is the index.

### 2.1 CPU

| Name | Type | Notes |
|---|---|---|
| `GB_REG` | `Uint8Array(8)` | `GB_R_A=0 GB_R_F=1 GB_R_B=2 GB_R_C=3 GB_R_D=4 GB_R_E=5 GB_R_H=6 GB_R_L=7` |
| `GB_R8_MAP` | `Uint8Array(8)` | opcode register field → `GB_REG` index; slot 6 is `0xFF`, the "(HL)" sentinel |
| `GB_REG16` | `Uint16Array(2)` | `GB_R16_SP=0 GB_R16_PC=1` |
| `GB_CPUF` | `Uint8Array(8)` | `GB_P_IME=0 GB_P_IME_PENDING=1 GB_P_HALTED=2 GB_P_STOPPED=3 GB_P_HALTBUG=4 GB_P_DOUBLE=5 GB_P_SPEEDSW=6 GB_P_GBC=7`, each 0 or 1 |

`F` is stored **packed**, not as four booleans. `GB_FLAG_Z=0x80 GB_FLAG_N=0x40
GB_FLAG_H=0x20 GB_FLAG_C=0x10`. The low nibble is always zero on hardware:
**every** write to `GB_REG[GB_R_F]` masks with `0xF0`. A typical ALU op sets all
four flags in one store, which is why packed beat unpacked here.

### 2.2 Memory

| Name | Type | Covers |
|---|---|---|
| `GB_ROM` | `Uint8Array` or `null` | whole cartridge image, replaced by `gbCart_load` |
| `GB_VRAM` | `Uint8Array(0x4000)` | both banks; bank `b` offset `o` at `(b << 13) + o` |
| `GB_ERAM` | `Uint8Array(0x20000)` | cartridge RAM, always allocated at max |
| `GB_WRAM` | `Uint8Array(0x8000)` | eight 4KB banks |
| `GB_OAM` | `Uint8Array(0xA0)` | 40 sprites x 4 bytes |
| `GB_HRAM` | `Uint8Array(0x80)` | `FF80`–`FFFE` at `addr - 0xFF80` |
| `GB_IO` | `Uint8Array(0x81)` | `FF00`–`FF7F` at `addr & 0x7F`; **IE at `GB_IO_IE` = `0x80`** |

`IE` is at index `0x80`, deliberately outside the `& 0x7F` wrap, so it cannot
alias `FF7F`.

### 2.3 PPU

| Name | Type | Notes |
|---|---|---|
| `GB_TILECACHE` | `Uint8Array(65536)` | 8192 rows x 8 palette indices |
| `GB_TILEDIRTY` | `Uint8Array(8192)` | 1 = row needs decoding |
| `GB_FB` | `Uint8Array(23040)` | live framebuffer, palette slots |
| `GB_FB_PRESENT` | `Uint8Array(23040)` | last complete frame; what `getFrame()` encodes |
| `GB_PAL_RGB` | `Uint8Array(192)` | 64 slots x RGB |
| `GB_DMG_SHADES` | `Uint8Array(36)` | 3 surfaces x 4 shades x RGB, user-selectable |
| `GB_CGB_BGPAL` | `Uint8Array(64)` | BGR555 pairs, little-endian |
| `GB_CGB_OBJPAL` | `Uint8Array(64)` | as above |
| `GB_LINE_BGCOLOR` | `Uint8Array(160)` | raw BG colour 0–3, pre-palette |
| `GB_LINE_BGPRIO` | `Uint8Array(160)` | CGB BG-attr priority bit |
| `GB_LINE_SPROWNER` | `Uint8Array(160)` | 0 = unclaimed, else OAM index + 1 |
| `GB_SPR_IDX` / `GB_SPR_X` / `GB_SPR_Y` | `Uint8Array(10)` each | this line's sprites; count in `GB_CTR[GB_C_SPR_COUNT]` |

### 2.4 APU

| Name | Type | Notes |
|---|---|---|
| `GB_APU` | `Int32Array(80)` | four channels, stride `GB_A_STRIDE` = 20; channel `c` base = `c * 20` |
| `GB_APU_G` | `Int32Array(16)` | globals, `GB_AG_*` |
| `GB_WAVERAM` | `Uint8Array(16)` | `FF30`–`FF3F`, 32 nibbles, high nibble first |
| `GB_DUTY` | `Uint8Array(32)` | 4 duties x 8 steps |
| `GB_NOISE_DIV_TABLE` | `Uint16Array(8)` | `8 16 32 48 64 80 96 112` |
| `GB_AUDIO_RING` | `Int16Array(16384)` | 8192 stereo frames, interleaved L,R |
| `GB_AUDIO_OUT_I16` | `Int16Array(8192)` | drain staging, ≤ `GB_AUDIO_OUT_MAX` = 4096 frames |
| `GB_AUDIO_OUT_U8` | `Uint8Array` | byte view over the **same buffer** — no copy, no endian work |

Channel indices: `0` = NR1x square+sweep, `1` = NR2x square, `2` = NR3x wave,
`3` = NR4x noise. Per-channel offsets: `GB_A_ENABLED GB_A_DAC GB_A_DUTY
GB_A_DUTYPOS GB_A_FREQ GB_A_TIMER GB_A_ENV_VOL0 GB_A_ENV_DIR GB_A_ENV_PERIOD
GB_A_ENV_COUNT GB_A_VOLUME GB_A_LEN_ON GB_A_LEN_COUNT GB_A_WAVE_POS
GB_A_WAVE_VOLCODE GB_A_LFSR GB_A_NOISE_WIDTH GB_A_NOISE_SHIFT GB_A_NOISE_DIV
GB_A_SPARE`.

Ring counters `GB_AG_RING_WRITE`, `GB_AG_RING_READ`, `GB_AG_RING_COUNT` are in
**stereo frames**, not samples. The interleaved index is
`((frame & GB_AUDIO_FRAME_MASK) << 1)`.

### 2.5 Counters

`GB_CTR` is `Int32Array(40)`; indices 32–39 are spare and must be claimed by
adding a named constant to `gb_state.logic`, never by widening the array
elsewhere. `GB_FCTR` is `Float64Array(8)` and holds the genuinely fractional
values: `GB_F_SAMPLE_ACC`, `GB_F_CYCLES_PER_SAMPLE`, `GB_F_HOST_RATE`,
`GB_F_SAMPLES_PER_FRAME`, `GB_F_FPS`. Cycles-per-sample is 87.3813… at 48kHz;
truncating it drifts audibly inside a minute, so it has to be a double.

### 2.6 Cartridge

`GB_CART` is `Int32Array(16)`, `GB_K_*`. The three offsets — `GB_K_ROMOFF_LO`,
`GB_K_ROMOFF_HI`, `GB_K_RAMOFF` — are **precomputed byte offsets** into `GB_ROM`
and `GB_ERAM`, recomputed by `gbCart_remap()` on every bank-register write, so a
ROM read is one add and one index with no mapper branch. `GB_RTC` is
`Int32Array(8)` and `GB_RTC_EPOCH` a `Float64Array(2)` because a millisecond
timestamp does not fit in an `Int32`.

### 2.7 Input

`GB_PAD` is `Uint8Array(2)`: `[0]` live mask, `[1]` previous mask for the
high-to-low edge that raises the joypad interrupt. Bit layout in §7.3.

---

## 3. Module contracts

Functions take no state parameters — the state is global. Cycle counts are
**T-cycles** throughout (1 M-cycle = 4 T-cycles), the Pan Docs convention.

### 3.1 `gb_cart.logic`

Owns `GB_ROM`, `GB_ERAM`, `GB_CART`, `GB_RTC`, `GB_RTC_EPOCH`. Owns the address
range `0000`–`7FFF` and `A000`–`BFFF`.

```
gbCart_load(bytes)          // bytes: Uint8Array. Parses the header, sizes ERAM,
                            // picks the mapper, calls gbCart_remap(). Sets
                            // GB_CART[GB_K_CGBFLAG] from rom[0x143] and
                            // GB_CPUF[GB_P_GBC]. Returns true on success;
                            // on failure sets gbError and returns false.
gbCart_title()              // string from rom[0x134..0x143], trimmed at the
                            // first 0x00, non-printables dropped.
gbCart_remap()              // recompute GB_K_ROMOFF_LO / ROMOFF_HI / RAMOFF.
                            // MUST be called after any bank-register write.
gbCart_romRead(addr)        // 0000-7FFF -> u8
gbCart_romWrite(addr, v)    // 0000-7FFF: mapper control. Ends with gbCart_remap()
                            // if any bank register changed.
gbCart_ramRead(addr)        // A000-BFFF -> u8, 0xFF when RAM is disabled or absent
gbCart_ramWrite(addr, v)    // A000-BFFF
gbCart_batteryToBase64()    // "" when there is no battery RAM
gbCart_batteryFromBase64(s)
```

Mappers: `GB_MBC_NONE` (cart types `00 08 09`), `GB_MBC_1` (`01`–`03`),
`GB_MBC_3` (`0F`–`13`), `GB_MBC_5` (`19`–`1E`). Anything else falls back to
`GB_MBC_5` with a note in `gbError` — a wrong mapper that boots beats a refusal.

Follow the reference `cartridge.ts` exactly for: the MBC1 bank-0/`0x20`/`0x40`/
`0x60` +1 quirk and its mode-1 remapping of the low window; MBC5's split
`2000`–`2FFF` / `3000`–`3FFF` 9-bit bank register; MBC3's RTC register file at
RAM-bank selects `08`–`0C` and its `6000`–`7FFF` `0`→`1` latch sequence. Masks
are `banks - 1` where `banks = max(2, romLength >> 14)`, and
`GB_K_RAMMASK = ramSize - 1` (RAM sizes are powers of two).

The save-heuristic machinery in the reference (`consumeSaveEvent`,
`ramSnapshot`, write counting) is **out of scope**. Expose `gbCart_ramDirty()`
and let `main.logic` persist on a timer.

### 3.2 `gb_mmu.logic`

Owns the bus, `GB_WRAM`, `GB_HRAM`, `GB_IO`, OAM DMA, HDMA/GDMA, the joypad, the
serial stub, and interrupt request/dispatch bookkeeping.

```
gbMmu_read(addr)            // -> u8. Honours the OAM-DMA lockout.
gbMmu_write(addr, v)
gbMmu_readDma(addr)         // bypasses the lockout; only the OAM DMA engine calls it
gbMmu_readIo(addr)          // FF00-FF7F
gbMmu_writeIo(addr, v)
gbMmu_requestIrq(bit)       // GB_IO[0x0F] |= (1 << bit), masked to 0x1F
gbMmu_clearIrq(bit)
gbMmu_stepOamDma(cycles)
gbMmu_hblankHdma()          // called by gb_ppu on the mode 3 -> mode 0 edge
gbMmu_writeP1(v)            // FF00 select bits
gbMmu_readP1()              // FF00
gbMmu_setButtons(mask)      // see §7.3; raises the joypad IRQ on a new press
```

**VRAM writes.** `gbMmu_write` for `8000`–`9FFF` is exactly:

```
let flat = (GB_CTR[GB_C_VRAM_BANK] << 13) | (addr - 0x8000)
GB_VRAM[flat] = v
gbPpu_dirtyVram(flat)
```

`gbPpu_dirtyVram` is defined in `gb_ppu.logic` as a single unconditional store —
see §4. `gb_mmu` may inline that store, but if it does, the inlined form must be
byte-identical to the function body, and the function must still exist because
the HDMA/GDMA path and the save-state loader call it too.

**OAM DMA.** As the reference: `FF46` arms a 644-T-cycle window (4 start delay +
640 streaming), one byte per M-cycle, and the CPU sees `0xFF` for every access
below `FF80` while it runs — except a write to `FF46` itself, which restarts the
transfer. `gbMmu_stepOamDma` streams `floor(cycles / 4)` bytes per call so cart
code reading OAM mid-transfer sees the partial state.

**HDMA/GDMA.** CGB only. `FF51`–`FF54` are write-only and read `0xFF`. `FF55`
bit 7 selects HBlank mode; writing bit 7 = 0 while an HBlank transfer is active
cancels it. General DMA copies the whole length immediately. Both paths write
through `GB_VRAM` and **must** dirty each row they touch.

**Serial.** `FF01`/`FF02` are a stub: `FF01` stores to `GB_IO`, a write to
`FF02` with bit 7 set completes the transfer after 8 x 512 T-cycles (internal
clock), loads `0xFF` into `SB` and raises the serial IRQ. Enough that games
which wait on it do not hang. No link cable.

**Echo RAM.** `E000`–`FDFF` mirrors `C000`–`DDFF` through the same bank
arithmetic. `FEA0`–`FEFF` reads `0xFF` and drops writes.

### 3.3 `gb_ops.logic`

Owns `GB_OPS` and `GB_CBOPS` and nothing else.

```
gbOps_buildTables()         // fills all 512 slots. Called once from gbMachine_init.
gbOps_illegal()             // fills the illegal opcodes. Returns 4.
```

Every table entry is `function () { ... return cycles }` — **no parameters**,
returning the T-cycles the instruction consumed **including** its memory
accesses, matching the reference `ops.ts` numbers. Conditional branches return
the taken count when taken and the not-taken count otherwise.

`0xCB` is `function () { let cb = gbCpu_fetchU8(); return 4 + GB_CBOPS[cb]() }`,
with the CB handlers returning their own cost the same way (8 for register
forms, 16 for `(HL)`, 12 for `BIT n,(HL)`).

Pattern-regular families (`LD r,r'`, the eight ALU ops, the whole CB table) are
**generated in a loop** at build time, not written out by hand. Generating them
means each is a closure over its loop variables — that is fine and expected,
because it happens once at init, never per frame. Rule 1.5 forbids allocating in
the *hot loop*, not at table-build time.

The irregular opcodes are spelled out: `DAA`, `STOP`, `HALT`, `EI`/`DI`,
`ADD SP,e8`, `LD HL,SP+e8`, `LDH`, the jumps, the stack ops, the RSTs.

`gb_ops` **inlines** the register-pair maths. Do not call `gbState_hl()` from an
opcode handler; write `((GB_REG[GB_R_H] << 8) | GB_REG[GB_R_L])`. The `gbState_`
accessors exist for cold code — headers, save states, the debugger.

The reference's `tickM` per-M-cycle machinery is **out of scope**. Pocket ticks
peripherals in 4-cycle chunks between instructions (§3.8), which is a documented
accuracy loss against `ie_push` and the tightest Mooneye timing tests and buys
back a large share of the CPU budget.

### 3.4 `gb_cpu.logic`

Owns instruction sequencing and interrupt dispatch.

```
gbCpu_reset(gbc)            // post-boot register values per cpu.ts BOOT_REGS:
                            // DMG-ABC A=01 F=B0 B=00 C=13 D=00 E=D8 H=01 L=4D
                            // CGB     A=11 F=80 B=00 C=00 D=FF E=56 H=00 L=0D
                            // SP=FFFE PC=0100 in both. Seeds GB_CTR[GB_C_DIV]
                            // with 0xABCC (DMG) or 0x2680 (CGB).
gbCpu_fetchU8()             // read at PC, advance PC unless GB_CPUF[GB_P_HALTBUG]
gbCpu_fetchU16()
gbCpu_push16(v)
gbCpu_pop16()
gbCpu_step()                // -> T-cycles. One instruction, or 4 while halted.
gbCpu_serviceIrq()          // -> 20 on dispatch, 0 otherwise
```

`gbCpu_step()` must, in order: honour `HALT` (return 4 without fetching);
fetch; dispatch through `GB_OPS`; promote a pending `EI` to `IME` after the
following instruction; and detect the HALT bug (`HALT` executed with `IME = 0`
and `IE & IF & 0x1F` non-zero clears halted and sets `GB_P_HALTBUG`).

`gbCpu_serviceIrq()` wakes a halted CPU on any pending interrupt regardless of
`IME`, and dispatches only when `IME` is set: clear `IME`, clear the winning `IF`
bit (lowest bit number wins), push `PC`, jump to `0x40 + bit * 8`, return 20.

### 3.5 `gb_timer.logic`

Owns `FF04`–`FF07` and `GB_CTR[GB_C_DIV]`.

```
gbTimer_step(cycles)
gbTimer_readDiv()           // (GB_CTR[GB_C_DIV] >> 8) & 0xFF
gbTimer_writeDiv()          // zeroes the whole 16-bit counter, then edge-checks
gbTimer_writeTima(v)
gbTimer_writeTma(v)
gbTimer_writeTac(v)
```

TIMA is incremented by the **falling edge** of `(DIV_bit AND TAC.enable)`, not by
a periodic counter. `DIV_bit` is `[9, 3, 5, 7][TAC & 3]`. Writing `DIV` while the
selected bit is high therefore increments TIMA — the quirk Pokémon's RNG rests
on. Keep the 4-cycle post-overflow window (`GB_C_TIMA_PENDING`) during which
TIMA reads `0x00`, no IRQ has fired, and a write to TIMA cancels the reload, plus
the one-M-cycle `GB_C_TIMER_RELOADED` window in which a TIMA write is dropped and
a TMA write is adopted.

`TIMA`/`TMA`/`TAC` are canonical in `GB_IO[0x05]`/`[0x06]`/`[0x07]`. `TAC` reads
back OR `0xF8`. `GB_IO[0x04]` is unused; `DIV` is always derived.

### 3.6 `gb_ppu.logic`

Owns `FF40`–`FF4B`, `FF4F`, `FF68`–`FF6C`, `GB_VRAM` *content interpretation*,
`GB_OAM` interpretation, the tile cache, the framebuffer and the palette.

```
gbPpu_step(cycles)
gbPpu_readReg(addr)
gbPpu_writeReg(addr, v)
gbPpu_dirtyVram(flat)       // exactly: GB_TILEDIRTY[flat >>> 1] = 1
gbPpu_ensureTileRow(row)    // decode row if dirty; returns nothing
gbPpu_scanSprites()         // fill GB_SPR_* for the current LY
gbPpu_renderLine()          // draw one whole scanline into GB_FB
gbPpu_buildPalette()        // rebuild GB_PAL_RGB, bump GB_CTR[GB_C_PAL_REV]
gbPpu_setDmgShades(b64)     // 36 bytes, 3 surfaces x 4 shades x RGB
```

**Rendering model.** Pocket is a **scanline** renderer, not the reference's
per-dot pixel FIFO. The FIFO measured 13.8ms/frame in `.logic`, which is the
whole budget before the APU runs. The mode state machine, LY, LYC, STAT and all
interrupt timing are kept cycle-accurate; only the pixel production is batched.

Per line:

| Point | Work |
|---|---|
| entering mode 2 | `gbPpu_scanSprites()` |
| entering mode 3 | `gbPpu_renderLine()` — the entire 160 pixels, at once |
| entering mode 0 | `gbMmu_hblankHdma()` |
| end of mode 0 | `LY++`, `gbPpu_checkLyc()` |
| `LY` reaches 144 | mode 1, VBlank IRQ, `GB_FB` → `GB_FB_PRESENT`, `gbPpu_buildPalette()`, `GB_CTR[GB_C_FRAME]++` |

Mode 3 length: `172 + (SCX & 7) + 6 * spriteCount`, clamped to `[172, 289]`.
Mode 0 is `456 - 80 - mode3`. Keep the reference's line-153 quirk (`LY` reads 0
for the last 452 dots of the frame) and its LCD-off behaviour (`LY = 0`, mode 0,
counters cleared).

**Accepted deviation.** Because a line is drawn in one go at the mode-3 edge,
mid-line writes to `SCX`, `SCY`, `LCDC`, `WX` or `WY` do not split the line.
Mid-*frame* writes work normally, so parallax and status bars are fine; only
per-pixel raster tricks inside a single scanline are lost. This is the one place
Pocket knowingly diverges from `ppu.ts`.

**Tile-row cache.** See §4.

**Framebuffer encoding.** One byte per pixel, a slot in a 64-entry palette:

```
slot 0..31    background / window   slot = bgPalette  * 4 + colorIndex
slot 32..63   sprite                slot = 32 + objPalette * 4 + colorIndex
```

On CGB, `bgPalette`/`objPalette` are the 0–7 from the tile or OAM attribute and
`colorIndex` is the raw 0–3 from the tile. On DMG, `bgPalette` is 0, `objPalette`
is 0 for OBP0 and 1 for OBP1, and `colorIndex` is the **shade** — the raw colour
already mapped through `BGP`/`OBP0`/`OBP1` at the instant the pixel was written.
That asymmetry is deliberate: DMG games change `BGP` mid-frame constantly (fades,
flashes), and resolving DMG palettes at end of frame would lose every one of
them. CGB palette RAM is resolved at frame end instead, which loses the much
rarer mid-frame CGB palette write.

`gbPpu_buildPalette()` fills `GB_PAL_RGB`:
- DMG: slots 0–3 from `GB_DMG_SHADES` surface 0, slots 32–35 from surface 1,
  slots 36–39 from surface 2. All other slots zero.
- CGB: slot `p*4+c` from `GB_CGB_BGPAL[p*8 + c*2]` / `[p*8 + c*2 + 1]` and slot
  `32 + p*4 + c` from `GB_CGB_OBJPAL` likewise, expanding BGR555 with the
  standard `(x << 3) | (x >> 2)` so `0x1F` reaches `0xFF`.

It bumps `GB_CTR[GB_C_PAL_REV]` **only when the bytes actually changed**, so the
canvas can skip rebuilding its lookup table.

**Sprites.** Up to 10 per line, gathered in OAM order then insertion-sorted by
`(x, oamIndex)`. Priority at draw time: DMG and CGB with `OPRI = 1` are
first-writer-wins, which after that sort is exactly "lower X, then lower OAM";
CGB with `OPRI = 0` is lower-OAM-wins regardless of X, resolved through
`GB_LINE_SPROWNER`. A sprite pixel of colour 0 is transparent and never claims
a pixel. A sprite loses to the background when its OAM priority bit is set and
the BG colour is non-zero, or (CGB) when the BG attribute priority bit is set and
`LCDC.0` is set.

### 3.7 `gb_apu.logic`

Owns `FF10`–`FF3F`, `GB_APU`, `GB_APU_G`, `GB_WAVERAM`, `GB_AUDIO_RING`.

```
gbApu_step(cycles)
gbApu_readReg(addr)
gbApu_writeReg(addr, v)
gbApu_drain(maxFrames)      // -> stereo frames written into GB_AUDIO_OUT_I16
gbApu_reset()
```

Frame sequencer at 512Hz (every 8192 T-cycles): steps 0/2/4/6 length, 2/6 sweep,
7 envelope. Channel timers, envelopes, sweep, LFSR and wave playback follow
`apu.ts` exactly, including: the NR52 power-off register wipe; wave RAM staying
writable while the APU is off; only the length sub-registers being writable while
off; and the sweep overflow check firing both on trigger and on each sweep tick.

**Sampling.** `GB_FCTR[GB_F_SAMPLE_ACC] += cycles`; while it is at least
`GB_FCTR[GB_F_CYCLES_PER_SAMPLE]`, subtract and emit one stereo frame. Mixing:
each channel is 0–15, `NR51` routes (bits 0–3 right, 4–7 left), `NR50` gives
per-side volume 0–7. Normalise to signed 16-bit as

```
s16 = round((sum * (vol + 1) / (60 * 8)) * 32767)
```

clamped to `[-32768, 32767]`, and store L then R at
`((GB_APU_G[GB_AG_RING_WRITE] & GB_AUDIO_FRAME_MASK) << 1)`. On overrun advance
the read pointer — dropping the oldest frame is better than blocking.

`gbApu_drain(maxFrames)` copies up to `min(maxFrames, ringCount,
GB_AUDIO_OUT_MAX)` stereo frames into `GB_AUDIO_OUT_I16` starting at index 0 and
returns the count. On underrun (`ringCount` is 0) it returns 0 and increments
`GB_APU_G[GB_AG_UNDERRUNS]`; it must **not** pad — `<AudioStream>` handles gaps.

### 3.8 `gb_machine.logic`

Owns integration and every host-facing entry point.

```
gbMachine_init()            // gbOps_buildTables(), gbState_reset(). Once, ever.
gbMachine_reset()
gbMachine_loadRomBase64(s)  // -> bool. Uint8Array.fromBase64, gbCart_load,
                            // gbMachine_reset, sets gbTitle/gbMapperName/gbGbcMode.
gbMachine_stepCycles(n)     // advance n T-cycles
gbMachine_advanceFrame()    // advance until GB_CTR[GB_C_FRAME] changes, or until
                            // 2 * GB_CYCLES_PER_FRAME have been spent
gbMachine_getFrame()        // §7.1
gbMachine_getSamples(want)  // §7.2
gbMachine_setButtons(mask)  // §7.3
gbMachine_setSampleRate(r)  // wraps gbState_setSampleRate
```

The inner loop of `gbMachine_stepCycles`:

```
while (budget > 0) {
  let c = gbCpu_serviceIrq()
  if (c === 0) { c = gbCpu_step() }
  gbMachine_tickParts(c)
  budget = budget - c
}
```

`gbMachine_tickParts(c)` ticks in 4-cycle chunks — `gbTimer_step`, `gbPpu_step`,
`gbApu_step`, `gbMmu_stepOamDma` — so the timer and STAT logic see the right
M-cycle inside a long instruction. `gbMachine_tickParts` is the one place that
knows the order, and the order matters: timer first (it can raise an IRQ the PPU
step then races), PPU second (it drives HBlank HDMA), APU third, OAM DMA last.

A runaway guard mirrors the reference: more than 5,000,000 cycles in one slice
sets `gbError`, clears `gbRunning`, and returns.

**Pacing.** `gbMachine_advanceFrame()` runs at most one emulated frame per call,
and skips even that when the audio ring is already more than three frames ahead:

```
if (GB_APU_G[GB_AG_ACTIVE] === 1 &&
    GB_APU_G[GB_AG_RING_COUNT] > 3 * GB_FCTR[GB_F_SAMPLES_PER_FRAME]) { return }
```

The guard on `GB_AG_ACTIVE` matters: with audio muted the ring never drains, and
without it a silent bundle would freeze on the first frame. On a 120Hz display
this makes the audio clock the emulator, which is what you want; on a 60Hz
display it never triggers.

---

## 4. VRAM writes and tile-cache invalidation

This is the single most load-bearing interface in the bundle. Get it wrong and
the picture is subtly, intermittently stale — the worst possible failure.

A tile row is two bytes. The cache is indexed by **flat VRAM byte offset >> 1**,
across the whole of both banks, including the tilemap region:

```
flat      = (bank << 13) | (addr - 0x8000)     // 0 .. 0x3FFF
rowIndex  = flat >>> 1                          // 0 .. 0x1FFF
cacheBase = rowIndex << 3                       // 8 bytes, left pixel first
srcByte   = rowIndex << 1                       // back to the pair's low byte
```

Because `flat = tile * 16 + row * 2 + k` for `k` in `{0, 1}`, `flat >>> 1` is
exactly `tile * 8 + row` within the bank — the same index for both bytes of the
pair, with no division and no branch. Covering the tilemap region costs 16KB of
never-read cache and buys an invalidation with no bounds test at all.

**The notification.** `gb_ppu.logic` defines exactly:

```
function gbPpu_dirtyVram(flat) {
  GB_TILEDIRTY[flat >>> 1] = 1
}
```

Every path that mutates `GB_VRAM` must call it, or inline that identical store,
immediately after the store to `GB_VRAM`:

1. `gbMmu_write` for `8000`–`9FFF`.
2. `gbMmu_hblankHdma` — once per byte, or once per pair.
3. The general-DMA branch of the `FF55` handler.
4. Any save-state or debug loader — those should call
   `gbState_invalidateTileCache()` and dirty everything instead.

**The decode.** Lazy, at fetch time, never on write:

```
function gbPpu_ensureTileRow(row) {
  if (GB_TILEDIRTY[row] === 0) { return }
  let s = row << 1
  let lo = GB_VRAM[s]
  let hi = GB_VRAM[s + 1]
  let d = row << 3
  GB_TILECACHE[d]     = (((hi >>> 7) & 1) << 1) | ((lo >>> 7) & 1)
  GB_TILECACHE[d + 1] = (((hi >>> 6) & 1) << 1) | ((lo >>> 6) & 1)
  GB_TILECACHE[d + 2] = (((hi >>> 5) & 1) << 1) | ((lo >>> 5) & 1)
  GB_TILECACHE[d + 3] = (((hi >>> 4) & 1) << 1) | ((lo >>> 4) & 1)
  GB_TILECACHE[d + 4] = (((hi >>> 3) & 1) << 1) | ((lo >>> 3) & 1)
  GB_TILECACHE[d + 5] = (((hi >>> 2) & 1) << 1) | ((lo >>> 2) & 1)
  GB_TILECACHE[d + 6] = (((hi >>> 1) & 1) << 1) | ((lo >>> 1) & 1)
  GB_TILECACHE[d + 7] = ((hi & 1) << 1) | (lo & 1)
  GB_TILEDIRTY[row] = 0
}
```

Unrolled, no inner loop. Eager decoding on write is strictly worse: games blit
far more VRAM bytes than they display tile rows.

**X-flip is not cached separately.** Read the eight bytes backwards.

**Computing `row` from a tile index.** For BG/window, with `LCDC.4` selecting
signed or unsigned tile addressing:

```
tileBase = (LCDC & 0x10) !== 0 ? tileIndex * 16
                               : 0x1000 + ((tileIndex < 128 ? tileIndex : tileIndex - 256) * 16)
row      = ((bank << 13) + tileBase + lineInTile * 2) >>> 1
```

For sprites, addressing is always unsigned from `0x0000`, and 8x16 sprites mask
the tile index with `0xFE`.

---

## 5. IO register ownership

One module owns each range. Nobody reaches into another module's registers; they
call its `readReg`/`writeReg`. "Canonical in `GB_IO`" means the byte in `GB_IO`
*is* the register; "derived" means it is computed on read and `GB_IO` holds
nothing meaningful.

| Range | Owner | Storage |
|---|---|---|
| `FF00` P1 | `gb_mmu` | select bits canonical in `GB_IO[0x00]`; pressed state in `GB_PAD`; read is derived |
| `FF01`–`FF02` SB/SC | `gb_mmu` | canonical in `GB_IO`; countdown in `GB_CTR[GB_C_SERIAL_CYCLES]` |
| `FF04` DIV | `gb_timer` | derived from `GB_CTR[GB_C_DIV]`; `GB_IO[0x04]` unused |
| `FF05`–`FF07` TIMA/TMA/TAC | `gb_timer` | canonical in `GB_IO` |
| `FF0F` IF | `gb_mmu` | canonical in `GB_IO[0x0F]`, low 5 bits; reads OR `0xE0` |
| `FF10`–`FF26` NRxx | `gb_apu` | raw last-written byte in `GB_IO` for readback masks; behaviour in `GB_APU`/`GB_APU_G` |
| `FF30`–`FF3F` wave RAM | `gb_apu` | canonical in `GB_WAVERAM` |
| `FF40` LCDC | `gb_ppu` | canonical in `GB_IO[0x40]` |
| `FF41` STAT | `gb_ppu` | canonical in `GB_IO[0x41]`; low 2 bits mirror `GB_CTR[GB_C_PPU_MODE]`; reads OR `0x80` |
| `FF42`–`FF43` SCY/SCX | `gb_ppu` | canonical in `GB_IO` |
| `FF44` LY | `gb_ppu` | canonical in `GB_IO[0x44]`; **only `gb_ppu` writes it**; a cart write resets it to 0 |
| `FF45` LYC | `gb_ppu` | canonical; write re-runs `gbPpu_checkLyc()` |
| `FF46` DMA | `gb_mmu` | canonical; write arms the OAM DMA |
| `FF47`–`FF49` BGP/OBP0/OBP1 | `gb_ppu` | canonical in `GB_IO`; DMG only, ignored on CGB carts that never write them |
| `FF4A`–`FF4B` WY/WX | `gb_ppu` | canonical in `GB_IO` |
| `FF4D` KEY1 | `gb_mmu` | `GB_CPUF[GB_P_DOUBLE]` / `[GB_P_SPEEDSW]`; CGB only |
| `FF4F` VBK | `gb_ppu` | `GB_CTR[GB_C_VRAM_BANK]`; reads OR `0xFE`; CGB only |
| `FF50` boot disable | `gb_mmu` | ignored — Pocket starts post-boot |
| `FF51`–`FF55` HDMA | `gb_mmu` | `GB_CTR[GB_C_HDMA_*]`; `FF51`–`FF54` read `0xFF` |
| `FF56` RP | — | reads `0xFF`, writes dropped |
| `FF68`–`FF69` BCPS/BCPD | `gb_ppu` | index in `GB_CTR[GB_C_CGB_BGPAL_IDX]` (bit 7 = auto-increment); data in `GB_CGB_BGPAL` |
| `FF6A`–`FF6B` OCPS/OCPD | `gb_ppu` | index in `GB_CTR[GB_C_CGB_OBJPAL_IDX]`; data in `GB_CGB_OBJPAL` |
| `FF6C` OPRI | `gb_ppu` | `GB_CTR[GB_C_CGB_OPRI]`; reads OR `0xFE` |
| `FF70` SVBK | `gb_mmu` | `GB_CTR[GB_C_WRAM_BANK]`; 0 acts as 1; reads OR `0xF8` |
| everything else in `FF00`–`FF7F` | — | reads `0xFF`, writes dropped |
| `FF80`–`FFFE` HRAM | `gb_mmu` | `GB_HRAM` |
| `FFFF` IE | `gb_mmu` | `GB_IO[GB_IO_IE]`, low 5 bits |

The reference's `FF60`–`FF63` extended input and `FF7F` sprite overlay are
emulator-private extensions and are **not** implemented. They read `0xFF`.

---

## 6. Interrupts

`IF` is `GB_IO[0x0F]`, `IE` is `GB_IO[GB_IO_IE]`, both low 5 bits. Bit order and
vectors:

| Bit | Source | Vector | Raised by |
|---|---|---|---|
| 0 | VBlank | `0x40` | `gb_ppu` on `LY` reaching 144 |
| 1 | LCD STAT | `0x48` | `gb_ppu`, 4 T-cycles after the STAT line goes high |
| 2 | Timer | `0x50` | `gb_timer` at the end of the overflow window |
| 3 | Serial | `0x58` | `gb_mmu` when the stub transfer completes |
| 4 | Joypad | `0x60` | `gb_mmu` on a new press in `gbMmu_setButtons` |

Lowest bit number wins. Everything raises through `gbMmu_requestIrq(bit)`; only
`gbCpu_serviceIrq()` clears on dispatch.

The STAT line is the OR of: LYC match with `STAT.6`; mode 2 with `STAT.5`; mode 1
with `STAT.4`; mode 0 with `STAT.3`; plus the mode-2-on-VBlank-entry case. The
interrupt fires on the **rising edge** of that line only, after a 4-cycle delay
held in `GB_CTR[GB_C_STAT_DELAY]` (`-1` when idle).

---

## 7. Host wire formats

Two generic primitives, neither of which knows what a console is.

### 7.1 `<PixelCanvas>` — `getFrame()`

`PixelCanvas` calls its `getFrame` prop once per `requestAnimationFrame` and
paints the result with `putImageData`. It is the canvas-backed counterpart to
`PixelGrid`'s sparse-cell model and must work for any dense bitmap.

`gbMachine_getFrame()` advances the machine one frame (subject to §3.8 pacing)
and returns a plain object:

```js
{
  w: 160,
  h: 144,
  format: "p8",        // one byte per pixel, an index into `palette`
  pixels: "<base64>",  // 23040 bytes -> 30720 chars
  palette: "<base64>", // 192 bytes -> 256 chars: 64 entries x R,G,B
  paletteRev: 7,       // bumps only when `palette` actually changed
  frame: 1234,         // emulator frame counter
  running: true
}
```

Produced by:

```
GB_FB_PRESENT.toBase64()
GB_PAL_RGB.toBase64()
```

`GB_FB_PRESENT` is the last **complete** frame, snapshotted at the VBlank edge.
Encoding the live `GB_FB` would tear whenever the host's rAF and the emulated
59.7275Hz drift past each other, which they do continuously.

`PixelCanvas` contract:
- Decode `pixels` once per call into a reusable `Uint8Array`.
- Decode `palette` only when `paletteRev` changes, into a reusable
  `Uint32Array(64)` of packed RGBA (`0xFF << 24 | b << 16 | g << 8 | r`).
- Skip `putImageData` entirely when `frame` is unchanged from the previous call.
- Alpha is implicit: every palette entry is fully opaque.
- `format: "p8"` is the only format Pocket emits. `PixelCanvas` should also
  accept `"rgba"` (4 bytes per pixel, no palette) so it stays generic.
- `w`/`h` may change between calls; size the backing `ImageData` from them.

Cost: 23040 bytes through `toBase64` plus a 30KB string across the boundary. The
92KB string measurement of 0.05ms puts this comfortably inside the 1.5ms encode
budget.

### 7.2 `<AudioStream>` — `getSamples()`

`AudioStream` calls its `getSamples` prop and schedules the result through queued
`AudioBufferSourceNode`s for gapless playback.

Before the first call the host must tell logic the context rate, exactly once
per `AudioContext`:

```
gbMachine_setSampleRate(ctx.sampleRate)
```

`gbMachine_getSamples(want)` — `want` is the number of stereo frames the host
would like, and may be omitted — returns:

```js
{
  rate: 48000,       // the rate the PCM is at; always === ctx.sampleRate
  channels: 2,
  format: "s16le",   // signed 16-bit, little-endian, L,R interleaved
  frames: 804,       // stereo frames actually delivered; may be 0
  pcm: "<base64>",   // frames * 4 bytes
  underruns: 0
}
```

Produced by `gbApu_drain(n)` into `GB_AUDIO_OUT_I16`, then:

```
GB_AUDIO_OUT_U8.subarray(0, frames * 4).toBase64()
```

`GB_AUDIO_OUT_U8` is a byte view over the **same** buffer as
`GB_AUDIO_OUT_I16`, so there is no copy and no endian conversion.
`Int16Array` is native-endian and every target is little-endian, hence `s16le`.

**Sample count per frame.** Derived from the context rate, not assumed:

```
samplesPerFrame = rate * 70224 / 4194304 = rate / 59.7275005
```

48000 → 803.650, 44100 → 738.353. `gbState_setSampleRate` stores this in
`GB_FCTR[GB_F_SAMPLES_PER_FRAME]` and sets
`GB_FCTR[GB_F_CYCLES_PER_SAMPLE] = 4194304 / rate`. Because it is fractional, the
count varies by one frame to the next — **`AudioStream` must use the returned
`frames`, never a constant.**

`AudioStream` contract:
- Call `getSamples` on its own schedule, driven by how far ahead the scheduled
  queue runs; do not tie it to `requestAnimationFrame`.
- Ask for roughly two video frames' worth (`~1600` at 48kHz) and keep about
  three buffered. The ring holds 8192 frames — 170ms at 48kHz — so a late
  callback costs nothing.
- `frames: 0` means underrun. Schedule nothing and try again; do not insert
  silence, which lands as a click.
- Never advance the emulator from `getSamples`. `getFrame` owns advancing.
- `format` should be treated as an enum; Pocket emits only `"s16le"`, but
  `AudioStream` should also accept `"f32"` to stay generic.

### 7.3 Joypad

`gbMachine_setButtons(mask)` takes one byte, **active high** — a 1 bit is a
pressed button:

| Bit | Value | Button |
|---|---|---|
| 0 | `0x01` | A |
| 1 | `0x02` | B |
| 2 | `0x04` | Select |
| 3 | `0x08` | Start |
| 4 | `0x10` | Right |
| 5 | `0x20` | Left |
| 6 | `0x40` | Up |
| 7 | `0x80` | Down |

The ordering is the DMG's own two nibbles, so `P1` is a shift and a mask rather
than eight tests. Hardware is active **low** and `gb_mmu` does the inversion:

```
// FF00 read. select bits are GB_IO[0x00] & 0x30, active low.
let v = 0xCF | (GB_IO[0x00] & 0x30)
if ((GB_IO[0x00] & 0x20) === 0) { v = v & ~(GB_PAD[0] & 0x0F) }        // action
if ((GB_IO[0x00] & 0x10) === 0) { v = v & ~((GB_PAD[0] >>> 4) & 0x0F) } // direction
return v & 0xFF
```

Send the **whole mask** every time it changes, not deltas. `gbMmu_setButtons`
compares against `GB_PAD[1]` and raises the joypad interrupt on any newly-set
bit, then stores the new mask into both slots.

Opposing directions (Left+Right, Up+Down) are passed through unmodified. Real
hardware allows them and a few games rely on the glitch; sanitising is the UI's
choice, not the emulator's.

### 7.4 UI-facing scalars

The only plain-value globals templates bind to. Adding to this list costs a read
and a deep compare on every host call.

| Name | Type | Meaning |
|---|---|---|
| `gbTitle` | string | cart header title |
| `gbRunning` | bool | emulation is advancing |
| `gbRomLoaded` | bool | a cart is in |
| `gbGbcMode` | bool | CGB features active |
| `gbMapperName` | string | `"MBC1"`, `"MBC5"`, … |
| `gbFps` | number | measured, one decimal |
| `gbFrameCounter` | number | frames since reset |
| `gbStatus` | string | short human line |
| `gbError` | string | empty when healthy |

---

## 8. Budget

60fps is 16.67ms per frame. Measured on a Ryzen 9 9950X3D against the shipping
zipp WASM:

| Stage | Budget | Basis |
|---|---|---|
| CPU + MMU + timer | 6.1ms | measured, function-table dispatch |
| PPU | ≤ 4.0ms | requires the tile-row cache; the per-dot FIFO was 13.8ms |
| APU | ≤ 1.5ms | |
| Frame + audio encode | ≤ 1.5ms | 23040 + ~3216 bytes through `toBase64` |
| State sync | ~0.05ms | ~230 scalars + 512 function slots, 3 host calls |
| **Total** | **~13.2ms** | 3.4ms of headroom |

If the PPU exceeds 4ms the frame is gone. Any change to it should be measured,
not reasoned about.

---

## 9. Out of scope

Named so nobody implements them by accident:

- The reference's `tickM` per-M-cycle memory-access timing.
- The pixel FIFO, sprite fetcher and their sub-scanline effects.
- `traceRecorder`, `spriteOverlay` (`FF7F`), `inputExtended` (`FF60`–`FF63`).
- Link-cable serial beyond the self-clocked stub.
- The cartridge save-event heuristic.
- Boot ROMs. Pocket starts at `PC = 0x0100` with the post-boot register set.
