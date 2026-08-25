import { filterRoster, initials } from '../../src/viewmodels/useFriendsViewModel';
import type { FriendRosterEntry } from '../../src/models/FriendSelection';

const roster: FriendRosterEntry[] = [
  { id: 'a', label: 'Nisha Patel', participation: 'racer', variant: 0 },
  { id: 'b', label: 'Sana Kapoor', participation: 'watcher', variant: 1 },
  { id: 'c', label: 'Tara Singh', participation: 'racer', variant: 2 },
];

describe('filterRoster', () => {
  test('returns the whole roster for an empty query', () => {
    expect(filterRoster(roster, '')).toBe(roster);
    expect(filterRoster(roster, '   ')).toBe(roster);
  });

  test('matches case-insensitively against the label', () => {
    expect(filterRoster(roster, 'sana').map(f => f.id)).toEqual(['b']);
    expect(filterRoster(roster, 'SANA').map(f => f.id)).toEqual(['b']);
  });

  test('matches a substring anywhere in the label, not just the start', () => {
    expect(filterRoster(roster, 'singh').map(f => f.id)).toEqual(['c']);
  });

  test('returns no matches rather than throwing when nothing matches', () => {
    expect(filterRoster(roster, 'zzz')).toEqual([]);
  });
});

describe('initials', () => {
  test('takes the first letter of the first and last word', () => {
    expect(initials('Nisha Patel')).toBe('NP');
  });

  test('falls back to a single letter for a one-word name', () => {
    expect(initials('Cher')).toBe('C');
  });

  test('collapses extra whitespace before splitting', () => {
    expect(initials('  Tara   Singh  ')).toBe('TS');
  });

  test('uppercases the result regardless of input casing', () => {
    expect(initials('sana kapoor')).toBe('SK');
  });
});
