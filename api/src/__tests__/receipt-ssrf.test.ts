import {
  isPrivateOrReservedIp,
  assertSafeRemoteImageUrl,
  defaultReceiptAllowedHosts,
} from '../utils/ssrf';

// Real dns module object — jest.spyOn replaces its `lookup` in place so the
// production code (which calls dns.promises.lookup at request time) sees it.
const dnsPromises = require('dns').promises as { lookup: (...args: any[]) => any };

describe('isPrivateOrReservedIp', () => {
  it('returns true for private / reserved / loopback / link-local addresses', () => {
    const unsafe = [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
      'fc00::1',
      '::ffff:192.168.0.1',
    ];
    for (const ip of unsafe) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('returns false for public addresses', () => {
    const safe = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111'];
    for (const ip of safe) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });

  it('fails closed for non-IP input', () => {
    expect(isPrivateOrReservedIp('not-an-ip')).toBe(true);
    expect(isPrivateOrReservedIp('')).toBe(true);
  });
});

describe('assertSafeRemoteImageUrl', () => {
  let lookupSpy: jest.SpyInstance;

  beforeEach(() => {
    // Default: no addresses, and no real network. Individual tests override.
    lookupSpy = jest.spyOn(dnsPromises, 'lookup').mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects empty and malformed input', async () => {
    expect((await assertSafeRemoteImageUrl('')).ok).toBe(false);
    expect((await assertSafeRemoteImageUrl(null)).ok).toBe(false);
    expect((await assertSafeRemoteImageUrl(undefined)).ok).toBe(false);
    expect((await assertSafeRemoteImageUrl('not a url')).ok).toBe(false);
  });

  it('rejects a non-https URL', async () => {
    const r = await assertSafeRemoteImageUrl('http://cdn.example.com/logo.png');
    expect(r.ok).toBe(false);
  });

  it('rejects an https URL containing embedded credentials', async () => {
    const r = await assertSafeRemoteImageUrl('https://user:secret@cdn.example.com/logo.png');
    expect(r.ok).toBe(false);
  });

  it('rejects https://localhost', async () => {
    const r = await assertSafeRemoteImageUrl('https://localhost/x.png');
    expect(r.ok).toBe(false);
  });

  it('rejects cloud metadata hostnames', async () => {
    const r = await assertSafeRemoteImageUrl('https://metadata.google.internal/x');
    expect(r.ok).toBe(false);
  });

  it('rejects a public hostname that DNS resolves to a private IP', async () => {
    lookupSpy.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const r = await assertSafeRemoteImageUrl('https://rebind.example/logo.png');
    expect(r.ok).toBe(false);
    expect(lookupSpy).toHaveBeenCalled();
  });

  it('accepts an https URL whose DNS resolves only to a public IP', async () => {
    lookupSpy.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    const r = await assertSafeRemoteImageUrl('https://cdn.example.com/logo.png');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe('https://cdn.example.com/logo.png');
  });

  it('does not follow redirects blindly on this side — the validation is per-URL only', async () => {
    // Sanity: a redirect target is only safe if IT passes this same check too.
    lookupSpy.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const r = await assertSafeRemoteImageUrl('https://redirect-target.example/logo.png');
    expect(r.ok).toBe(false);
  });

  describe('allow-list behaviour', () => {
    it('accepts an allow-listed host without any DNS lookup', async () => {
      const r = await assertSafeRemoteImageUrl('https://cdn.bellsuniversity.edu.ng/logo.png', {
        allowedHosts: ['cdn.bellsuniversity.edu.ng'],
      });
      expect(r.ok).toBe(true);
      expect(lookupSpy).not.toHaveBeenCalled();
    });

    it('rejects a host that is not in the allow-list without a DNS lookup', async () => {
      const r = await assertSafeRemoteImageUrl('https://evil.example/logo.png', {
        allowedHosts: ['cdn.bellsuniversity.edu.ng'],
      });
      expect(r.ok).toBe(false);
      expect(lookupSpy).not.toHaveBeenCalled();
    });

    it('matches allow-list entries case-insensitively', async () => {
      const r = await assertSafeRemoteImageUrl('https://CDN.BellsUniversity.edu.ng/logo.png', {
        allowedHosts: ['cdn.bellsuniversity.edu.ng'],
      });
      expect(r.ok).toBe(true);
      expect(lookupSpy).not.toHaveBeenCalled();
    });
  });
});

describe('defaultReceiptAllowedHosts', () => {
  const KEY = 'RECEIPT_ASSET_ALLOWED_HOSTS';
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('parses, trims, lowercases and strips schemes/ports/paths', () => {
    process.env[KEY] = ' https://CDN.example.com/path , logo.example.com:8443 ,, ';
    expect(defaultReceiptAllowedHosts()).toEqual(['cdn.example.com', 'logo.example.com']);
  });

  it('returns an empty list when unset', () => {
    delete process.env[KEY];
    expect(defaultReceiptAllowedHosts()).toEqual([]);
  });
});
