import { describe, it, expect } from 'vitest';
import { extractJson } from './cliClient.js';

describe('extractJson', () => {
  it('returns a clean object unchanged', () => {
    const s = '{"tier":"cheap","confidence":0.9}';
    expect(JSON.parse(extractJson(s))).toEqual({ tier: 'cheap', confidence: 0.9 });
  });

  it('strips surrounding prose', () => {
    const s = 'Sure! Here is the result:\n{"tier":"mid"}\nHope that helps.';
    expect(JSON.parse(extractJson(s))).toEqual({ tier: 'mid' });
  });

  it('prefers a fenced json block', () => {
    const s = '```json\n{"tier":"top","reason":"hard"}\n```';
    expect(JSON.parse(extractJson(s))).toEqual({ tier: 'top', reason: 'hard' });
  });

  it('skips a stray brace in prose before the real object', () => {
    // a "{" that does not begin valid JSON must not derail extraction
    const s = 'Note: use {curly} braces. Answer: {"tier":"cheap"}';
    expect(JSON.parse(extractJson(s))).toEqual({ tier: 'cheap' });
  });

  it('handles braces inside string values', () => {
    const s = '{"reason":"it has a } brace and a { brace"}';
    expect(JSON.parse(extractJson(s))).toEqual({ reason: 'it has a } brace and a { brace' });
  });

  it('returns original text when nothing parses', () => {
    const s = 'no json here at all';
    expect(extractJson(s)).toBe(s);
  });
});
