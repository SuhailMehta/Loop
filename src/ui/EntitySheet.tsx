/**
 * Selected-entity sheet.
 *
 * This is the part of the brief that the map alone does not satisfy. Seeing a
 * dot move is not the goal — the goal is to find a specific person and get to
 * them. So the sheet answers three questions in order of usefulness:
 *
 *   who is this        the label the source stamped on the entity
 *   how far are they   straight-line distance from the user's own position
 *   how do I get there hand off to a navigation app
 *
 * The handoff is deliberate rather than a failing. Turn-by-turn navigation is a
 * multi-year product; the honest move is to deep-link to one that already
 * exists, using the cross-platform Google Maps URL so a single call works on
 * both platforms.
 */

import React from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scale, useTokens } from '@design';

export interface SelectedEntity {
  id: string;
  lng: number;
  lat: number;
  label: string;
  /** From event registration — 'racer' or 'supporter'. */
  participation: string;
  /** Opaque per-entity discriminator the source assigns; unused by this sheet. */
  variant: number;
  isSelf: boolean;
  persona: string;
  freshness: string;
}

interface EntitySheetProps {
  entity: SelectedEntity | null;
  /** The user's own position, when known — used for the distance readout. */
  selfPosition: { lng: number; lat: number } | null;
  /** Bib number, when this person registered for the race. */
  bib?: string | null;
  onClose: () => void;
}

/** Haversine, duplicated here rather than importing from the kernel. */
function distanceM(lng1: number, lat1: number, lng2: number, lat2: number): number {
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
function formatDistance(m: number): string {
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

/**
 * Opens directions in a maps app.
 *
 * The `google.com/maps/dir/?api=1` form is the documented cross-platform URL:
 * Android hands it to the Google Maps app via intent filter, iOS opens the app
 * if installed and Safari otherwise. One call, no platform branch, no failure
 * mode where nothing happens.
 *
 * `travelmode=walking` because these are people at an event, metres apart —
 * driving directions between two spectators in the same park would be absurd.
 */
async function openDirections(lat: number, lng: number, label: string): Promise<void> {
  const destination = `${lat},${lng}`;
  const url =
    `https://www.google.com/maps/dir/?api=1&destination=${destination}` +
    `&travelmode=walking&destination_place_id=${encodeURIComponent(label)}`;

  try {
    await Linking.openURL(url);
  } catch {
    // Last resort: the platform's own maps handler.
    const fallback = Platform.select({
      ios: `maps://?daddr=${destination}`,
      default: `geo:${destination}?q=${destination}(${encodeURIComponent(label)})`,
    });
    try {
      await Linking.openURL(fallback);
    } catch {
      // Nothing can handle a map intent. Silent is correct — the sheet stays
      // open and the user still has the position on screen.
    }
  }
}

export function EntitySheet({ entity, selfPosition, bib, onClose }: EntitySheetProps) {
  const tokens = useTokens();
  const insets = useSafeAreaInsets();

  if (!entity) {
    return null;
  }

  const isSelf = entity.isSelf;
  const distance =
    selfPosition && !isSelf
      ? formatDistance(distanceM(selfPosition.lng, selfPosition.lat, entity.lng, entity.lat))
      : null;

  // Same colour the pin uses — "you" stays visually distinct, every friend
  // shares one colour and is told apart by name instead.
  const accent = isSelf ? tokens.map.entity.self : tokens.map.entity.fresh;

  // Spelled out in words, because a colour alone does not tell a user why this
  // person is moving at 3.6 m/s down the middle of a park.
  const status = isSelf
    ? 'You'
    : entity.participation === 'racer'
      ? bib
        ? `Racing · Bib ${bib}`
        : 'Racing'
      : 'Supporting';

  return (
    <View
      style={[
        styles.sheet,
        {
          bottom: insets.bottom + scale.space[4],
          backgroundColor: tokens.surface.overlay,
          borderColor: tokens.surface.border,
        },
      ]}
    >
      <View style={styles.header}>
        <View style={[styles.dot, { backgroundColor: accent, borderColor: tokens.map.entity.stroke }]} />
        <View style={styles.headerText}>
          <Text style={[styles.name, { color: tokens.text.primary }]} numberOfLines={1}>
            {entity.label}
          </Text>
          <Text style={[styles.meta, { color: tokens.text.secondary }]} numberOfLines={1}>
            {[status, distance].filter(Boolean).join(' · ')}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={12} style={styles.close}>
          <Text style={[styles.closeText, { color: tokens.text.secondary }]}>✕</Text>
        </Pressable>
      </View>

      {/* Directions to yourself would be nonsense, so the action is suppressed. */}
      {isSelf ? null : (
        <Pressable
          onPress={() => openDirections(entity.lat, entity.lng, entity.label)}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: pressed ? tokens.accent.strong : tokens.accent.base },
          ]}
        >
          <Text style={[styles.actionText, { color: tokens.text.inverse }]}>Directions</Text>
        </Pressable>
      )}

      {/* Staleness is surfaced in words, not just colour — a fading pin is easy
          to miss, and "last seen" is the difference between waiting and moving on. */}
      {entity.freshness === 'stale' || entity.freshness === 'dead' ? (
        <Text style={[styles.warning, { color: tokens.status.warn }]}>
          {entity.freshness === 'dead' ? 'Signal lost' : 'Position may be out of date'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: scale.space[3],
    right: scale.space[3],
    padding: scale.space[4],
    borderRadius: scale.radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: scale.space[3],
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: scale.space[3] },
  headerText: { flex: 1 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2 },
  name: { fontSize: scale.typography.size.lg, fontWeight: scale.typography.weight.semibold },
  meta: { fontSize: scale.typography.size.sm, marginTop: 2 },
  close: { padding: scale.space[1] },
  closeText: { fontSize: scale.typography.size.md },
  action: {
    paddingVertical: scale.space[3],
    borderRadius: scale.radius.md,
    alignItems: 'center',
  },
  actionText: { fontSize: scale.typography.size.md, fontWeight: scale.typography.weight.semibold },
  warning: { fontSize: scale.typography.size.xs, textAlign: 'center' },
});
