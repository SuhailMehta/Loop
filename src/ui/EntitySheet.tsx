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
 *
 * This file is view only — `useEntitySheetViewModel` derives the distance,
 * status text, accent colour and staleness warning, and owns the one real
 * side effect (opening a maps app). That split is what makes the distance
 * formatting and URL construction testable with plain Jest, with no sheet
 * rendered and no `Linking` call made.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scale } from '@design';
import { useEntitySheetViewModel } from './useEntitySheetViewModel';

export interface SelectedEntity {
  id: string;
  lng: number;
  lat: number;
  label: string;
  /** From event registration — 'racer' or 'supporter'. */
  participation: string;
  /** Opaque per-entity discriminator the source assigns; indexes the identity palette. */
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

export function EntitySheet({ entity, selfPosition, bib, onClose }: EntitySheetProps) {
  const insets = useSafeAreaInsets();
  const { tokens, view, openDirections } = useEntitySheetViewModel(entity, selfPosition, bib);

  if (!entity || !view) {
    return null;
  }

  const { accent, status, distance, warning } = view;

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
      {entity.isSelf ? null : (
        <Pressable
          onPress={openDirections}
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
      {warning ? (
        <Text style={[styles.warning, { color: tokens.status.warn }]}>{warning}</Text>
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
