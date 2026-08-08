/**
 * Identity from Authelia's forward-auth headers.
 *
 * Melody has no login of its own. Caddy's (authelia) snippet gates the
 * subdomain and forwards Remote-User/Remote-Groups; this module turns those
 * into a user, and refuses to do so for any request that didn't come through
 * the proxy.
 *
 * Everything here is a pure function so it can be tested without a server, a
 * database or a network. The tests below the fold are the security boundary.
 */

export interface SessionUser {
	id: string;
	username: string;
	email: string | null;
	displayName: string | null;
	isAdmin: boolean;
}

export interface ForwardedAuth {
	username: string;
	email: string | null;
	displayName: string | null;
	groups: string[];
}

/** IPv6-mapped IPv4 (::ffff:10.0.0.1) is the form Node reports behind Docker. */
function normaliseIp(ip: string): string {
	const trimmed = ip.trim();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(trimmed);
	return mapped ? mapped[1] : trimmed;
}

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split('.');
	if (parts.length !== 4) return null;
	let out = 0;
	for (const p of parts) {
		const n = Number(p);
		if (!Number.isInteger(n) || n < 0 || n > 255) return null;
		out = out * 256 + n;
	}
	return out;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
	const [range, bitsRaw] = cidr.split('/');
	const bits = Number(bitsRaw);
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
	const a = ipv4ToInt(ip);
	const b = ipv4ToInt(range);
	if (a === null || b === null) return false;
	// A /0 shift by 32 is undefined in JS (it shifts by 0), so special-case it.
	const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
	return (a & mask) === (b & mask);
}

/**
 * Is this request allowed to assert an identity?
 *
 * Anything that can reach the container's port could otherwise set
 * Remote-User and become an admin, so this is the load-bearing check in the
 * whole auth path — not the header parsing below it.
 */
export function isTrustedProxy(clientIp: string, trusted: string[]): boolean {
	const ip = normaliseIp(clientIp);
	for (const entryRaw of trusted) {
		const entry = normaliseIp(entryRaw);
		if (!entry) continue;
		if (entry.includes('/')) {
			if (ipv4InCidr(ip, entry)) return true;
		} else if (entry === ip) {
			return true;
		}
	}
	return false;
}

/**
 * Read identity headers. Returns null when there is no username, which the
 * caller must treat as 401 rather than as an anonymous user.
 */
export function parseAuthHeaders(get: (name: string) => string | null): ForwardedAuth | null {
	const username = get('remote-user')?.trim();
	if (!username) return null;

	const groupsRaw = get('remote-groups') ?? '';
	return {
		username,
		email: get('remote-email')?.trim() || null,
		displayName: get('remote-name')?.trim() || null,
		groups: groupsRaw
			.split(',')
			.map((g) => g.trim())
			.filter(Boolean)
	};
}

export function isAdminFromGroups(groups: string[], adminGroup: string): boolean {
	return groups.includes(adminGroup);
}

/** Comma-separated env value to a list, with a loopback-only fallback. */
export function parseTrustedProxies(raw: string | undefined): string[] {
	const list = (raw ?? '127.0.0.1,::1')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	return list.length ? list : ['127.0.0.1', '::1'];
}
