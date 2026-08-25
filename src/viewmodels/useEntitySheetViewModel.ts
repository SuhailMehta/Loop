/**
 * View model for the entity sheet — pure derivations plus the one real side
 * effect (handing off to a maps app). Kept separate from `EntitySheet.tsx`
 * so the distance/status/colour rules and the directions-URL construction
 * are testable with plain Jest, with no sheet rendered and no `Linking` call
 * made.
 */

import { useCallback } from 'react';
import { Linking, Platform } from 'react-native';
import { identityColor, useTokens, type SemanticTokens } from '@design';
import type { SelectedEntity } from '../ui/EntitySheet';

/** Haversine, duplicated here rather than importing from the kernel. */
export function distanceM(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Distance readout.
 *
 * Rounded by magnitude, because false precision is worse than none: "1712.2 km"
 * implies a certainty that a straight-line estimate between two GPS fixes does
 * not have, and nobody meeting a friend needs a decimetre.
 */
export function formatDistance(m: number): string {
  if (m < 1000) {
    return `${Math.round(m / 10) * 10} m away`;
  }
  if (m < 100_000) {
    return `${(m / 1000).toFixed(1)} km away`;
  }
  // Far enough that "away" is the wrong frame entirely — the user is not at
  // this event, and directions would route them across the country.
  return `${Math.round(m / 1000)} km away — not at this event`;
}

/** Spelled out in words — a colour alone doesn't say why someone is moving at 3.6 m/s. */
export function statusText(
  entity: Pick<SelectedEntity, 'isSelf' | 'participation'>,
  bib?: string | null,
): string {
  if (entity.isSelf) {
    return 'You';
  }
  if (entity.participation !== 'racer') {
    return 'Supporting';
  }
  return bib ? `Racing · Bib ${bib}` : 'Racing';
}

/**
 * The documented cross-platform Google Maps URL: Android hands it to the
 * Google Maps app via intent filter, iOS opens the app if installed and
 * Safari otherwise. `travelmode=walking` because these are people at an
 * event, metres apart — driving directions between two spectators in the
 * same park would be absurd.
 */
export function buildDirectionsUrl(lat: number, lng: number, label: string): string {
  const destination = `${lat},${lng}`;
  return (
    `https://www.google.com/maps/dir/?api=1&destination=${destination}` +
    `&travelmode=walking&destination_place_id=${encodeURIComponent(label)}`
  );
}

/** Last resort when the cross-platform URL fails: the platform's own maps handler. */
export function buildFallbackDirectionsUrl(
  lat: number,
  lng: number,
  label: string,
  os: 'ios' | 'default',
): string {
  const destination = `${lat},${lng}`;
  return os === 'ios'
    ? `maps://?daddr=${destination}`
    : `geo:${destination}?q=${destination}(${encodeURIComponent(label)})`;
}

export interface EntitySheetView {
  accent: string;
  status: string;
  distance: string | null;
  warning: string | null;
}

export function deriveEntitySheetView(
  entity: SelectedEntity,
  selfPosition: { lng: number; lat: number } | null,
  bib: string | null | undefined,
  tokens: SemanticTokens,
): EntitySheetView {
  const isSelf = entity.isSelf;
  const distance =
    selfPosition && !isSelf
      ? formatDistance(distanceM(selfPosition.lng, selfPosition.lat, entity.lng, entity.lat))
      : null;

  // Same colour the pin and the Friends list row use for this person —
  // identityColor(variant) is the one mapping every surface reads from.
  const accent = isSelf ? tokens.map.entity.self : identityColor(tokens, entity.variant);

  const warning =
    entity.freshness === 'dead'
      ? 'Signal lost'
      : entity.freshness === 'stale'
        ? 'Position may be out of date'
        : null;

  return { accent, status: statusText(entity, bib), distance, warning };
}

export function useEntitySheetViewModel(
  entity: SelectedEntity | null,
  selfPosition: { lng: number; lat: number } | null,
  bib?: string | null,
) {
  const tokens = useTokens();
  const view = entity ? deriveEntitySheetView(entity, selfPosition, bib, tokens) : null;

  const openDirections = useCallback(async () => {
    if (!entity) {
      return;
    }
    const url = buildDirectionsUrl(entity.lat, entity.lng, entity.label);
    try {
      await Linking.openURL(url);
    } catch {
      const fallback = buildFallbackDirectionsUrl(
        entity.lat,
        entity.lng,
        entity.label,
        Platform.OS === 'ios' ? 'ios' : 'default',
      );
      try {
        await Linking.openURL(fallback);
      } catch {
        // Nothing can handle a map intent. Silent is correct — the sheet stays
        // open and the user still has the position on screen.
      }
    }
  }, [entity]);

  return { tokens, view, openDirections };
}
