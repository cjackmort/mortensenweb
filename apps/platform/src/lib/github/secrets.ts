/**
 * Writing Actions secrets into a client repository.
 *
 * ## Why this exists, and why it did not before
 *
 * The original design put `CLAUDE_CODE_OAUTH_TOKEN` and `NETLIFY_AUTH_TOKEN`
 * at the account level, set once by hand and inherited by every scaffolded
 * repository. That does not work, for two compounding reasons:
 *
 *  1. The repositories live under a **personal account**, and personal accounts
 *     have no shared secrets — only per-repository ones.
 *  2. Even under a free organisation it would still fail: on GitHub Free,
 *     organisation secrets are not readable by **private** repositories, and
 *     client repositories are private by design.
 *
 * So without this module, every new client repository needs two secrets set by
 * hand before its automation can run — which is precisely the manual step the
 * platform exists to remove.
 *
 * ## Why libsodium
 *
 * GitHub requires Actions secrets to be encrypted *client-side* with
 * `crypto_box_seal` — X25519 plus XSalsa20-Poly1305, with the nonce derived by
 * BLAKE2b from the ephemeral and recipient public keys. WebCrypto implements
 * none of that combination, so unlike every other integration in this codebase
 * it cannot be hand-rolled against the platform's own crypto.
 *
 * This is the dependency deliberately avoided when `setRepoVariable` was
 * written, and the distinction still holds: a Netlify **site id** is not
 * confidential and belongs in a plaintext variable. These two values are real
 * credentials, so they need the real thing.
 *
 * ## The blast radius, stated plainly
 *
 * A leaked `CLAUDE_CODE_OAUTH_TOKEN` bills against the operator's Claude
 * subscription. A leaked `NETLIFY_AUTH_TOKEN` can publish to every site on the
 * account. Both are written once at scaffold time and never read back — GitHub
 * has no API to retrieve a secret's value, which is a feature here.
 */

import { githubRequest } from "./app";
import type { Repo } from "./rest";

/**
 * The repository's public key for sealing secrets.
 *
 * Fetched per repository rather than cached: keys are per-repository, and a
 * cache keyed wrongly would seal a secret to the wrong recipient — producing a
 * value GitHub accepts and Actions can never decrypt, which surfaces much later
 * as a workflow failing on an empty variable.
 */
interface PublicKey {
  key_id: string;
  key: string;
}

async function repoPublicKey(repo: Repo): Promise<PublicKey> {
  const { data } = await githubRequest<PublicKey>(
    repo.installationId,
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/actions/secrets/public-key`,
  );
  return data;
}

/**
 * Seal a value to a repository's public key.
 *
 * Loaded through a dynamic import so the WASM module is pulled in only when a
 * repository is actually being scaffolded — the same treatment PGlite gets in
 * `db/client.ts`, and for the same reason: this is a rare administrative path
 * and every request-time bundle is better off without it.
 */
async function sealValue(value: string, publicKeyBase64: string): Promise<string> {
  const sodium = (await import("libsodium-wrappers")).default;
  await sodium.ready;

  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL),
  );

  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

/**
 * Create or update one Actions secret.
 *
 * `PUT` is an upsert on this endpoint, so re-scaffolding or repairing a
 * repository is safe to repeat. GitHub answers 201 on create and 204 on
 * update; both mean it worked.
 */
export async function setRepoSecret(
  repo: Repo,
  name: string,
  value: string,
): Promise<void> {
  const publicKey = await repoPublicKey(repo);
  const encrypted = await sealValue(value, publicKey.key);

  await githubRequest(
    repo.installationId,
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/actions/secrets/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      body: { encrypted_value: encrypted, key_id: publicKey.key_id },
      allowStatuses: [201, 204],
    },
  );
}

export interface ProvisionResult {
  written: string[];
  /** Names whose source environment variable was not set. */
  missing: string[];
  /** Names that failed to write, with the reason. Never contains a value. */
  failed: { name: string; reason: string }[];
}

/**
 * The secrets a scaffolded repository needs to run its own workflows.
 *
 * Sourced from the portal's environment, which is the only place they are held.
 * A missing one is reported rather than thrown: a repository with no Netlify
 * token still builds and can be fixed later, and failing the whole scaffold
 * over it would leave a half-created repository nobody owns.
 */
const REQUIRED_SECRETS: { name: string; env: string; purpose: string }[] = [
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    env: "CLAUDE_CODE_OAUTH_TOKEN",
    purpose: "runs the agent against the operator's Claude subscription",
  },
  {
    name: "NETLIFY_AUTH_TOKEN",
    env: "NETLIFY_AUTH_TOKEN",
    purpose: "lets the repository deploy itself",
  },
];

export async function provisionRepoSecrets(repo: Repo): Promise<ProvisionResult> {
  const result: ProvisionResult = { written: [], missing: [], failed: [] };

  for (const secret of REQUIRED_SECRETS) {
    const value = process.env[secret.env];
    if (!value) {
      result.missing.push(secret.name);
      continue;
    }

    try {
      await setRepoSecret(repo, secret.name, value);
      result.written.push(secret.name);
    } catch (error) {
      // The message may name the repository and the endpoint; it never
      // contains the value, because the value was sealed before it was sent.
      result.failed.push({
        name: secret.name,
        reason: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return result;
}

/**
 * Operator-facing explanation of an incomplete provisioning run.
 *
 * Returns null when everything landed, so the caller can treat "nothing to say"
 * as the common case rather than parsing a success string.
 */
export function describeProvisioning(result: ProvisionResult): string | null {
  const parts: string[] = [];

  if (result.missing.length > 0) {
    parts.push(
      `not set in this environment: ${result.missing.join(", ")}`,
    );
  }
  if (result.failed.length > 0) {
    parts.push(
      `could not be written: ${result.failed.map((f) => f.name).join(", ")}`,
    );
  }

  if (parts.length === 0) return null;

  return `The repository was created, but its automation secrets are incomplete — ${parts.join("; ")}. Until they are set, the agent workflow and the deploy workflow will fail.`;
}
