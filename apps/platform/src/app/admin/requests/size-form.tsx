"use client";

import { useActionState } from "react";
import { setRequestSizeAction, type SizeResult } from "./actions";

/**
 * The size of a request, as the client gave it, and the operator's way to
 * correct it (decision D7). Before payment only small changes are taken, and
 * the agent is told to hand back a "small" one that is really big — so a wrong
 * size is worth fixing before it is sent.
 */
export function SizeForm({ requestPublicId, size }: { requestPublicId: string; size: "small" | "big" | null }) {
  const [state, action, pending] = useActionState<SizeResult | null, FormData>(setRequestSizeAction, null);

  return (
    <form action={action} className="nowrap">
      <input type="hidden" name="requestPublicId" value={requestPublicId} />
      <select
        name="size"
        defaultValue={size ?? ""}
        aria-label="Request size"
        onChange={(event) => event.currentTarget.form?.requestSubmit()}
        disabled={pending}
      >
        {/* Requests from before sizes existed, or raised by an operator. */}
        {size === null && (
          <option value="" disabled>
            not sized
          </option>
        )}
        <option value="small">small</option>
        <option value="big">big</option>
      </select>
      {state && !state.ok && <span className="error"> {state.message}</span>}
    </form>
  );
}
