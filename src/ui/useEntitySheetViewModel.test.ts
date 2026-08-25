import {
  buildDirectionsUrl,
  buildFallbackDirectionsUrl,
  distanceM,
  formatDistance,
  statusText,
} from './useEntitySheetViewModel';

describe('distanceM', () => {
  test('is zero for identical points', () => {
    expect(distanceM(0, 0, 0, 0)).toBe(0);
  });

  test('roughly matches a known great-circle distance (London to Paris, ~344km)', () => {
    const m = distanceM(-0.1276, 51.5072, 2.3522, 48.8566);
    expect(m).toBeGreaterThan(340_000);
    expect(m).toBeLessThan(350_000);
  });
});

describe('formatDistance', () => {
  test('rounds sub-km distances to the nearest 10m', () => {
    expect(formatDistance(234)).toBe('230 m away');
  });

  test('shows one decimal of km between 1km and 100km', () => {
    expect(formatDistance(12_340)).toBe('12.3 km away');
  });

  test('flags distances beyond 100km as not-at-this-event', () => {
    expect(formatDistance(1_712_200)).toBe('1712 km away — not at this event');
  });
});

describe('statusText', () => {
  test('is "You" for the self entity regardless of participation', () => {
    expect(statusText({ isSelf: true, participation: 'racer' })).toBe('You');
  });

  test('is "Supporting" for a non-racer', () => {
    expect(statusText({ isSelf: false, participation: 'supporter' })).toBe('Supporting');
  });

  test('includes the bib number for a racer who has one', () => {
    expect(statusText({ isSelf: false, participation: 'racer' }, '42')).toBe('Racing · Bib 42');
  });

  test('omits the bib clause for a racer without one', () => {
    expect(statusText({ isSelf: false, participation: 'racer' }, null)).toBe('Racing');
  });
});

describe('buildDirectionsUrl', () => {
  test('encodes the destination and label into a walking-mode Google Maps URL', () => {
    const url = buildDirectionsUrl(48.8566, 2.3522, 'Sana Kapoor');
    expect(url).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=48.8566,2.3522&travelmode=walking&destination_place_id=Sana%20Kapoor',
    );
  });
});

describe('buildFallbackDirectionsUrl', () => {
  test('builds an ios maps:// URL on ios', () => {
    expect(buildFallbackDirectionsUrl(48.8566, 2.3522, 'Sana', 'ios')).toBe(
      'maps://?daddr=48.8566,2.3522',
    );
  });

  test('builds a geo: URL for other platforms', () => {
    expect(buildFallbackDirectionsUrl(48.8566, 2.3522, 'Sana', 'default')).toBe(
      'geo:48.8566,2.3522?q=48.8566,2.3522(Sana)',
    );
  });
});
