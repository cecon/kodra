import { describe, expect, it } from 'vitest';
import { makeHandlerTestKit } from '../helpers/make-handlers.js';

describe('composer:draft', () => {
  it('returns the drafted issue from the injected drafter', async () => {
    const { handlers } = makeHandlerTestKit();
    const result = await handlers['composer:draft']({
      description: 'add an audit trail',
    });
    expect(result.title).toMatch(/drafted/i);
    expect(result.body).toContain('add an audit trail');
  });

  it('rejects empty descriptions via validation', async () => {
    const { handlers } = makeHandlerTestKit();
    await expect(handlers['composer:draft']({ description: '' })).rejects.toMatchObject({
      name: 'ValidationError',
    });
  });
});

describe('composer:assist', () => {
  it('forwards the mode and both fields to the field assistant', async () => {
    const seen: unknown[] = [];
    const { handlers } = makeHandlerTestKit(
      {},
      {
        assistField: async (input) => {
          seen.push(input);
          return { title: 'Add audit trail', body: input.description };
        },
      },
    );
    const result = await handlers['composer:assist']({
      mode: 'suggest-title',
      title: '',
      description: 'log who changed what',
    });
    expect(result.title).toBe('Add audit trail');
    expect(seen).toEqual([
      { mode: 'suggest-title', title: '', description: 'log who changed what' },
    ]);
  });

  it('refuses when both fields are empty', async () => {
    const { handlers } = makeHandlerTestKit(
      {},
      { assistField: async () => ({ title: 'x', body: '' }) },
    );
    await expect(
      handlers['composer:assist']({ mode: 'improve-description', title: ' ', description: '' }),
    ).rejects.toThrow(/title or a description/);
  });

  it('is a bad request when the runtime has no field assistant', async () => {
    const { handlers } = makeHandlerTestKit();
    await expect(
      handlers['composer:assist']({ mode: 'improve-description', title: '', description: 'x' }),
    ).rejects.toThrow(/not available/);
  });
});
