import { CredentialsSignin } from "next-auth";

/**
 * A removed client's sign-in is closed. This is the wording, and the one
 * failure `authorize` tells apart from "we could not sign you in".
 *
 * Auth.js turns a plain `null` from `authorize` into a generic CredentialsSignin
 * and the sign-in pages show one message for all of those, deliberately, so
 * sign-in cannot enumerate accounts. A closed account is the exception because
 * it is only reported after the password has verified — to someone who holds
 * the account, who needs to be told to call rather than retry.
 *
 * Throwing a CredentialsSignin subclass from `authorize` is Auth.js's own route
 * for this: in a server action it is thrown to the caller with `code` intact
 * instead of being flattened into a redirect.
 */
export const ACCOUNT_CLOSED_MESSAGE = "This account is closed. Contact Mortensen Web Co.";

export const ACCOUNT_CLOSED_CODE = "account_closed";

export class AccountClosedError extends CredentialsSignin {
  override code = ACCOUNT_CLOSED_CODE;
}

/** True for the error `authorize` throws when the account is closed. */
export function isAccountClosedError(error: unknown): boolean {
  return (
    error instanceof CredentialsSignin &&
    (error as { code?: unknown }).code === ACCOUNT_CLOSED_CODE
  );
}
