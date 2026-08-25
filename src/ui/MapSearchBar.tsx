/**
 * Map search entry — the Google Maps pattern: a floating rounded card over
 * the map, not a bar it sits below. Tapping it doesn't search in place; it
 * opens the dedicated Friends screen, the same way Maps' search bar opens a
 * full search screen rather than expanding into one.
 *
 * The leading mark is the same Loop ring used everywhere else in the app
 * (tinted via `tintColor`, one asset for every context) rather than a
 * separate hand-drawn search-glyph — one less shape for the app to define,
 * and it doubles as a small piece of brand presence on the busiest screen.
 * The rotating hint is the same component and animation the Friends screen's
 * own search field uses — one implementation, not two that could drift.
 */

import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scale, useTokens } from '@design';
import { RotatingSearchHint, type RosterNameSource } from './RotatingSearchHint';

export interface MapSearchBarProps {
  roster: readonly RosterNameSource[];
  visibleCount: number;
  onPress: () => void;
}

export function MapSearchBar({ roster, visibleCount, onPress }: MapSearchBarProps) {
  const tokens = useTokens();
  const insets = useSafeAreaInsets();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="search"
      accessibilityLabel="Open friends list"
      style={[
        styles.bar,
        {
          top: insets.top + scale.space[2],
          backgroundColor: tokens.surface.elevated,
        },
      ]}
    >
      <Image
        source={require('../../assets/logo-mark-white.png')}
        style={[styles.mark, { tintColor: tokens.accent.base }]}
        resizeMode="contain"
      />
      <RotatingSearchHint roster={roster} style={styles.hint} />
      {roster.length > 0 ? (
        <View style={[styles.badge, { backgroundColor: tokens.surface.sunken }]}>
          <Text style={[styles.badgeText, { color: tokens.text.secondary }]}>
            {visibleCount}/{roster.length}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // `top` is supplied at render time from safe-area insets.
  bar: {
    position: 'absolute',
    left: scale.space[3],
    right: scale.space[3],
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: scale.space[3],
    borderRadius: scale.radius.pill,
    gap: scale.space[3],
    // Cross-platform card shadow — elevation for Android, shadow* for iOS.
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
  },
  mark: { width: 22, height: 22 },
  hint: { flex: 1 },
  badge: {
    paddingHorizontal: scale.space[2],
    paddingVertical: 4,
    borderRadius: scale.radius.pill,
  },
  badgeText: { fontSize: scale.typography.size.xs, fontWeight: scale.typography.weight.semibold },
});
