/**
 * Tier 1 — source registry.
 *
 * THE POINT OF THIS FILE: swapping the entity source must never require a JS
 * change at the call site. Providers self-register at module load; the surface
 * calls `resolveSource()` and gets whichever one is linked. In a packaged
 * build the registration happens from each provider's own ReactPackage on
 * Android (and a `+load` shim on iOS), so the swap becomes an install/uninstall
 * rather than an edit.
 *
 * Resolution policy is deterministic and stated explicitly, because "which
 * provider am I actually running?" is the first question every bug report needs
 * answered:
 *
 *   0 registered -> NoopSource. Reports a typed error; MUST NOT crash. This is
 *                   the case everyone forgets, and it turns a packaging mistake
 *                   into a launch crash if unhandled.
 *   1 registered -> that one.
 *   2+           -> highest priority wins; an explicit override beats priority.
 */

import { createNoopSource, type Source, type SourceFactory } from '../ports/Source';

interface Registration {
  readonly id: string;
  readonly priority: number;
  readonly factory: SourceFactory;
}

const registrations: Registration[] = [];
let overrideId: string | null = null;

/**
 * Register a source implementation.
 *
 * Re-registering the same id replaces the previous entry rather than
 * duplicating it, so Fast Refresh during development does not accumulate
 * phantom providers.
 */
export function registerSource(id: string, priority: number, factory: SourceFactory): void {
  const existing = registrations.findIndex(r => r.id === id);
  const entry: Registration = { id, priority, factory };
  if (existing >= 0) {
    registrations[existing] = entry;
  } else {
    registrations.push(entry);
  }
}

/**
 * Force a specific provider regardless of priority.
 *
 * This is the demo/debug lever and the equivalent of the Info.plist /
 * strings.xml override in the native design. Feature code must not call it.
 */
export function setSourceOverride(id: string | null): void {
  overrideId = id;
}

export function resolveSource(): Source {
  if (overrideId) {
    const forced = registrations.find(r => r.id === overrideId);
    if (forced) {
      return forced.factory();
    }
  }

  let best: Registration | null = null;
  for (let i = 0; i < registrations.length; i++) {
    const candidate = registrations[i] as Registration;
    if (!best || candidate.priority > best.priority) {
      best = candidate;
    }
  }

  return best ? best.factory() : createNoopSource();
}

/** Diagnostics for the debug HUD. Feature code must not branch on this. */
export function listSources(): ReadonlyArray<{ id: string; priority: number }> {
  return registrations.map(r => ({ id: r.id, priority: r.priority }));
}

/** Test hook. Not exported from the framework barrel. */
export function __resetRegistry(): void {
  registrations.length = 0;
  overrideId = null;
}
