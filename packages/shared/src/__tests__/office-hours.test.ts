import {describe, expect, it} from 'vitest';

import {isValidTimeZone, officeHoursStatus} from '../office-hours.js';
import {MessengerSettingsSchemas} from '../messenger.js';

const WEEKDAYS_9_TO_5 = [1, 2, 3, 4, 5].map(day => ({day, start: 9 * 60, end: 17 * 60}));

describe('officeHoursStatus', () => {
  it('is online inside the hours, judged on the project clock', () => {
    // Wednesday 2026-10-14 10:30 in Oslo (CEST, UTC+2).
    expect(officeHoursStatus(WEEKDAYS_9_TO_5, 'Europe/Oslo', new Date('2026-10-14T08:30:00Z'))).toEqual({
      online: true,
      nextOpenAt: null,
    });
    // The same instant is 17:30 in Tokyo, after closing.
    expect(officeHoursStatus(WEEKDAYS_9_TO_5, 'Asia/Tokyo', new Date('2026-10-14T08:30:00Z')).online).toBe(false);
  });

  it('treats the closing minute as closed', () => {
    const status = officeHoursStatus(WEEKDAYS_9_TO_5, 'UTC', new Date('2026-10-14T17:00:00Z'));
    expect(status.online).toBe(false);
    expect(status.nextOpenAt?.toISOString()).toBe('2026-10-15T09:00:00.000Z');
  });

  it('opens later the same day before the hours start', () => {
    const status = officeHoursStatus(WEEKDAYS_9_TO_5, 'Europe/Oslo', new Date('2026-10-14T05:15:30Z'));
    expect(status).toEqual({online: false, nextOpenAt: new Date('2026-10-14T07:00:00Z')});
  });

  it('rolls a Friday evening over to Monday', () => {
    const status = officeHoursStatus(WEEKDAYS_9_TO_5, 'Asia/Tokyo', new Date('2026-10-16T12:00:00Z'));
    // Friday 21:00 in Tokyo; back Monday 09:00 JST.
    expect(status.nextOpenAt?.toISOString()).toBe('2026-10-19T00:00:00.000Z');
  });

  it('skips days without hours', () => {
    const days = [
      {day: 1, start: 600, end: 720},
      {day: 4, start: 600, end: 720},
    ];
    // Tuesday 2026-10-13 12:00 UTC: Wednesday is closed, so Thursday 10:00.
    expect(officeHoursStatus(days, 'UTC', new Date('2026-10-13T12:00:00Z')).nextOpenAt?.toISOString()).toBe(
      '2026-10-15T10:00:00.000Z',
    );
  });

  it('wraps from Sunday to the next week', () => {
    const days = [{day: 1, start: 540, end: 1020}];
    // Monday 18:00 UTC: back the following Monday.
    expect(officeHoursStatus(days, 'UTC', new Date('2026-10-12T18:00:00Z')).nextOpenAt?.toISOString()).toBe(
      '2026-10-19T09:00:00.000Z',
    );
  });

  it('keeps the wall-clock opening time across the end of summer time', () => {
    // Saturday 2026-10-24 20:00 CEST in Oslo. Clocks go back on Sunday the 25th, so Monday 09:00 is CET (UTC+1).
    const status = officeHoursStatus(WEEKDAYS_9_TO_5, 'Europe/Oslo', new Date('2026-10-24T18:00:00Z'));
    expect(status.nextOpenAt?.toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });

  it('keeps the wall-clock opening time across the start of summer time', () => {
    // Saturday 2027-03-27 20:00 CET in Oslo. Clocks go forward on the 28th, so Monday 09:00 is CEST (UTC+2).
    const status = officeHoursStatus(WEEKDAYS_9_TO_5, 'Europe/Oslo', new Date('2027-03-27T19:00:00Z'));
    expect(status.nextOpenAt?.toISOString()).toBe('2027-03-29T07:00:00.000Z');
  });

  it('is open until midnight when a day closes at 1440', () => {
    const days = [{day: 3, start: 1200, end: 1440}];
    expect(officeHoursStatus(days, 'UTC', new Date('2026-10-14T23:59:00Z')).online).toBe(true);
    expect(officeHoursStatus(days, 'UTC', new Date('2026-10-15T00:00:00Z')).online).toBe(false);
  });

  it('has no next opening when no day has hours', () => {
    expect(officeHoursStatus([], 'UTC', new Date())).toEqual({online: false, nextOpenAt: null});
  });
});

describe('office hours settings', () => {
  const parse = (value: unknown) => MessengerSettingsSchemas.update.safeParse(value);

  it('accepts a schedule, a time zone and a reply time', () => {
    const result = parse({officeHours: WEEKDAYS_9_TO_5, timezone: 'Europe/Oslo', replyTime: 'FEW_MINUTES'});
    expect(result.success).toBe(true);
  });

  it('rejects unknown time zones, closing before opening and repeated days', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(parse({timezone: 'Mars/Olympus'}).success).toBe(false);
    expect(parse({officeHours: [{day: 1, start: 600, end: 600}]}).success).toBe(false);
    expect(
      parse({
        officeHours: [
          {day: 2, start: 540, end: 600},
          {day: 2, start: 700, end: 800},
        ],
      }).success,
    ).toBe(false);
    expect(parse({officeHours: [{day: 8, start: 0, end: 60}]}).success).toBe(false);
    expect(parse({replyTime: 'SOMETIME'}).success).toBe(false);
  });
});
