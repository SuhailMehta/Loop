/**
 * Provider registration — bootstrap, not view state.
 *
 * Split out of the view model on purpose: this is app wiring (which
 * `Source` implementations exist), not anything a screen renders or a test
 * needs to drive through a hook. In a packaged build this happens inside
 * each provider package's own ReactPackage (Android) or `+load` shim (iOS),
 * so adding or removing a source is an install/uninstall with no JS diff.
 * Doing it here keeps the demo in one readable place while using the
 * identical registry path.
 */

import { registerSource } from '@geo/sources/registry';
import { MOCK_SOURCE_ID, createMockSource } from '@geo/sources/MockSource';
import {
  NATIVE_SOURCE_ID,
  createNativeTurboSource,
  isNativeSourceAvailable,
} from '@geo/sources/NativeTurboSource';
import { SCENARIO_CENTER, SCENARIO_GROUPS } from '@kits/live-entities/scenario';

let demoEntityCount = 0;
let demoScenario = true;
let providersRegistered = false;

export function registerProviders(entityCount: number, scenarioMode: boolean): void {
  // Re-register whenever the config the factories close over has changed —
  // cheap, since registerSource just replaces the existing entry.
  if (providersRegistered && demoEntityCount === entityCount && demoScenario === scenarioMode) {
    return;
  }
  providersRegistered = true;
  demoEntityCount = entityCount;
  demoScenario = scenarioMode;

  registerSource(MOCK_SOURCE_ID, 10, () =>
    createMockSource(
      demoScenario
        ? {
            groups: SCENARIO_GROUPS,
            centerLng: SCENARIO_CENTER[0],
            centerLat: SCENARIO_CENTER[1],
          }
        : { entityCount: demoEntityCount },
    ),
  );

  // The native provider registers only when it is actually linked. If it is
  // not, resolution falls back to the JS source by priority and nothing else
  // in the app is aware anything changed — which is the whole contract.
  if (isNativeSourceAvailable()) {
    // The native provider receives the IDENTICAL scenario the JS provider
    // gets. Without this the swap changed what was on screen (anonymous dots
    // wandering outside every venue) rather than how it got there, which
    // proved nothing.
    registerSource(NATIVE_SOURCE_ID, 20, () =>
      createNativeTurboSource(
        demoScenario
          ? {
              groups: SCENARIO_GROUPS as never,
              centerLng: SCENARIO_CENTER[0],
              centerLat: SCENARIO_CENTER[1],
            }
          : { wanderCount: demoEntityCount },
      ),
    );
  }
}
