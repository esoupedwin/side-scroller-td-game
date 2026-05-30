# COIN — Game Terminology

Technical terms used in the COIN codebase. Intended as a reference for developers.

---

## Camera Clamps

Limits that prevent the camera from scrolling outside the bounds of the map.

The game uses a 2D camera that can pan horizontally (X) and vertically (Y). Each axis has a minimum and maximum value beyond which scrolling stops.

### Camera Y

Vertical scroll offset, in world pixels, relative to the default ground-anchored position.

- **Positive** — scrolled up; world Y = 0 (top of map) moves toward the canvas top.
- **Negative** — scrolled down; content below the ground moves toward the canvas top.
- **0** is not the default. The default is computed per-map so the ground surface sits 60 px above the canvas bottom (see `build()` in `Game.ts`).

The world container's vertical position each frame:

```
world.y = mapGroundY × (1 − GAME_ZOOM) + cameraY × GAME_ZOOM
```

**Upper clamp (`camYMax`)** — prevents scrolling past the top of the map. Reached when world Y = 0 is at the canvas top (screen Y = 0):

```
camYMax = max(0, mapGroundY × (GAME_ZOOM − 1) / GAME_ZOOM)
```

**Lower clamp (`camYMin`)** — prevents scrolling past the bottom of the map. Reached when the map's bottom edge (`worldHeight`) is at the canvas bottom (screen Y = GAME_HEIGHT):

```
camYMin = min(0, GAME_HEIGHT / GAME_ZOOM − worldHeight + mapGroundY × (GAME_ZOOM − 1) / GAME_ZOOM)
```

On standard maps (where GAME_ZOOM zooms in and the ground is near the canvas bottom), `camYMin` evaluates to a small negative number, giving only a slight downward scroll. On taller maps it allows significant downward travel.

### Camera X

Horizontal scroll offset, in world pixels from the left edge of the map.

- **0** — leftmost position (default on game start/reset).
- Increases when scrolling right.

**Clamp:**

```
cameraX ∈ [0, worldWidth − VIEWPORT_WIDTH / GAME_ZOOM]
```

The right clamp ensures the right edge of the viewport never exceeds the right edge of the world.

### Zoom anchor

`GAME_ZOOM` scales the entire world container. Without correction the zoom would shift the ground off screen. The term `mapGroundY × (1 − GAME_ZOOM)` in the `world.y` formula is the **zoom anchor** — it offsets the container so that `mapGroundY` (the walking surface) remains at a stable screen position when `cameraY = 0`.

---

## mapGroundY

The Y coordinate (in world space) of the walkable ground surface for a given map. Computed in `build()`:

```
mapGroundY = worldHeight − groundHeight
```

where `groundHeight` defaults to `GAME_HEIGHT − GROUND_Y` (the global constant) when not set on the map. Every system that previously referenced the global `GROUND_Y` constant now receives `mapGroundY` so maps with custom ground heights work correctly.
