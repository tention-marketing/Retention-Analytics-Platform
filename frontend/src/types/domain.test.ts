import { describe, expect, it } from 'vitest';
import {
  FAILURE_CATEGORIES, PROVIDERS, PROVIDER_STATES, SYNC_STATES,
  type AgencyUser, type SafeFailure,
} from './domain';

// These read as tautologies in TypeScript alone, which is the point: they fail
// at COMPILE time if a field is renamed or a union member is dropped, and the
// runtime assertions below then document the exact backend vocabulary so a
// silent divergence from the API is visible in a diff.

describe('SafeFailure matches the hardened backend contract', () => {
  const failure: SafeFailure = {
    code: 'provider_unreachable',
    category: 'network',
    provider: 'klaviyo',
    stage: 'klaviyo.backfill',
    retryable: true,
    publicMessage: 'Klaviyo could not be reached. The sync will be retried.',
    occurredAt: '2026-07-29T05:35:51.936Z',
  };

  it('carries exactly the seven backend fields', () => {
    expect(Object.keys(failure).sort()).toEqual([
      'category', 'code', 'occurredAt', 'provider', 'publicMessage', 'retryable', 'stage',
    ]);
  });

  it('permits a null occurredAt, as the backend type does', () => {
    const live: SafeFailure = { ...failure, occurredAt: null };
    expect(live.occurredAt).toBeNull();
  });

  it('exposes a renderable publicMessage', () => {
    expect(failure.publicMessage).toMatch(/^[A-Z]/);
    expect(failure.publicMessage).not.toContain('at async');
    expect(failure.publicMessage).not.toContain('/Users/');
  });

  it('does not reintroduce the removed raw-text fields', () => {
    const keys = Object.keys(failure);
    expect(keys).not.toContain('failedReason');
    expect(keys).not.toContain('recentErrors');
    expect(keys).not.toContain('error');
    expect(keys).not.toContain('stack');
  });
});

describe('backend vocabularies', () => {
  it('lists the three providers', () => {
    expect([...PROVIDERS]).toEqual(['shopify', 'klaviyo', 'recharge']);
  });

  it('lists the four resolved provider states', () => {
    expect([...PROVIDER_STATES]).toEqual(['connected', 'requested', 'skipped', 'undecided']);
  });

  it('lists the ten sync states', () => {
    expect([...SYNC_STATES]).toEqual([
      'not_started', 'waiting', 'syncing', 'retrying', 'sync_delayed',
      'completed', 'connected', 'failed', 'skipped', 'requested',
    ]);
  });

  it('lists the five failure categories', () => {
    expect([...FAILURE_CATEGORIES]).toEqual(['auth', 'rate_limit', 'network', 'provider', 'internal']);
  });

  it('keeps provider state and sync state as separate vocabularies', () => {
    // Both contain 'connected' meaning different things; merging them would make
    // "credential exists" and "no sync running" indistinguishable.
    expect(PROVIDER_STATES).not.toBe(SYNC_STATES);
    expect(SYNC_STATES.length).toBeGreaterThan(PROVIDER_STATES.length);
  });
});

describe('AgencyUser', () => {
  it('is exactly { id: number, email: string }', () => {
    const user: AgencyUser = { id: 1, email: 'staff@agency.test' };
    expect(Object.keys(user)).toEqual(['id', 'email']);
    expect(typeof user.id).toBe('number');
    expect(typeof user.email).toBe('string');
  });

  it('carries no role, permission, account, token or session field', () => {
    const user: AgencyUser = { id: 1, email: 'staff@agency.test' };
    const keys = Object.keys(user);
    for (const forbidden of [
      'role', 'roles', 'permissions', 'accountIds', 'organization',
      'accessToken', 'refreshToken', 'sessionId', 'cookie', 'password',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
