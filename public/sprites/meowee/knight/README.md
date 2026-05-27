# meowee / knight — sprite sheet spec

## Folder layout
```
body/
  idle.png     ← required
  walk.png     ← required
  attack.png   ← required
  carry.png    ← optional (falls back to walk → idle)
legs/
  idle.png     ← required
  walk.png     ← required
```

Both layers **must** have at least one PNG present or the loader falls
back to the code-drawn Graphics sprite for *both* layers.

## Sheet format
- Frames laid out **left-to-right** in rows of exactly **6 frames** (`FRAMES_PER_ROW`).
- Frame height: **800 px** (`FRAME_HEIGHT_PX`). Frame width: any (usually square cells).
- Row count is auto-derived from `sheet.height / 600`; the actual frame count
  inside each row is auto-detected by scanning for non-empty cells.
- Both layers share the same `spriteScale` (default **4.0**):
  rendered height = `config.height × spriteScale` = `32 × 4 = 128 px`.
- Sheets must be drawn **facing right**; the engine flips them for the enemy side.

## Animation notes
- **body/attack.png** — sword swing; frame 0 = wind-up, last frame = follow-through.
- **body/carry.png** — shield raised / marching with loot; can reuse walk frames.
- **legs/** — share the same anchor and scale as body; keep frame dimensions identical.
