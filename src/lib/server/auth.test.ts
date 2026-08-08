import { describe, it, expect } from 'vitest';
import {
	isTrustedProxy,
	parseAuthHeaders,
	isAdminFromGroups,
	parseTrustedProxies
} from './auth.js';

/**
 * This is the security boundary of the whole application: everything else
 * assumes locals.user is real. Test it accordingly — the failure mode of a bug
 * here is silent privilege escalation, not a broken page.
 */

const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()] ?? null;

describe('isTrustedProxy', () => {
	it('matches an exact IP', () => {
		expect(isTrustedProxy('172.18.0.5', ['172.18.0.5'])).toBe(true);
		expect(isTrustedProxy('172.18.0.6', ['172.18.0.5'])).toBe(false);
	});

	it('matches inside an IPv4 CIDR and rejects outside it', () => {
		expect(isTrustedProxy('172.18.0.5', ['172.18.0.0/16'])).toBe(true);
		expect(isTrustedProxy('172.18.255.254', ['172.18.0.0/16'])).toBe(true);
		expect(isTrustedProxy('172.19.0.1', ['172.18.0.0/16'])).toBe(false);
		expect(isTrustedProxy('10.0.0.1', ['172.18.0.0/16'])).toBe(false);
	});

	it('normalises IPv6-mapped IPv4, which is what Docker actually reports', () => {
		expect(isTrustedProxy('::ffff:172.18.0.5', ['172.18.0.0/16'])).toBe(true);
		expect(isTrustedProxy('172.18.0.5', ['::ffff:172.18.0.5'])).toBe(true);
	});

	it('handles loopback in both families', () => {
		expect(isTrustedProxy('127.0.0.1', ['127.0.0.1', '::1'])).toBe(true);
		expect(isTrustedProxy('::1', ['127.0.0.1', '::1'])).toBe(true);
	});

	it('rejects everything when the trusted list is empty', () => {
		expect(isTrustedProxy('127.0.0.1', [])).toBe(false);
	});

	it('rejects a malformed CIDR rather than matching it', () => {
		expect(isTrustedProxy('10.0.0.1', ['10.0.0.0/99'])).toBe(false);
		expect(isTrustedProxy('10.0.0.1', ['10.0.0.0/abc'])).toBe(false);
		expect(isTrustedProxy('10.0.0.1', ['not-an-ip'])).toBe(false);
	});

	it('does not treat a /0 as a shift bug that matches nothing', () => {
		expect(isTrustedProxy('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
	});

	it('ignores blank entries from a trailing comma', () => {
		expect(isTrustedProxy('127.0.0.1', ['127.0.0.1', '', '  '])).toBe(true);
	});
});

describe('parseAuthHeaders', () => {
	it('returns null without a username, so the caller must 401', () => {
		expect(parseAuthHeaders(headers({}))).toBeNull();
		expect(parseAuthHeaders(headers({ 'remote-groups': 'melody-admins' }))).toBeNull();
		expect(parseAuthHeaders(headers({ 'remote-user': '   ' }))).toBeNull();
	});

	it('reads the full identity set', () => {
		const auth = parseAuthHeaders(
			headers({
				'remote-user': 'andrew',
				'remote-email': 'andrew@example.com',
				'remote-name': 'Andrew',
				'remote-groups': 'melody-users,melody-admins'
			})
		);
		expect(auth).toEqual({
			username: 'andrew',
			email: 'andrew@example.com',
			displayName: 'Andrew',
			groups: ['melody-users', 'melody-admins']
		});
	});

	it('copes with a username but no other headers', () => {
		const auth = parseAuthHeaders(headers({ 'remote-user': 'andrew' }));
		expect(auth).toEqual({ username: 'andrew', email: null, displayName: null, groups: [] });
	});

	it('trims whitespace around group names', () => {
		const auth = parseAuthHeaders(
			headers({ 'remote-user': 'a', 'remote-groups': ' one , two ,, three ' })
		);
		expect(auth!.groups).toEqual(['one', 'two', 'three']);
	});
});

describe('isAdminFromGroups', () => {
	it('grants only on an exact group name', () => {
		expect(isAdminFromGroups(['melody-admins'], 'melody-admins')).toBe(true);
		expect(isAdminFromGroups(['melody-users'], 'melody-admins')).toBe(false);
		// Substring matches must not count, or "melody-admins-readonly" would
		// silently become an admin.
		expect(isAdminFromGroups(['melody-admins-readonly'], 'melody-admins')).toBe(false);
		expect(isAdminFromGroups([], 'melody-admins')).toBe(false);
	});
});

describe('parseTrustedProxies', () => {
	it('falls back to loopback only when unset or blank', () => {
		expect(parseTrustedProxies(undefined)).toEqual(['127.0.0.1', '::1']);
		expect(parseTrustedProxies('')).toEqual(['127.0.0.1', '::1']);
		expect(parseTrustedProxies('  ,  ')).toEqual(['127.0.0.1', '::1']);
	});

	it('splits and trims a real value', () => {
		expect(parseTrustedProxies('172.18.0.0/16, 10.0.0.1')).toEqual(['172.18.0.0/16', '10.0.0.1']);
	});
});
