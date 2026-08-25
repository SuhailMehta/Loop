/**
 * View model for the Friends screen.
 *
 * Owns the one piece of state the screen itself is responsible for — the
 * search query — plus the derived values a `FlatList` needs to render.
 * Selection itself (`mode`/`selectedIds`) is owned by `useMapViewModel` via
 * `FriendSelection.ts`, since the map reads it too; this hook only receives
 * it and derives view-local values from it, so nothing here duplicates that
 * state machine.
 */

import { useMemo, useState } from 'react';
import type { FriendRosterEntry, FriendFilterMode } from '../models/FriendSelection';

export function filterRoster(
  roster: readonly FriendRosterEntry[],
  query: string,
): readonly FriendRosterEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return roster;
  }
  return roster.filter(f => f.label.toLowerCase().includes(q));
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export interface FriendsViewModelArgs {
  roster: readonly FriendRosterEntry[];
  mode: FriendFilterMode;
  selectedIds: ReadonlySet<string>;
}

export function useFriendsViewModel({ roster, mode, selectedIds }: FriendsViewModelArgs) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => filterRoster(roster, query), [roster, query]);

  const allSelected = mode === 'all';
  const visibleCount = allSelected ? roster.length : selectedIds.size;

  const isChecked = (id: string) => allSelected || selectedIds.has(id);

  return { query, setQuery, filtered, allSelected, visibleCount, isChecked };
}

export type FriendsViewModel = ReturnType<typeof useFriendsViewModel>;
