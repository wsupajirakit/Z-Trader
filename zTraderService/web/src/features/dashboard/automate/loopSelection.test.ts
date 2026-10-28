import { describe, expect, it } from 'vitest';
import {
  boxTitle,
  checkedInOrder,
  shownValues,
  toggleValue,
  UNTOUCHED,
} from './loopSelection';

const defaults = ['swing'];

describe('loop checkboxes follow the server', () => {
  it('before any status the untouched boxes show the defaults', () => {
    expect(shownValues(UNTOUCHED, false, undefined, defaults)).toEqual([
      'swing',
    ]);
  });

  it('stopped + untouched → seeded from the server', () => {
    expect(
      shownValues(UNTOUCHED, false, ['scalp', 'intraday'], defaults),
    ).toEqual(['scalp', 'intraday']);
  });

  it('stopped + touched → the user selection wins', () => {
    const sel = toggleValue(['scalp'], 'swing', true);
    expect(sel).toEqual({ values: ['scalp', 'swing'], dirty: true });
    expect(shownValues(sel, false, ['scalp'], defaults)).toEqual([
      'scalp',
      'swing',
    ]);
  });

  it('running → always the server, whatever was clicked', () => {
    const sel = toggleValue(['scalp'], 'scalp', false);
    expect(shownValues(sel, true, ['position'], defaults)).toEqual([
      'position',
    ]);
  });

  it('checked values go out in display order', () => {
    expect(
      checkedInOrder(['scalp', 'intraday', 'swing'], ['swing', 'scalp']),
    ).toEqual(['scalp', 'swing']);
  });

  it('explains why a box is locked', () => {
    expect(boxTitle(false, true, 'mode')).toBe('');
    expect(boxTitle(true, true, 'mode')).toBe(
      'โหมดนี้กำลังรันอยู่ — กด Stop ก่อนถ้าจะเปลี่ยน',
    );
    expect(boxTitle(true, false, 'instrument')).toBe(
      'ไม่ได้เปิดในรอบนี้ — กด Stop ก่อนถ้าจะเพิ่ม',
    );
    expect(boxTitle(true, true, 'instrument')).toBe(
      'ตราสารนี้กำลังรันอยู่ — กด Stop ก่อนถ้าจะเปลี่ยน',
    );
  });
});
