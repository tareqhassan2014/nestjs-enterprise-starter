import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ApiException } from '@common/errors/api-exception';

import { LocalStorageAdapter } from './local-storage.adapter';

describe('LocalStorageAdapter', () => {
  let root: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'storage-test-'));
    adapter = new LocalStorageAdapter(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a put/get', async () => {
    await adapter.put('orgs/org-1/note.txt', Buffer.from('hello'));
    const read = await adapter.get('orgs/org-1/note.txt');
    expect(read.toString('utf8')).toBe('hello');
  });

  it('creates nested directories on put', async () => {
    await adapter.put('a/b/c/file.bin', Buffer.from([1, 2, 3]));
    const read = await adapter.get('a/b/c/file.bin');
    expect([...read]).toEqual([1, 2, 3]);
  });

  it('deletes an object', async () => {
    await adapter.put('to-delete.txt', Buffer.from('bye'));
    await adapter.delete('to-delete.txt');

    await expect(adapter.get('to-delete.txt')).rejects.toBeInstanceOf(
      ApiException,
    );
  });

  it('deleting a missing key is a no-op', async () => {
    await expect(adapter.delete('never-existed.txt')).resolves.toBeUndefined();
  });

  it('raises NOT_FOUND for a missing key', async () => {
    await expect(adapter.get('missing.txt')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects keys that escape the storage root', async () => {
    await expect(
      adapter.put('../escape.txt', Buffer.from('nope')),
    ).rejects.toBeInstanceOf(ApiException);
  });

  it('rejects an empty key', async () => {
    await expect(adapter.get('')).rejects.toBeInstanceOf(ApiException);
  });
});
