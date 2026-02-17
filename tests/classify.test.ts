import { describe, it, expect } from 'vitest';
import {
  classifyDecay,
  calculateExpiry,
  extractStructuredFields,
  shouldCapture,
  detectCategory,
} from '../index.js';
import { TTL_DEFAULTS } from '../config.js';
import type { MemoryCategory } from '../config.js';

// ============================================================================
// classifyDecay
// ============================================================================

describe('classifyDecay', () => {
  it('classifies permanent keys', () => {
    expect(classifyDecay(null, 'email', 'test@test.com', '')).toBe('permanent');
    expect(classifyDecay(null, 'name', 'Fred', '')).toBe('permanent');
    expect(classifyDecay(null, 'birthday', 'Nov 13', '')).toBe('permanent');
    expect(classifyDecay(null, 'api_key', 'sk-123', '')).toBe('permanent');
    expect(classifyDecay(null, 'architecture', 'monolith', '')).toBe('permanent');
    expect(classifyDecay(null, 'phone', '+33612345678', '')).toBe('permanent');
    expect(classifyDecay(null, 'language', 'TypeScript', '')).toBe('permanent');
    expect(classifyDecay(null, 'location', 'Paris', '')).toBe('permanent');
  });

  it('classifies permanent by text content', () => {
    expect(classifyDecay(null, null, null, 'We decided to use Redis')).toBe('permanent');
    expect(classifyDecay(null, null, null, 'The architecture is microservices')).toBe('permanent');
    expect(classifyDecay(null, null, null, 'Always use strict mode')).toBe('permanent');
    expect(classifyDecay(null, null, null, 'Never use eval')).toBe('permanent');
  });

  it('classifies permanent by entity', () => {
    expect(classifyDecay('decision', null, null, 'some text')).toBe('permanent');
    expect(classifyDecay('convention', null, null, 'some text')).toBe('permanent');
  });

  it('classifies session keys', () => {
    expect(classifyDecay(null, 'current_file', 'index.ts', '')).toBe('session');
    expect(classifyDecay(null, 'temp', 'value', '')).toBe('session');
    expect(classifyDecay(null, 'debug', 'true', '')).toBe('session');
    expect(classifyDecay(null, 'working_on_right_now', 'feature', '')).toBe('session');
  });

  it('classifies session by text content', () => {
    expect(classifyDecay(null, null, null, 'Currently debugging the auth flow')).toBe('session');
    expect(classifyDecay(null, null, null, 'I am doing something right now')).toBe('session');
    expect(classifyDecay(null, null, null, 'Only for this session')).toBe('session');
  });

  it('classifies active keys', () => {
    expect(classifyDecay(null, 'task', 'fix bug', '')).toBe('active');
    expect(classifyDecay(null, 'todo', 'deploy', '')).toBe('active');
    expect(classifyDecay(null, 'wip', 'feature', '')).toBe('active');
    expect(classifyDecay(null, 'branch', 'main', '')).toBe('active');
    expect(classifyDecay(null, 'sprint', '14', '')).toBe('active');
    expect(classifyDecay(null, 'blocker', 'API down', '')).toBe('active');
  });

  it('classifies active by text content', () => {
    expect(classifyDecay(null, null, null, 'Working on the auth module')).toBe('active');
    expect(classifyDecay(null, null, null, 'Need to fix the bug')).toBe('active');
    expect(classifyDecay(null, null, null, 'TODO: update the docs')).toBe('active');
  });

  it('classifies checkpoint keys', () => {
    expect(classifyDecay(null, 'checkpoint:123', '', '')).toBe('checkpoint');
    expect(classifyDecay(null, 'preflight_check', '', '')).toBe('checkpoint');
  });

  it('defaults to stable', () => {
    expect(classifyDecay(null, null, null, 'Some random fact')).toBe('stable');
    expect(classifyDecay('user', 'color', 'blue', 'I like blue')).toBe('stable');
  });
});

// ============================================================================
// calculateExpiry
// ============================================================================

describe('calculateExpiry', () => {
  const now = 1700000000;

  it('returns null for permanent', () => {
    expect(calculateExpiry('permanent', now)).toBeNull();
  });

  it('returns correct TTLs', () => {
    expect(calculateExpiry('stable', now)).toBe(now + TTL_DEFAULTS.stable!);
    expect(calculateExpiry('active', now)).toBe(now + TTL_DEFAULTS.active!);
    expect(calculateExpiry('session', now)).toBe(now + TTL_DEFAULTS.session!);
    expect(calculateExpiry('checkpoint', now)).toBe(now + TTL_DEFAULTS.checkpoint!);
  });
});

// ============================================================================
// detectCategory
// ============================================================================

describe('detectCategory', () => {
  it('detects decisions (EN)', () => {
    expect(detectCategory('We decided to use Redis')).toBe('decision');
    expect(detectCategory('Chose PostgreSQL over MySQL')).toBe('decision');
    expect(detectCategory('Always use strict mode')).toBe('decision');
    expect(detectCategory('Never use eval in production')).toBe('decision');
  });

  it('detects decisions (FR)', () => {
    expect(detectCategory('On a décidé de prendre Redis')).toBe('decision');
    expect(detectCategory('On a choisi PostgreSQL')).toBe('decision');
    expect(detectCategory('Toujours utiliser le mode strict')).toBe('decision');
  });

  it('detects preferences', () => {
    expect(detectCategory('I prefer dark mode')).toBe('preference');
    expect(detectCategory('I like TypeScript')).toBe('preference');
    expect(detectCategory('I hate Python indentation')).toBe('preference');
    expect(detectCategory('Je préfère le mode sombre')).toBe('preference');
  });

  it('detects entities', () => {
    expect(detectCategory("Contact John at john@example.com")).toBe('entity');
    expect(detectCategory('Call me at +33612345678')).toBe('entity');
  });

  it('detects facts', () => {
    expect(detectCategory('Born on November 13')).toBe('fact');
    expect(detectCategory('He lives in Paris')).toBe('fact');
    expect(detectCategory('She works at Google')).toBe('fact');
  });

  it('falls back to other', () => {
    expect(detectCategory('Some random statement about code')).toBe('other');
  });
});

// ============================================================================
// shouldCapture
// ============================================================================

describe('shouldCapture', () => {
  it('captures memory triggers (EN)', () => {
    expect(shouldCapture('Remember that I prefer TypeScript')).toBe(true);
    expect(shouldCapture('I decided to use PostgreSQL for this project')).toBe(true);
    expect(shouldCapture('Always use ESLint for linting')).toBe(true);
    expect(shouldCapture('My birthday is November 13')).toBe(true);
  });

  it('captures memory triggers (FR)', () => {
    expect(shouldCapture('Retiens que je préfère le mode sombre')).toBe(true);
    expect(shouldCapture("On a décidé d'utiliser Redis pour le cache")).toBe(true);
    expect(shouldCapture("Mon email est fred@example.com")).toBe(true);
  });

  it('rejects too short messages', () => {
    expect(shouldCapture('hi')).toBe(false);
    expect(shouldCapture('ok cool')).toBe(false);
  });

  it('rejects too long messages', () => {
    expect(shouldCapture('a'.repeat(501))).toBe(false);
  });

  it('rejects sensitive content', () => {
    expect(shouldCapture('My password is hunter2, remember it')).toBe(false);
    expect(shouldCapture('The api key is sk-12345678901234')).toBe(false);
    expect(shouldCapture('Save this secret token somewhere safe')).toBe(false);
  });

  it('rejects markup content', () => {
    expect(shouldCapture('<relevant-memories>some data</relevant-memories>')).toBe(false);
    expect(shouldCapture('<div>Remember this HTML</div>')).toBe(false);
  });

  it('rejects emoji-heavy content', () => {
    expect(shouldCapture('Remember 🎉🎊🎈🎁 this party')).toBe(false);
  });

  it('rejects non-trigger content', () => {
    expect(shouldCapture('Can you help me with this function?')).toBe(false);
    expect(shouldCapture('Please refactor the module for me')).toBe(false);
  });
});

// ============================================================================
// extractStructuredFields
// ============================================================================

describe('extractStructuredFields', () => {
  describe('EN patterns', () => {
    it('extracts decisions', () => {
      const result = extractStructuredFields(
        'decided to use Redis because of performance',
        'decision',
      );
      expect(result.entity).toBe('decision');
      expect(result.key).toContain('Redis');
      expect(result.value).toContain('performance');
    });

    it('extracts decisions without rationale', () => {
      const result = extractStructuredFields('decided to use PostgreSQL', 'decision');
      expect(result.entity).toBe('decision');
      expect(result.key).toContain('PostgreSQL');
      expect(result.value).toBe('no rationale recorded');
    });

    it('extracts choices with comparisons', () => {
      const result = extractStructuredFields(
        'use Redis over Memcached because of persistence',
        'decision',
      );
      expect(result.entity).toBe('decision');
      expect(result.key).toContain('Redis');
      expect(result.key).toContain('Memcached');
    });

    it('extracts conventions (always/never)', () => {
      const result = extractStructuredFields('always use strict mode', 'decision');
      expect(result.entity).toBe('convention');
      expect(result.value).toBe('always');

      const result2 = extractStructuredFields('never use eval in production', 'decision');
      expect(result2.entity).toBe('convention');
      expect(result2.value).toBe('never');
    });

    it('extracts possessive facts', () => {
      const result = extractStructuredFields("John's email is john@test.com", 'entity');
      expect(result.entity).toBe('John');
      expect(result.key).toBe('email');
      expect(result.value).toBe('john@test.com');
    });

    it('extracts "my" possessive facts', () => {
      const result = extractStructuredFields('My birthday is November 13', 'fact');
      expect(result.entity).toBe('user');
      expect(result.key).toBe('birthday');
      expect(result.value).toBe('November 13');
    });

    it('extracts preferences', () => {
      const result = extractStructuredFields('I prefer dark mode', 'preference');
      expect(result.entity).toBe('user');
      expect(result.key).toBe('prefer');
      expect(result.value).toBe('dark mode');
    });

    it('extracts email addresses', () => {
      const result = extractStructuredFields('Contact me at john@example.com', 'entity');
      expect(result.key).toBe('email');
      expect(result.value).toBe('john@example.com');
    });

    it('extracts phone numbers', () => {
      const result = extractStructuredFields('Call me at +33612345678', 'entity');
      expect(result.key).toBe('phone');
      expect(result.value).toBe('+33612345678');
    });
  });

  describe('FR patterns', () => {
    it('extracts decisions', () => {
      const result = extractStructuredFields(
        "on a décidé d'utiliser Redis parce que c'est rapide",
        'decision',
      );
      expect(result.entity).toBe('decision');
    });

    it('extracts conventions', () => {
      const result = extractStructuredFields('toujours utiliser ESLint', 'decision');
      expect(result.entity).toBe('convention');
      expect(result.value).toBe('always');

      const result2 = extractStructuredFields('jamais utiliser var en JavaScript', 'decision');
      expect(result2.entity).toBe('convention');
      expect(result2.value).toBe('never');
    });

    it('extracts possessive facts', () => {
      const result = extractStructuredFields('mon email est fred@test.com', 'fact');
      expect(result.entity).toBe('user');
      expect(result.key).toBe('email');
      // Note: the possessive match may or may not fire before the email regex
    });

    it('extracts preferences', () => {
      const result = extractStructuredFields('je préfère le mode sombre', 'preference');
      expect(result.entity).toBe('user');
      expect(result.key).toBe('prefer');
      expect(result.value).toContain('mode sombre');
    });
  });

  it('returns nulls for unrecognized patterns', () => {
    const result = extractStructuredFields('Some random text about code', 'other');
    expect(result.entity).toBeNull();
    expect(result.key).toBeNull();
    expect(result.value).toBeNull();
  });
});
