"use client";

import { useActionState } from "react";
import { setPortalSectionsAction, type PortalSectionsResult } from "./portal-sections-actions";
import "./portal-sections.css";

/**
 * What kind of site a client has, and the portal sections it opens.
 *
 * A booking portal gets "Set your availability"; a store gets the online
 * shop. Either, both or neither. Chosen on Add a client and changeable here
 * later. Turning one off hides the tab and closes its pages; nothing in it is
 * deleted.
 */

const SITE_KINDS = [
  {
    name: "bookingEnabled",
    label: "Booking portal",
    hint: "Opens “Set your availability”: Google Calendar, open times, approve or decline bookings.",
  },
  {
    name: "shopEnabled",
    label: "Online store",
    hint: "Opens the shop: products, Stripe, sales.",
  },
] as const;

type SiteKindName = (typeof SITE_KINDS)[number]["name"];

/** The two checkboxes. Posts `bookingEnabled` / `shopEnabled` as "on" when ticked. */
export function SiteKindFields({
  defaults,
  disabled = false,
}: {
  defaults?: Partial<Record<SiteKindName, boolean>>;
  disabled?: boolean;
}) {
  return (
    <fieldset className="site-kinds" disabled={disabled}>
      <legend>What kind of site?</legend>
      <p className="site-kinds-intro">Either, both or neither. Each opens a section in their portal.</p>
      {SITE_KINDS.map((kind) => (
        <label key={kind.name} className="checkbox">
          <input type="checkbox" name={kind.name} defaultChecked={defaults?.[kind.name] ?? false} />
          <span>
            <span className="site-kinds-name">{kind.label}</span>
            <span className="site-kinds-hint">{kind.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function PortalSectionsPanel({
  clientPublicId,
  bookingEnabled,
  shopEnabled,
  hasSite,
}: {
  clientPublicId: string;
  bookingEnabled: boolean;
  shopEnabled: boolean;
  /** The shop goes on their website; without one its page says so and waits. */
  hasSite: boolean;
}) {
  const [state, action, pending] = useActionState<PortalSectionsResult | null, FormData>(
    setPortalSectionsAction,
    null,
  );

  return (
    <section className="card" aria-labelledby="portal-sections">
      <div className="card-head">
        <h2 id="portal-sections">Portal sections</h2>
      </div>

      <ul className="portal-sections-state" aria-label="Now on in their portal">
        <li>
          <span className={`pill ${bookingEnabled ? "pill-success" : "pill-neutral"}`}>
            Availability {bookingEnabled ? "on" : "off"}
          </span>
        </li>
        <li>
          <span className={`pill ${shopEnabled ? "pill-success" : "pill-neutral"}`}>
            Shop {shopEnabled ? "on" : "off"}
          </span>
        </li>
      </ul>

      <form action={action} className="portal-sections-form">
        <input type="hidden" name="clientPublicId" value={clientPublicId} />
        {/* Keyed on the saved values so the boxes follow a save, not the last click. */}
        <SiteKindFields key={`${bookingEnabled}-${shopEnabled}`} defaults={{ bookingEnabled, shopEnabled }} />

        {shopEnabled && !hasSite && (
          <p className="field-hint" style={{ marginTop: "-0.6rem" }}>
            The shop goes on their website, and there is no site on this account yet. Their Shop tab says so until
            there is.
          </p>
        )}

        {state && (
          <p className={state.ok ? "notice notice-success" : "error"} role="status">
            {state.message}
          </p>
        )}

        <button type="submit" className="secondary" disabled={pending}>
          {pending ? "Saving…" : "Save sections"}
        </button>
        <p className="field-hint" style={{ margin: "0.75rem 0 0" }}>
          Turning a section off hides it from them. Nothing in it is deleted: products, orders and availability are
          there again if you turn it back on.
        </p>
      </form>
    </section>
  );
}
