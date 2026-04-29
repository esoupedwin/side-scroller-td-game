/** Two collision modes for game entities. */
export type CollisionBoxType = 'solid' | 'passthrough';

/**
 * Axis-aligned bounding box used by the debug overlay and physics setup.
 * - solid:       blocks movement (tower walls)
 * - passthrough: sensor / one-way; does not fully obstruct (platform, coin box)
 */
export interface CollisionBoxData {
  x:      number;   // left edge
  y:      number;   // top edge
  width:  number;
  height: number;
  type:   CollisionBoxType;
  label:  string;
}
