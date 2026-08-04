import { RequestContext } from './request-context';
import { isAcceptableRequestId, resolveRequestId } from './request-id';

describe('resolveRequestId', () => {
  it('reuses a well-formed inbound identifier', () => {
    const inbound = '550e8400-e29b-41d4-a716-446655440000';

    expect(resolveRequestId(inbound)).toBe(inbound);
  });

  it('generates one when the header is absent', () => {
    const generated = resolveRequestId(undefined);

    expect(isAcceptableRequestId(generated)).toBe(true);
  });

  it('regenerates rather than rejecting a malformed identifier', () => {
    const generated = resolveRequestId('has spaces and <injection>');

    expect(generated).not.toContain(' ');
    expect(isAcceptableRequestId(generated)).toBe(true);
  });

  it('regenerates when the identifier is oversized', () => {
    const generated = resolveRequestId('a'.repeat(65));

    expect(generated).toHaveLength(36);
  });

  it('regenerates for non-string header values', () => {
    expect(isAcceptableRequestId(resolveRequestId(['a', 'b']))).toBe(true);
    expect(isAcceptableRequestId(resolveRequestId(42))).toBe(true);
  });
});

describe('RequestContext', () => {
  it('exposes the request id inside the scope', () => {
    RequestContext.run({ requestId: 'abc123' }, () => {
      expect(RequestContext.getRequestId()).toBe('abc123');
    });
  });

  it('is undefined outside any scope', () => {
    expect(RequestContext.getRequestId()).toBeUndefined();
  });

  it('survives an async call stack', async () => {
    await RequestContext.run({ requestId: 'nested' }, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));

      const deep = async (): Promise<string | undefined> => {
        await Promise.resolve();
        return RequestContext.getRequestId();
      };

      expect(await deep()).toBe('nested');
    });
  });

  it('keeps concurrent scopes isolated', async () => {
    const observe = (id: string): Promise<string | undefined> =>
      RequestContext.run({ requestId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return RequestContext.getRequestId();
      });

    await expect(
      Promise.all([observe('one'), observe('two')]),
    ).resolves.toEqual(['one', 'two']);
  });

  describe('authenticated principal', () => {
    it('is absent until the guard resolves a session', () => {
      RequestContext.run({ requestId: 'r' }, () => {
        expect(RequestContext.getUserId()).toBeUndefined();
      });
    });

    it('is readable from a nested async call stack once set', async () => {
      await RequestContext.run({ requestId: 'r' }, async () => {
        RequestContext.setUserId('user-1');

        await new Promise((resolve) => setTimeout(resolve, 1));

        const deepInAService = async (): Promise<string | undefined> => {
          await Promise.resolve();
          return RequestContext.getUserId();
        };

        expect(await deepInAService()).toBe('user-1');
      });
    });

    it('does not leak between concurrent requests', async () => {
      const handle = (id: string): Promise<string | undefined> =>
        RequestContext.run({ requestId: id }, async () => {
          RequestContext.setUserId(`user-for-${id}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          return RequestContext.getUserId();
        });

      await expect(Promise.all([handle('a'), handle('b')])).resolves.toEqual([
        'user-for-a',
        'user-for-b',
      ]);
    });

    it('is a no-op outside a request scope rather than a throw', () => {
      expect(() => {
        RequestContext.setUserId('orphan');
      }).not.toThrow();

      expect(RequestContext.getUserId()).toBeUndefined();
    });
  });
});
