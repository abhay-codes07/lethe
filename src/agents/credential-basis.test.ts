import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyCredentialBasis, scoutFromEnv } from './credential-basis.ts';
import { scoutAgent } from './scout.ts';
import { assertReadOnly } from './spec.ts';

describe('applyCredentialBasis', () => {
  it('applies the basis, with its evidence, to the covered connector', () => {
    const spec = applyCredentialBasis(scoutAgent, ['acme-postgres']);
    const binding = spec.mcpServers.find((b) => b.name === 'acme-postgres');

    assert.equal(binding?.readOnlyBasis?.kind, 'credential');
    assert.match(
      binding?.readOnlyBasis?.kind === 'credential' ? binding.readOnlyBasis.evidence : '',
      /lethe_ro/,
    );
    // The rest of the fleet is untouched.
    assert.equal(spec.mcpServers.find((b) => b.name === 'acme-s3')?.readOnlyBasis, undefined);
    assert.doesNotThrow(() => assertReadOnly(spec));
  });

  // Qodo's catch: the first version stamped the Postgres role's evidence onto
  // whatever connector the environment named. A basis whose evidence does not
  // reach its subject is not a basis.
  it('refuses a connector the evidence does not cover', () => {
    assert.throws(
      () => applyCredentialBasis(scoutAgent, ['acme-stripe']),
      /no read-only credential evidence exists for: acme-stripe/,
    );
  });

  it('refuses a mixed list if any name is uncovered', () => {
    assert.throws(
      () => applyCredentialBasis(scoutAgent, ['acme-postgres', 'acme-vectors']),
      /acme-vectors/,
    );
  });
});

describe('scoutFromEnv', () => {
  it('applies scoping then basis from the environment', () => {
    const spec = scoutFromEnv(scoutAgent, {
      LETHE_SYSTEMS: 'acme-postgres',
      LETHE_CREDENTIAL_READONLY: 'acme-postgres',
    } as NodeJS.ProcessEnv);

    assert.equal(spec.mcpServers.length, 1);
    assert.equal(spec.mcpServers[0]?.readOnlyBasis?.kind, 'credential');
  });

  it('is the unmodified scout when the environment says nothing', () => {
    assert.deepEqual(scoutFromEnv(scoutAgent, {} as NodeJS.ProcessEnv), scoutAgent);
  });
});

describe('withModelFromEnv', () => {
  it('swaps the model when the environment names one', async () => {
    const { withModelFromEnv } = await import('./credential-basis.ts');
    const spec = withModelFromEnv(scoutAgent, { LETHE_MODEL: 'openai/gpt-4o' } as NodeJS.ProcessEnv);
    assert.equal(spec.model, 'openai/gpt-4o');
    // The model is the one field where swapping changes no safety property.
    assert.doesNotThrow(() => assertReadOnly(spec));
  });

  it('keeps the spec default otherwise', async () => {
    const { withModelFromEnv } = await import('./credential-basis.ts');
    assert.equal(withModelFromEnv(scoutAgent, {} as NodeJS.ProcessEnv).model, scoutAgent.model);
  });
});
