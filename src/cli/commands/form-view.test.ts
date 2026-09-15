import { describe, expect, it } from 'vitest';
import type { ApplicationForm } from '../../forms/index.js';
import { clip, MAX_FIELD_TEXT, renderForm } from './form-view.js';

function form(overrides: Partial<ApplicationForm> = {}): ApplicationForm {
  return {
    provider: 'ashby',
    title: 'Staff Engineer',
    compensationSummary: null,
    deadline: null,
    fields: [],
    ...overrides,
  };
}

describe('clip', () => {
  it('bounds a field title that is not really a question', () => {
    // A live Ramp posting embeds a 2 KB base64 blob as a field title, which
    // floods the terminal and buries every other line of the form.
    const clipped = clip('x'.repeat(2000));
    expect(clipped.length).toBe(MAX_FIELD_TEXT);
    expect(clipped.endsWith('…')).toBe(true);
  });

  it('collapses whitespace so one question stays one line', () => {
    expect(clip('Tell us\n\nabout   yourself')).toBe('Tell us about yourself');
  });

  it('leaves an ordinary question untouched', () => {
    expect(clip('Why do you want to join?')).toBe('Why do you want to join?');
  });
});

describe('renderForm', () => {
  it('leads with the counts that decide whether tonight is the night', () => {
    const lines = renderForm(
      form({
        fields: [
          { title: 'Resume', type: 'file', required: true, description: null },
          { title: 'Why us?', type: 'long-text', required: true, description: 'Three sentences' },
          { title: 'Portfolio', type: 'text', required: false, description: null },
        ],
      }),
      '#1 Staff Engineer',
      'https://example.com/jobs/1',
    );

    expect(lines[0]).toBe('#1 Staff Engineer');
    expect(lines).toContain('3 question(s), 2 required — 1 long-form answer(s) and 1 file(s) among them');
    expect(lines).toContain('  * [file     ] Resume');
    expect(lines).toContain('    [text     ] Portfolio'); // optional: no asterisk
    expect(lines).toContain('      Three sentences');
    expect(lines).toContain('Full wording is on the posting: https://example.com/jobs/1');
  });

  it('omits pay and deadline lines rather than printing empty ones', () => {
    // An empty value reads as "none stated"; Greenhouse simply does not
    // publish either.
    const lines = renderForm(form({ provider: 'greenhouse' }), '#1 X', 'https://example.com');
    expect(lines.some((line) => line.startsWith('Pay'))).toBe(false);
    expect(lines.some((line) => line.startsWith('Applications close'))).toBe(false);
  });

  it('shows pay and deadline when the board states them', () => {
    const lines = renderForm(
      form({ compensationSummary: '$200K – $250K', deadline: '2026-10-01' }),
      '#1 X',
      'https://example.com',
    );
    expect(lines).toContain('Pay (as stated): $200K – $250K');
    expect(lines).toContain('Applications close: 2026-10-01');
  });

  it('bounds an absurd title in the rendered output', () => {
    const lines = renderForm(
      form({ fields: [{ title: 'x'.repeat(2000), type: 'long-text', required: true, description: null }] }),
      '#1 X',
      'https://example.com',
    );
    expect(lines.every((line) => line.length < 200)).toBe(true);
  });
});
