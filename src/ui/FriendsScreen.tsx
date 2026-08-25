/**
 * Friends screen.
 *
 * WHY A SEPARATE SCREEN, NOT AN OVERLAY
 *
 * The panel this replaced sat on top of the map as a translucent card. That
 * reads fine for three names and falls apart for thirty: there is no room to
 * search, no room to breathe, and a `ScrollView.map` over the whole roster
 * renders every row regardless of what is on screen — cost that grows with
 * the guest list, not with what the user can actually see. A dedicated page
 * gets its own layout budget and a `FlatList`, which only ever renders the
 * rows near the viewport no matter how long the roster gets.
 *
 * ONE LIST, NOT TWO MODES
 *
 * Every row is a checkbox; "Select all" is just the top row rather than a
 * separate mode to switch between. "All" still means "everyone, including
 * whoever the source names next" — not a snapshot of who happened to be on
 * the roster at the moment you tapped it — so a fresh face joining mid-event
 * shows up without the user having to go re-check a box for them.
 *
 * COLOUR IS THE MAP'S IDENTITY KEY, READ HERE
 *
 * Each avatar uses the same `identityColor(variant)` mapping the map pins
 * do, so a colour on the map and a name in this list are never presented
 * apart from each other — this list IS the legend, which is why there is no
 * separate floating one.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { identityColor, scale, useTokens } from '@design';
import { RotatingSearchHint } from './RotatingSearchHint';

export interface FriendRosterEntry {
  id: string;
  label: string;
  participation: string;
  /** Opaque per-entity discriminator the source assigns; indexes the identity palette. */
  variant: number;
}

/** 'all' = everyone, including anyone the source names later. 'any' = exactly `selectedIds`. */
export type FriendFilterMode = 'all' | 'any';

export interface FriendsScreenProps {
  roster: readonly FriendRosterEntry[];
  mode: FriendFilterMode;
  selectedIds: ReadonlySet<string>;
  onToggleAll: () => void;
  onToggle: (id: string) => void;
  onClose: () => void;
}

const ROW_HEIGHT = 60;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function FriendsScreen({
  roster,
  mode,
  selectedIds,
  onToggleAll,
  onToggle,
  onClose,
}: FriendsScreenProps) {
  const tokens = useTokens();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return roster;
    }
    return roster.filter(f => f.label.toLowerCase().includes(q));
  }, [roster, query]);

  const allSelected = mode === 'all';
  const visibleCount = allSelected ? roster.length : selectedIds.size;

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<FriendRosterEntry>) => {
      const checked = allSelected || selectedIds.has(item.id);
      return (
        <Pressable
          onPress={() => onToggle(item.id)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          accessibilityLabel={item.label}
          style={({ pressed }) => [
            styles.row,
            pressed && { backgroundColor: tokens.surface.sunken },
          ]}
        >
          <View style={[styles.avatar, { backgroundColor: identityColor(tokens, item.variant) }]}>
            <Text style={[styles.avatarText, { color: tokens.text.inverse }]}>
              {initials(item.label)}
            </Text>
          </View>

          <View style={styles.rowText}>
            <Text style={[styles.name, { color: tokens.text.primary }]} numberOfLines={1}>
              {item.label}
            </Text>
            <Text style={[styles.tag, { color: tokens.text.secondary }]} numberOfLines={1}>
              {item.participation === 'racer' ? 'Racing' : 'Watching'}
            </Text>
          </View>

          <View
            style={[
              styles.check,
              {
                borderColor: checked ? tokens.accent.base : tokens.surface.border,
                backgroundColor: checked ? tokens.accent.base : 'transparent',
              },
            ]}
          >
            {checked ? <Text style={[styles.checkMark, { color: tokens.text.inverse }]}>✓</Text> : null}
          </View>
        </Pressable>
      );
    },
    [allSelected, selectedIds, onToggle, tokens],
  );

  return (
    <View style={[styles.screen, { backgroundColor: tokens.surface.base }]}>
      <View style={[styles.header, { paddingTop: insets.top + scale.space[2] }]}>
        <Pressable
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Back to map"
          style={styles.back}
        >
          <Text style={[styles.backGlyph, { color: tokens.text.primary }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: tokens.text.primary }]}>Friends</Text>
        <Text style={[styles.count, { color: tokens.text.secondary }]}>
          {visibleCount} of {roster.length}
        </Text>
      </View>

      <View
        style={[
          styles.searchWrap,
          { backgroundColor: tokens.surface.sunken, borderColor: tokens.surface.border },
        ]}
      >
        <TextInput
          value={query}
          onChangeText={setQuery}
          style={[styles.search, { color: tokens.text.primary }]}
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel="Search friends"
        />
        {query.length === 0 ? (
          <View style={styles.hintOverlay} pointerEvents="none">
            <RotatingSearchHint roster={roster} />
          </View>
        ) : null}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        getItemLayout={(_, index) => ({
          length: ROW_HEIGHT,
          offset: ROW_HEIGHT * (index + 1), // +1 for the pinned "Select all" row
          index,
        })}
        ListHeaderComponent={
          <Pressable
            onPress={onToggleAll}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: allSelected }}
            accessibilityLabel="Select all friends"
            style={({ pressed }) => [
              styles.row,
              styles.selectAllRow,
              { borderColor: tokens.surface.border },
              pressed && { backgroundColor: tokens.surface.sunken },
            ]}
          >
            <Text style={[styles.name, { color: tokens.text.primary }]}>Select all</Text>
            <View
              style={[
                styles.check,
                {
                  borderColor: allSelected ? tokens.accent.base : tokens.surface.border,
                  backgroundColor: allSelected ? tokens.accent.base : 'transparent',
                },
              ]}
            >
              {allSelected ? (
                <Text style={[styles.checkMark, { color: tokens.text.inverse }]}>✓</Text>
              ) : null}
            </View>
          </Pressable>
        }
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: tokens.surface.border }]} />
        )}
        // Renders only what's near the viewport, so a roster of thousands
        // costs the same per frame as a roster of ten.
        initialNumToRender={20}
        maxToRenderPerBatch={20}
        windowSize={8}
        removeClippedSubviews
        contentContainerStyle={{ paddingBottom: insets.bottom + scale.space[4] }}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: tokens.text.secondary }]}>
            {roster.length === 0 ? 'Waiting for friends…' : 'No one matches that search.'}
          </Text>
        }
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: scale.space[3],
    paddingBottom: scale.space[2],
    gap: scale.space[2],
  },
  back: { padding: scale.space[1], marginLeft: -scale.space[1] },
  backGlyph: { fontSize: 28, lineHeight: 28, fontWeight: '400' },
  title: { flex: 1, fontSize: scale.typography.size.xl, fontWeight: scale.typography.weight.semibold },
  count: { fontSize: scale.typography.size.sm },
  searchWrap: {
    marginHorizontal: scale.space[3],
    marginBottom: scale.space[2],
    height: 44,
    borderRadius: scale.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  search: {
    flex: 1,
    height: '100%',
    paddingHorizontal: scale.space[3],
    fontSize: scale.typography.size.md,
  },
  hintOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    paddingHorizontal: scale.space[3],
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
    paddingHorizontal: scale.space[3],
    gap: scale.space[3],
  },
  selectAllRow: { justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: scale.typography.size.xs, fontWeight: scale.typography.weight.semibold },
  rowText: { flex: 1 },
  name: { fontSize: scale.typography.size.md, fontWeight: scale.typography.weight.medium },
  tag: { fontSize: scale.typography.size.xs, marginTop: 1 },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMark: { fontSize: 13, fontWeight: '700' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: scale.space[3] + 36 + scale.space[3] },
  empty: {
    fontSize: scale.typography.size.sm,
    textAlign: 'center',
    marginTop: scale.space[6],
  },
});
