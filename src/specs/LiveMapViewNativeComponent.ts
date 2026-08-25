/**
 * Fabric component spec — the complete native map view.
 *
 * NOT YET IMPLEMENTED. This file is the frozen contract; the Kotlin ViewManager
 * that satisfies it is the remaining work (see LLD §7b).
 *
 * WHY A WHOLE COMPONENT RATHER THAN A FAST PATH
 *
 * An earlier attempt reached into MapLibre's existing RN view, found its
 * GeoJSON source by id, and called `setGeoJson` from Kotlin. That was the wrong
 * shape of solution and it failed for a structural reason worth recording:
 * `setGeoJson` re-parses and re-tiles an entire source. It is a data-loading
 * API, not an animation API, so driving it at interactive rates thrashes the
 * surface no matter which language calls it.
 *
 * A real native renderer therefore must own its rendering, not borrow someone
 * else's. That means per-marker updates through the annotation/symbol manager,
 * or a custom layer with its own vertex buffers — neither of which is reachable
 * from outside the component that owns the map.
 *
 * NOTE WHAT IS ABSENT FROM THESE PROPS: no positions, no FeatureCollection, no
 * geometry of any kind. Entities reach this view from the native store that
 * LoopSourceModule writes into, on the native side. JS sets configuration and
 * issues commands; coordinates never cross. That is the entire point, and it is
 * why the prop list is this short.
 */

import type { HostComponent, ViewProps } from 'react-native';
import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent';
import codegenNativeCommands from 'react-native/Libraries/Utilities/codegenNativeCommands';
import type { Double, Int32 } from 'react-native/Libraries/Types/CodegenTypes';

export interface NativeProps extends ViewProps {
  /** Basemap style URL. Supplied by the design tokens, same as the RN path. */
  styleUrl: string;

  /** Initial camera. Subsequent movement is a command, not a prop. */
  initialCenterLng: Double;
  initialCenterLat: Double;
  initialZoom: Double;

  /**
   * Identity palette, flattened to a comma-separated list of hex colours.
   *
   * Codegen cannot express a string array, and this crosses once at mount, so
   * a delimited string is the honest trade rather than an encoding scheme. The
   * view indexes it by each entity's `variant`.
   */
  identityColors: string;
  selfColor: string;
  staleColor: string;

  /** Interpolation window in ms; the view tweens between fixes on Choreographer. */
  interpolationMs: Int32;

  /** Draw movement trails. The native store owns the ring buffers. */
  showTrails: boolean;
}

interface NativeCommands {
  /** Move the camera without a prop round-trip. */
  setCamera: (
    ref: React.ElementRef<HostComponent<NativeProps>>,
    lng: Double,
    lat: Double,
    zoom: Double,
    durationMs: Int32,
  ) => void;

  /** Highlight one entity by id; empty string clears. */
  setSelected: (ref: React.ElementRef<HostComponent<NativeProps>>, entityId: string) => void;
}

export const Commands = codegenNativeCommands<NativeCommands>({
  supportedCommands: ['setCamera', 'setSelected'],
});

export default codegenNativeComponent<NativeProps>('LiveMapView') as HostComponent<NativeProps>;
